import { fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as send } from "expo/fetch";
import * as Storage from "expo-secure-store";
import Index from "../src/app/index";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-sqlite");
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, getRandomBytesAsync: async (size: number) => require("node:crypto").randomBytes(size),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockReadSession = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: mockReadSession, localPrincipal: async () => "fixture-subscriptions" }) }));

const [profile, workspace, first, second, rule] = [1, 2, 3, 4, 5].map((n) => `daca0000-0000-4000-8000-00000000000${n}`);
const path = "/v1/subscriptions", stamp = "2026-11-22T00:00:00.000000Z";
const cursor = Buffer.from(JSON.stringify([workspace, stamp, first, "detected"])).toString("base64url");
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const open = async () => { await render(<Index />); await press("Suscripciones detectadas"); };
function setup({ role = "editor", lose = false, stale = false, paged = false } = {}) {
  jest.clearAllMocks(); mockReadSession.mockResolvedValue({ accessToken: "fixture" });
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => key === `savia.workspace.${profile}` ? workspace : key === "savia.offline.key.v1" ? "a".repeat(64) : null);
  const calls: { pathname: string; etag: string | null; key: string | null; body: unknown }[] = [];
  const pages: (string | null)[] = [];
  const completed = new Map<string, object>();
  let version = 1, status = "detected", revoked = false, now = Date.parse(stamp), offline = false;
  const fetch = jest.mocked(send) as unknown as jest.Mock;
  fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (offline) throw new Error("Disconnected");
    const { pathname, searchParams } = new URL(url), headers = new Headers(init.headers), etag = `"${version}"`;
    const reply = (body: unknown, code = 200) => ({ status: code, ok: code < 300, redirected: false,
      headers: new Headers({ Date: new Date(now).toUTCString(), ETag: etag }), json: async () => body });
    const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: !!nextCursor, nextCursor } });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(page(revoked ? [] : [{ id: workspace, name: "Casa" }]));
    if (pathname === `/v1/workspaces/${workspace}`) return reply({ id: workspace, role, kind: "family" });
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    const row = { id: first, payeeName: "Música", currentAmount: { amountMinor: "995", currency: "USD" }, frequency: "monthly", status, etag };
    if (pathname === path && init.method === "GET") {
      expect(searchParams.get("status")).toBe("detected"); expect(searchParams.get("limit")).toBe("20");
      pages.push(searchParams.get("cursor"));
      return reply(searchParams.has("cursor") ? page([{ ...row, id: second, payeeName: "Revista" }]) : page(status === "detected" ? [row] : [], paged ? cursor : null));
    }
    expect(init.method).toBe("POST"); expect(pathname).toMatch(new RegExp(`^${path}/${first}/(confirm|discard)$`));
    const key = headers.get("Idempotency-Key"); if (!key) throw new Error("key missing");
    calls.push({ pathname, key, etag: headers.get("If-Match"), body: init.body });
    if (completed.has(key)) return reply(completed.get(key));
    if (stale) { stale = false; version++; return reply({}, 412); }
    if (role === "viewer") return reply({}, 403);
    expect(headers.get("If-Match")).toBe(etag);
    const confirm = pathname.endsWith("/confirm"); status = confirm ? "confirmed" : "ignored"; version++;
    const result = { ...row, status, etag: `"${version}"`, ...(confirm && { recurringRuleId: rule }) };
    completed.set(key, result);
    if (lose) { lose = false; throw new Error("Response lost"); }
    return { ...reply(result), headers: new Headers({ ETag: result.etag }) };
  });
  return { calls, pages, completed, fetch, disconnect: () => { offline = true; }, revoke: () => { revoked = true; }, advance: () => { now += 23 * 3_600_000; } };
}

async function decide(label: "confirmar" | "descartar") {
  await press("Revisar: Música"); await press(label === "confirmar" ? "Confirmar suscripción" : "Descartar suscripción");
}

test("confirmation is explicit and reuses the reviewed ETag and memory-only key after a lost reply", async () => {
  const f = setup({ lose: true }); await open(); await decide("confirmar");
  expect(f.calls).toEqual([]); jest.mocked(Storage.setItemAsync).mockClear();
  await press("Sí, confirmar"); await screen.findByText("No pudimos actualizar la suscripción.");
  await press("Sí, confirmar"); await screen.findByText("Suscripción confirmada.");
  expect(f.calls).toEqual([{ pathname: `${path}/${first}/confirm`, etag: '"1"', key: expect.any(String), body: undefined }, f.calls[0]]);
  expect(f.completed.size).toBe(1); expect(Storage.setItemAsync).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Revisar: Música" })).toBeNull();
});

test("an expired subscription decision is not replayed without a new explicit confirmation", async () => {
  const f = setup({ lose: true }); await open(); await decide("confirmar");
  const deviceClock = jest.spyOn(Date, "now").mockReturnValue(Date.parse(stamp));
  try {
    await press("Sí, confirmar"); await screen.findByText("No pudimos actualizar la suscripción.");
    f.advance(); await press("Sí, confirmar");
    await screen.findByRole("button", { name: "Confirmar reintento" });
    expect(screen.getByRole("alert")).toHaveTextContent("Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo.");
    expect(f.calls).toHaveLength(1); expect(f.completed.size).toBe(1);
  } finally { deviceClock.mockRestore(); }
});

test("discard refreshes a stale candidate without resubmitting; a later decision uses the new ETag", async () => {
  const f = setup({ stale: true }); await open(); await decide("descartar");
  expect(f.calls).toEqual([]); await press("Sí, descartar"); await screen.findByText("La suscripción cambió. Revisa los datos actualizados.");
  expect(f.calls).toHaveLength(1); expect(f.completed.size).toBe(0);
  expect(screen.queryByRole("button", { name: "Sí, descartar" })).toBeNull();
  await decide("descartar"); await press("Sí, descartar"); await screen.findByText("Suscripción descartada.");
  expect(f.calls[1]).toMatchObject({ pathname: `${path}/${first}/discard`, etag: '"2"', key: expect.any(String), body: undefined });
  expect(f.calls[1].key).not.toBe(f.calls[0].key); expect(f.completed.size).toBe(1);
});

test("viewers can page through filtered candidates but cannot decide; the list is online-only", async () => {
  const f = setup({ paged: true, role: "viewer" }); await open(); await screen.findByText("Música");
  await press("Cargar más suscripciones"); await screen.findByText("Revista");
  expect(f.pages).toEqual([null, cursor]); expect(screen.queryByRole("button", { name: "Revisar: Música" })).toBeNull();
  f.disconnect(); await press("Actualizar suscripciones"); await screen.findByText("No pudimos cargar las suscripciones detectadas.");
  expect(screen.queryByText("Música")).toBeNull(); expect(f.calls).toEqual([]);
});

test("a revoked workspace stops a decision before dispatch", async () => {
  const f = setup(); await open(); await decide("confirmar"); f.revoke(); f.fetch.mockClear();
  await press("Sí, confirmar"); await screen.findByText("No pudimos actualizar la suscripción.");
  expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
  expect(f.calls).toEqual([]); expect(f.completed.size).toBe(0);
});
