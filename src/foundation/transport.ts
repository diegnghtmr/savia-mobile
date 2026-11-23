import { fetch as expoFetch } from "expo/fetch";
import { readAgentEvents } from "./agent-events";
import { readApiOrigin } from "./config";
import { workspaceUnavailable } from "./identity-draft";
import { sessionStore, type SessionCredentials } from "./session-store";
import { readProfileId, readWorkspaceContext, uuid, type WorkspaceContext } from "./workspace-context";

const timeoutDefault = 10_000;

// React Native's local URI handlers produce a Blob without a file copy or an API session.
// Keep the generic request primitive at the transport boundary and reject every remote scheme.
export async function readLocalBlob(uri: string): Promise<Blob> {
  if (!/^(?:file:\/\/\/[^/]|content:\/\/[a-z\d._-]+\/)[^\u0000-\u0020\\]*$/i.test(uri)) throw new Error("Invalid picker URI");
  return new Promise<Blob>((resolve, reject) => {
    const local = new XMLHttpRequest();
    const failed = () => reject(new Error("Could not read picker file"));
    local.open("GET", uri);
    local.withCredentials = false;
    local.timeout = timeoutDefault;
    local.responseType = "blob";
    local.onload = () => {
      // Android's local Blob URI handler can complete without an HTTP-style status.
      if ((local.status === 0 || local.status === 200) && local.response instanceof Blob) resolve(local.response);
      else failed();
    };
    local.onerror = local.onabort = local.ontimeout = failed;
    local.send();
  });
}
type Send = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "ok" | "headers" | "redirected" | "json"> & Partial<Pick<Response, "body">>>;
type RequestInput = { method?: string; body?: unknown; multipart?: FormData; idempotencyKey?: string; successStatus?: number | readonly number[]; agentEvents?: true };
type WorkspaceOptions = {
  ifMatch?: string;
  includeETag?: boolean;
  onlineOnly?: true;
  expectedProfile?: string;
  subjectResource?: true;
  form?: object;
  onMembership?: (context: WorkspaceContext) => Promise<void>;
  submit?: (profileId: string, operation: (key: string, dispatch?: { body: unknown }) => Promise<unknown>, serverDate: number | null) => Promise<unknown>;
};
export type SaviaRequest = (path: string, input?: RequestInput) => Promise<unknown>;
export type WithSession = <T>(operation: (request: SaviaRequest) => Promise<T>) => Promise<T>;

export class TransportError extends Error {
  constructor(readonly kind: "http" | "network" | "redirect" | "timeout" | "protocol", readonly status?: number, readonly code?: string, readonly problemType?: string) {
    super("Savia API request failed");
    this.name = "TransportError";
  }
  toJSON() { return { kind: this.kind, status: this.status, code: this.code, problemType: this.problemType, message: this.message }; }
}

export const isOfflineFailure = (error: unknown) => error instanceof TransportError && (error.kind === "network" || error.kind === "timeout");
export const isStrongETag = (value: unknown): value is string => typeof value === "string" && value.endsWith('"') && /^"[\x21\x23-\x7e]{0,128}"$/.test(value);

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal | null): Promise<T> {
  if (parent?.aborted) throw new TransportError("network");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => { reject(new TransportError("network")); controller.abort(); };
    parent?.addEventListener("abort", cancel);
    timer = setTimeout(() => { reject(new TransportError("timeout")); controller.abort(); }, ms);
  });
  try { return await Promise.race([deadline, operation(controller.signal)]); }
  catch (error) { throw error instanceof TransportError ? error : new TransportError("network"); }
  finally { clearTimeout(timer); if (cancel) parent?.removeEventListener("abort", cancel); }
}

function safePath(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\s\\#\x00-\x1f]/.test(path)) throw new TypeError("Invalid Savia API path");
}
// These contract routes do not take a workspace header, but still verify the active workspace before dispatch.
const subjectRoute = /^\/v1\/(?:notifications(?:\?|$)|notifications\/[a-f\d-]{36}\/read$|me\/(?:notification-preferences|push-devices)$)/;
function subjectAccessRoute(path: string, method = "GET") {
  if (method === "GET") return /^\/v1\/mcp\/grants(?:\?.*)?$/.test(path);
  if (method === "POST") return path === "/v1/mcp/grants" || path === "/v1/cli/device/approve";
  return method === "DELETE" && /^\/v1\/mcp\/grants\/[a-f\d-]{36}$/.test(path);
}
function workspaceRosterRoute(path: string, id: string | null, method = "GET") {
  const prefix = `/v1/workspaces/${id}`;
  if (!id || !path.startsWith(prefix)) return false;
  const tail = path.slice(prefix.length);
  if (method === "GET") return tail === "" || /^\/(?:members|invitations)(?:\?.*)?$/.test(tail);
  if (method === "POST") return tail === "/invitations" || /^\/invitations\/[a-f\d-]{36}\/revoke$/.test(tail);
  return (method === "PATCH" || method === "DELETE") && /^\/members\/[a-f\d-]{36}$/.test(tail);
}
function rejectRedirect(response: Pick<Response, "status" | "redirected">) {
  if (response.redirected || (response.status >= 300 && response.status < 400)) throw new TransportError("redirect");
}

export function createTransport({
  baseUrl, development, timeoutMs = timeoutDefault, send = expoFetch, sessions = sessionStore,
}: {
  baseUrl?: string; development?: boolean; timeoutMs?: number;
  send?: Send; sessions?: { read(): Promise<Pick<SessionCredentials, "accessToken"> | null> };
} = {}) {
  const origin = readApiOrigin(baseUrl, development);
  async function withBearer<T>(operation: (token: string) => Promise<T>) {
    const session = await sessions.read();
    if (!session) throw new TransportError("http", 401);
    return operation(session.accessToken);
  }
  async function execute(token: string, path: string, { method = "GET", body, multipart, idempotencyKey, successStatus, agentEvents }: RequestInput = {}, workspace?: WorkspaceOptions & { id?: string }, onDate?: (date: number | null) => void) {
    safePath(path);
    if (agentEvents && (!workspace?.id || method !== "POST" || !/^\/v1\/agent\/conversations\/[a-f\d-]{36}\/messages$/.test(path))) throw new TypeError("Invalid agent stream request");
    const headers: Record<string, string> = { Accept: agentEvents ? "text/event-stream, application/problem+json" : "application/json, application/problem+json" };
    headers.Authorization = ["Bearer", token].join(" ");
    if (multipart !== undefined && (method !== "POST" || body !== undefined || !(multipart instanceof FormData))) throw new TypeError("Invalid multipart request");
    const payload = multipart ?? (body === undefined ? undefined : JSON.stringify(body));
    if (!multipart && payload !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    if (workspace) {
      if (workspace.id) headers["X-Workspace-Id"] = workspace.id;
      if (workspace.ifMatch !== undefined) headers["If-Match"] = workspace.ifMatch;
    }
    return withDeadline(async (signal) => {
      const response = await send(origin + path, { method, headers, body: payload, signal, redirect: "error", credentials: "omit" });
      rejectRedirect(response);
      if (response.ok) {
        const expected = typeof successStatus === "number" ? [successStatus] : successStatus;
        if (expected && !expected.includes(response.status)) throw new TransportError("protocol", response.status);
        if (agentEvents) return readAgentEvents(response).catch(() => { throw new TransportError("protocol", response.status); });
        const decoded: unknown = response.status === 204 && expected?.includes(204) ? undefined
          : await response.json().catch(() => { throw new TransportError("protocol", response.status); });
        if (onDate) {
          const header = response.headers.get("date");
          const time = header === null ? NaN : Date.parse(header);
          onDate(Number.isFinite(time) && new Date(time).toUTCString() === header ? time : null);
        }
        return workspace?.includeETag ? { body: decoded, etag: response.headers.get("etag") } : decoded;
      }
      const isProblem = /^application\/problem\+json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
      const problem = isProblem ? await response.json().catch(() => null) as { code?: unknown; type?: unknown } | null : null;
      const code = problem?.code, type = problem?.type;
      const safeCode = typeof code === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(code) && !code.includes(token) ? code : undefined;
      const problemType = typeof type === "string" && /^https:\/\/savia\.app\/problems\/[a-z][a-z0-9-]{0,95}$/.test(type) && !type.includes(token) ? type : undefined;
      throw new TransportError("http", response.status, safeCode, problemType);
    }, timeoutMs);
  }
  const bind = (token: string): SaviaRequest => (path, options) => execute(token, path, options);
  const withSession: WithSession = (operation) => withBearer((token) => operation(bind(token)));
  return {
    withSession,
    async request(path: string, options?: RequestInput) {
      safePath(path);
      return withSession((request) => request(path, options));
    },
    async requestInWorkspace(expected: unknown, path: string, options?: RequestInput & WorkspaceOptions) {
      safePath(path);
      const id = uuid(expected);
      if (options?.subjectResource && !subjectRoute.test(path) && !subjectAccessRoute(path, options.method) &&
        !workspaceRosterRoute(path, id, options.method)) throw new TypeError("Invalid Savia subject resource");
      if (!id) throw new Error(workspaceUnavailable);
      return withBearer(async (token) => {
        const request = bind(token);
        const profileId = await readProfileId(request);
        if (options?.expectedProfile !== undefined && options.expectedProfile !== profileId) throw new Error(workspaceUnavailable);
        let serverDate: number | null = null;
        const membership: SaviaRequest = options?.submit
          ? (page, input) => execute(token, page, input, undefined, (date) => { serverDate = date; }) : request;
        const context = await readWorkspaceContext(membership, profileId);
        await options?.onMembership?.(context);
        if (context.active?.id !== id) throw new Error(workspaceUnavailable);
        const scope = { id: options?.subjectResource ? undefined : id, ifMatch: options?.ifMatch, includeETag: options?.includeETag };
        return options?.submit
          ? options.submit(profileId, (idempotencyKey, dispatch) => execute(token, path, { ...options, ...dispatch, idempotencyKey }, scope), serverDate)
          : execute(token, path, options, scope);
      });
    },
  };
}

// The SDK supplies its own headers; the transport never adds a Savia bearer here.
export function authNetwork(origin: string): { fetch: typeof fetch } {
  return { async fetch(input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origin || !url.pathname.startsWith("/auth/v1/") || url.username || url.password) throw new TypeError("Invalid Supabase Auth destination");
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return withDeadline(async (signal) => {
      const response = await expoFetch(typeof input === "string" ? url.href : input, { ...init, signal, redirect: "error", credentials: "omit" });
      rejectRedirect(response);
      const body = response.status === 204 || response.status === 205 ? null : await response.text();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }, timeoutDefault, parent);
  } };
}
