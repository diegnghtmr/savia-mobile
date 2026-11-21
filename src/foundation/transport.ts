import { fetch as expoFetch } from "expo/fetch";
import { readApiOrigin } from "./config";
import { sessionStore, type SessionCredentials } from "./session-store";

type Send = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "ok" | "headers" | "redirected" | "json">>;
type RequestInput = { method?: string; body?: unknown; idempotencyKey?: string; successStatus?: number };

export class TransportError extends Error {
  constructor(
    readonly kind: "http" | "network" | "redirect" | "timeout" | "protocol",
    readonly status?: number,
    readonly code?: string,
    readonly traceId?: string,
  ) {
    super("Savia API request failed");
    this.name = "TransportError";
  }
}

export function createTransport({
  baseUrl, development, timeoutMs = 10_000, send = expoFetch, sessions = sessionStore,
}: {
  baseUrl?: string; development?: boolean; timeoutMs?: number;
  send?: Send; sessions?: { read(): Promise<Pick<SessionCredentials, "accessToken"> | null> };
} = {}) {
  const origin = readApiOrigin(baseUrl, development);
  return {
    async request(path: string, { method = "GET", body, idempotencyKey, successStatus }: RequestInput = {}): Promise<unknown> {
      if (!path.startsWith("/") || path.startsWith("//") || /[\s\\#\x00-\x1f]/.test(path)) {
        throw new TypeError("Invalid Savia API path");
      }
      const session = await sessions.read();
      if (!session) throw new TransportError("http", 401);
      const headers: Record<string, string> = { Accept: "application/json, application/problem+json" };
      headers.Authorization = ["Bearer", session.accessToken].join(" ");
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new TransportError("timeout"));
          controller.abort();
        }, timeoutMs);
      });
      async function execute(): Promise<unknown> {
        const response = await send(origin + path, {
          method, headers, body: payload, signal: controller.signal, redirect: "error", credentials: "omit",
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) throw new TransportError("redirect");
        if (response.ok) {
          if (successStatus !== undefined && response.status !== successStatus) throw new TransportError("protocol", response.status);
          return response.json().catch(() => { throw new TransportError("protocol", response.status); });
        }
        const isProblem = /^application\/problem\+json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
        const problem = isProblem ? await response.json().catch(() => null) : null;
        throw new TransportError("http", response.status,
          typeof problem?.code === "string" ? problem.code : undefined,
          typeof problem?.traceId === "string" ? problem.traceId : undefined);
      }
      try { return await Promise.race([timeout, execute()]); }
      catch (error) { throw error instanceof TransportError ? error : new TransportError("network"); }
      finally { clearTimeout(timer); }
    },
  };
}

// The Auth SDK supplies its own headers; this transport never attaches a Savia bearer.
export function authNetwork(origin: string): { fetch: typeof fetch } {
  return { async fetch(input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origin || !url.pathname.startsWith("/auth/v1/") || url.username || url.password) {
      throw new TypeError("Invalid Supabase Auth destination");
    }
    const response = await expoFetch(url.href, { ...init, redirect: "error", credentials: "omit" });
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new TransportError("redirect");
    return response;
  } };
}
