import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import { readApiOrigin } from "../src/foundation/config";
import { sessionStore } from "../src/foundation/session-store";
import { authNetwork, createTransport } from "../src/foundation/transport";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));
jest.mock("expo/fetch", () => ({ fetch: jest.fn(() => { throw new Error("uninjected network"); }) }));

const secure = jest.mocked(SecureStore);
const credentials = { accessToken: "access-fixture", refreshToken: "refresh-fixture" };
beforeEach(() => jest.resetAllMocks());

test("persists only session credentials under one device-bound Secure Store key", async () => {
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  const session = { ...credentials, email: "fixture@example.invalid" };
  await sessionStore.write(session);
  expect(secure.setItemAsync).toHaveBeenCalledWith("savia.session.v1", JSON.stringify(credentials), options);
  secure.getItemAsync.mockResolvedValue(JSON.stringify(session));
  await expect(sessionStore.read()).resolves.toEqual(credentials);
  expect(secure.getItemAsync).toHaveBeenCalledWith("savia.session.v1", options);
  await sessionStore.clear();
  expect(secure.deleteItemAsync).toHaveBeenCalledWith("savia.session.v1", options);
});

test.each([null, "{broken", '{"accessToken":""}'])("does not use or rewrite an unusable session (%s)", async (value) => {
  secure.getItemAsync.mockResolvedValue(value);
  await expect(sessionStore.read()).resolves.toBeNull();
  expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(secure.deleteItemAsync).not.toHaveBeenCalled();
});

test("rejects invalid credentials before any storage write", async () => {
  await expect(sessionStore.write({ ...credentials, accessToken: "not\nvalid" })).rejects.toThrow("Invalid session credentials");
  expect(secure.setItemAsync).not.toHaveBeenCalled();
});

test.each(["localhost", "127.0.0.1", "[::1]"])("allows HTTP for an explicitly configured development loopback (%s)", (host) => {
  const url = `http://${host}:8080`;
  expect(readApiOrigin(`${url}/`, true)).toBe(url);
  expect(() => readApiOrigin(url, false)).toThrow("Invalid Savia API origin");
});

test.each(["", "http://localhost.invalid", "http://127.1", "https://u:p@api.invalid", "https://api.invalid/api", "https://api.invalid/?next=x"])("rejects an unsafe or absent configured origin (%s)", (url) => {
  expect(() => readApiOrigin(url, true)).toThrow("Invalid Savia API origin");
});

function setup(status = 200, body: unknown = { id: "profile" }, contentType = "application/json") {
  const response = { status, ok: status >= 200 && status < 300, headers: new Headers({ "Content-Type": contentType }), redirected: false, json: jest.fn().mockResolvedValue(body) };
  const send = jest.fn<Promise<typeof response>, [string, RequestInit]>().mockResolvedValue(response);
  const sessions = { read: jest.fn<Promise<typeof credentials | null>, []>().mockResolvedValue(credentials) };
  return { send, sessions, response, client: createTransport({ baseUrl: "https://api.invalid/", send, sessions, timeoutMs: 10 }) };
}

test("sends credentials only to the configured origin with redirects and cookies disabled", async () => {
  const { client, send, sessions } = setup();
  await expect(client.request("/v1/workspaces", { method: "POST", body: { name: "Prueba" }, idempotencyKey: "draft-fixture" })).resolves.toEqual({ id: "profile" });
  expect(sessions.read).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith("https://api.invalid/v1/workspaces", {
    method: "POST", body: '{"name":"Prueba"}', credentials: "omit", redirect: "error", signal: expect.any(AbortSignal),
    headers: { Accept: "application/json, application/problem+json", Authorization: "Bearer access-fixture", "Content-Type": "application/json", "Idempotency-Key": "draft-fixture" },
  });
});

test("rejects an origin override before reading or sending credentials", async () => {
  const { client, send, sessions } = setup();
  await expect(client.request("//other.invalid")).rejects.toThrow("Invalid Savia API path");
  expect(sessions.read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("does not send a protected request without a session", async () => {
  const { client, send, sessions } = setup();
  sessions.read.mockResolvedValue(null);
  await expect(client.request("/v1/me")).rejects.toMatchObject({ kind: "http", status: 401 });
  expect(send).not.toHaveBeenCalled();
});

test("maps problem JSON without trusting its status or echoing its detail", async () => {
  const { client } = setup(404, { status: 200, code: "profile_not_found", traceId: "trace-fixture", detail: "private" }, "application/problem+json; charset=utf-8");
  const error = await client.request("/v1/me").catch((value: unknown) => value);
  expect(JSON.parse(JSON.stringify(error))).toEqual({ kind: "http", status: 404, code: "profile_not_found", message: "Savia API request failed" });
});

test("retains a canonical Savia problem type without exposing arbitrary response text", async () => {
  const problemType = "https://savia.app/problems/last-owner-required";
  const { client } = setup(409, { status: 200, type: problemType, detail: "private" }, "application/problem+json");
  const error = await client.request("/v1/me").catch((value: unknown) => value);
  expect(error).toMatchObject({ kind: "http", status: 409, problemType });
  expect(JSON.stringify(error)).not.toContain("private");
  for (const type of [`${problemType}?value=private`, `https://savia.app/problems/${credentials.accessToken}`]) {
    const { client } = setup(409, { type }, "application/problem+json");
    const unsafe = await client.request("/v1/me").catch((value: unknown) => value);
    expect(JSON.stringify(unsafe)).not.toContain(type);
    expect(unsafe).not.toMatchObject({ problemType: type });
  }
});

test("rejects a redirect response before consuming its body", async () => {
  const { client, response } = setup(302);
  await expect(client.request("/v1/me")).rejects.toMatchObject({ kind: "redirect" });
  expect(response.json).not.toHaveBeenCalled();
});

test("aborts and times out even if response parsing never settles", async () => {
  const { client, send, response } = setup();
  response.json.mockImplementation(() => new Promise(() => {}));
  await expect(client.request("/v1/me")).rejects.toMatchObject({ kind: "timeout" });
  expect(send.mock.calls[0]?.[1].signal?.aborted).toBe(true);
});

test("aborts and settles a stalled Supabase Auth request", async () => {
  jest.useFakeTimers();
  try {
    const send = jest.mocked(expoFetch);
    send.mockImplementationOnce(() => new Promise(() => {}));
    const origin = "https://identity.invalid";
    const settled = jest.fn();
    void authNetwork(origin).fetch(`${origin}/auth/v1/token`).then(settled, settled);

    await jest.advanceTimersByTimeAsync(60_000);

    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test("does not expose the bearer in serialized problem metadata", async () => {
  const token = credentials.accessToken;
  const { client } = setup(
    422,
    { status: 404, code: token, traceId: token, detail: token },
    "application/problem+json",
  );

  const error = await client.request("/v1/me").catch((value: unknown) => value);

  expect(error).toMatchObject({
    kind: "http",
    status: 422,
    message: "Savia API request failed",
  });
  expect(JSON.stringify(error)).not.toContain(token);
});

// Reviewer draft (verify mwtpt3mr, not executed). Append to __tests__/foundation.test.ts.
test("receipt upload failures retain their baseline serialized shape", async () => {
  const { client } = setup(422, {
    type: "https://savia.app/problems/receipt-dimensions-exceeded",
    code: "receipt_dimensions_exceeded",
    detail: "fixture image exceeds the dimension limit",
  }, "application/problem+json");
  const error = await client.request("/v1/receipts", {
    method: "POST", multipart: new FormData(),
  }).catch((failure: unknown) => failure);

  expect(JSON.parse(JSON.stringify(error))).toEqual({
    kind: "http",
    status: 422,
    code: "receipt_dimensions_exceeded",
    message: "Savia API request failed",
  });
});
