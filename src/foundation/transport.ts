import { fetch as expoFetch } from "expo/fetch";
import { readApiOrigin } from "./config";
import { workspaceUnavailable } from "./identity-draft";
import { sessionStore, type SessionCredentials } from "./session-store";
import { readProfileId, readWorkspaceContext, uuid } from "./workspace-context";

const timeoutDefault = 10_000;
type Send = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "ok" | "headers" | "redirected" | "json">>;
type RequestInput = { method?: string; body?: unknown; idempotencyKey?: string; successStatus?: number | readonly number[] };
type WorkspaceOptions = {
  ifMatch?: string;
  includeETag?: boolean;
  submit?: (profileId: string, operation: (key: string) => Promise<unknown>) => Promise<unknown>;
};
export type SaviaRequest = (path: string, input?: RequestInput) => Promise<unknown>;
export type WithSession = <T>(operation: (request: SaviaRequest) => Promise<T>) => Promise<T>;

export class TransportError extends Error {
  constructor(readonly kind: "http" | "network" | "redirect" | "timeout" | "protocol", readonly status?: number, readonly code?: string) {
    super("Savia API request failed");
    this.name = "TransportError";
  }
  toJSON() { return { kind: this.kind, status: this.status, code: this.code, message: this.message }; }
}

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
  async function execute(token: string, path: string, { method = "GET", body, idempotencyKey, successStatus }: RequestInput = {}, workspace?: WorkspaceOptions & { id: string }) {
    safePath(path);
    const headers: Record<string, string> = { Accept: "application/json, application/problem+json" };
    headers.Authorization = ["Bearer", token].join(" ");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    if (workspace) {
      headers["X-Workspace-Id"] = workspace.id;
      if (workspace.ifMatch !== undefined) headers["If-Match"] = workspace.ifMatch;
    }
    return withDeadline(async (signal) => {
      const response = await send(origin + path, { method, headers, body: payload, signal, redirect: "error", credentials: "omit" });
      rejectRedirect(response);
      if (response.ok) {
        const expected = typeof successStatus === "number" ? [successStatus] : successStatus;
        if (expected && !expected.includes(response.status)) throw new TransportError("protocol", response.status);
        const decoded: unknown = await response.json().catch(() => { throw new TransportError("protocol", response.status); });
        return workspace?.includeETag ? { body: decoded, etag: response.headers.get("etag") } : decoded;
      }
      const isProblem = /^application\/problem\+json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
      const code: unknown = isProblem ? (await response.json().catch(() => null))?.code : undefined;
      const safeCode = typeof code === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(code) && !code.includes(token) ? code : undefined;
      throw new TransportError("http", response.status, safeCode);
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
      if (!id) throw new Error(workspaceUnavailable);
      return withBearer(async (token) => {
        const request = bind(token);
        const profileId = await readProfileId(request);
        const context = await readWorkspaceContext(request, profileId);
        if (context.active?.id !== id) throw new Error(workspaceUnavailable);
        const scope = { id, ifMatch: options?.ifMatch, includeETag: options?.includeETag };
        return options?.submit
          ? options.submit(profileId, (idempotencyKey) => execute(token, path, { ...options, idempotencyKey }, scope))
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
