import * as SecureStore from "expo-secure-store";
import { createIdentity } from "../src/foundation/identity";
import { createOffline } from "../src/foundation/offline-cache";
import { createTransactions } from "../src/foundation/transactions";
import { createTransfers } from "../src/foundation/transfers";
import { createTransport } from "../src/foundation/transport";

jest.mock("expo-sqlite");
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, randomUUID: require("node:crypto").randomUUID,
  digestStringAsync: async (_: string, input: string) => require("node:crypto").createHash("sha256").update(input).digest("hex"),
  getRandomBytesAsync: async (size: number) => require("node:crypto").randomBytes(size) }));
const id = (n: number) => `cafecafe-cafe-4afe-8afe-cafecafecaf${n}`;
const [profile, workspace, cash, bank, yen, receipt] = [0, 1, 2, 3, 4, 5].map(id);
const txPath = "/v1/transactions", transferPath = "/v1/transfers", fxPath = "/v1/currency-exchanges";
const date = "2026-11-01", tx = { accountId: cash, type: "expense", amount: "1,20", date };
const transfer = { sourceAccountId: cash, destinationAccountId: bank, amount: "1,20", date };
const fx = { ...transfer, destinationAccountId: yen, received: "30", executedRate: "25" };
const hour = 3_600_000;
const notice = "Guardado sin conexión. Revisa las operaciones pendientes.";

beforeEach(() => {
  jest.requireMock("expo-sqlite").resetSQLite();
  const secure = new Map<string, string>();
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => secure.get(key) ?? null);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { secure.set(key, value); });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => { secure.delete(key); });
});

function fixture() {
  let mode: "offline" | "online" | "lose" = "online", conflict = 0, member = true, now = Date.UTC(2026, 10, 1);
  const trace: string[] = [], posts: { path: string; key: string; body: Record<string, unknown> }[] = [];
  const committed: string[] = [], replay = new Map<string, number>();
  const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false } });
  const transport = createTransport({ baseUrl: "https://api.invalid", sessions: { read: async () => ({ accessToken: "fixture" }) }, send: async (url, request) => {
    if (mode === "offline") throw new Error("Disconnected");
    const { pathname } = new URL(url);
    const headers = new Headers(request.headers), reply = (data: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => data });
    if (pathname === "/v1/me") { trace.push("me"); return reply({ id: profile }); }
    if (pathname === "/v1/workspaces") { trace.push("memberships"); return reply(page(member ? [{ id: workspace, name: "Casa" }] : [])); }
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (request.method === "GET") return reply(page(pathname === "/v1/accounts" ? [cash, bank, yen].map((id) => ({ id, name: id, status: "active", currency: id === yen ? "JPY" : "USD" })) : []));
    trace.push(pathname);
    const key = headers.get("Idempotency-Key")!, body = JSON.parse(String(request.body));
    posts.push({ path: pathname, key, body });
    if (conflict) return reply({}, conflict);
    const prior = replay.get(key);
    if (prior === undefined || now - prior >= 24 * hour) { committed.push(key); replay.set(key, now); }
    if (mode === "lose") throw new Error("Reply lost after commit");
    return reply({ id: receipt, sourceAccountId: body.sourceAccountId, destinationAccountId: body.destinationAccountId }, 201);
  } });
  const open = () => {
    const service = createOffline(createIdentity(transport.withSession), async () => profile);
    const scope = service.scope(profile, workspace, transport.requestInWorkspace, jest.fn());
    const box = service.outbox(profile, workspace, scope);
    const ledger = createTransactions(box.request, workspace), transfers = createTransfers(box.request, workspace, ledger.transferAccounts);
    return { service, box, ledger, transfers };
  };
  const ready = async () => { const instance = open(); await instance.service.identity.select(workspace); await instance.ledger.formOptions(true); await instance.transfers.loadAccounts(); return instance; };
  return { ready, open, trace, posts, committed, change: (value: typeof mode) => { mode = value; }, advance: (ms: number) => { now += ms; },
    reject: (value: number) => { conflict = value; }, revoke: () => { member = false; } };
}

test("offline creates survive reopen and drain normalized transaction, transfer and exchange in order with fresh checks", async () => {
  const f = fixture(), { box, ledger, transfers } = await f.ready();
  f.change("offline");
  await expect(ledger.create(tx)).rejects.toThrow(notice);
  await expect(ledger.create({ ...tx, amount: "01.20" })).rejects.toThrow(notice);
  await expect(transfers.submit("transfer", transfer)).rejects.toThrow(notice);
  await expect(transfers.submit("exchange", fx)).rejects.toThrow(notice);
  expect(f.posts).toEqual([]);
  expect((await box.list()).map(({ path }) => path)).toEqual([txPath, transferPath, fxPath]);
  f.change("online"); f.trace.length = 0;
  const restarted = f.open().box;
  await restarted.sync();
  expect(f.trace).toEqual([txPath, transferPath, fxPath].flatMap((path) => ["me", "memberships", path]));
  const money = { currency: "USD", amountMinor: "120" };
  expect(f.posts.map(({ body }) => body)).toEqual([
    { categoryId: null, payeeId: null, description: null, tagIds: [], accountId: cash, type: "expense", amount: money, occurredAt: `${date}T00:00:00.000Z` },
    { sourceAccountId: cash, destinationAccountId: bank, occurredAt: `${date}T00:00:00.000Z`, description: null, amount: money },
    { sourceAccountId: cash, destinationAccountId: yen, occurredAt: `${date}T00:00:00.000Z`, description: null, sourceAmount: money, destinationAmount: { currency: "JPY", amountMinor: "30" }, executedRate: "25" },
  ]);
  expect(new Set(f.committed).size).toBe(3); expect(await restarted.list()).toEqual([]);
});

test("an interrupted drain replays the saved key and does not duplicate on restart", async () => {
  const f = fixture(), { ledger } = await f.ready();
  f.change("lose"); await expect(ledger.create(tx)).rejects.toThrow(notice);
  f.change("online");
  const restarted = f.open().box;
  await restarted.sync();
  expect(f.posts).toEqual([f.posts[0], f.posts[0]]); expect(f.committed).toEqual([f.posts[0].key]);
  expect(await restarted.list()).toEqual([]);
});

test("an attempted outbox entry expires on server time despite clock correction and needs explicit fresh-key confirmation", async () => {
  const f = fixture(), { ledger } = await f.ready();
  const clock = jest.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 1) + 3 * hour);
  try {
    f.change("lose"); await expect(ledger.create(tx)).rejects.toThrow(notice);
    f.advance(25 * hour); clock.mockReturnValue(Date.UTC(2026, 10, 1) + 25 * hour); f.change("online");
    const restarted = f.open().box;
    await restarted.sync(); await restarted.sync();
    const [entry] = await restarted.list();
    expect(entry).toMatchObject({ path: txPath, issue: "expired" }); expect(f.posts).toHaveLength(1);
    await restarted.sync(entry.id);
    expect(f.posts[1].body).toEqual(f.posts[0].body); expect(f.posts[1].key).not.toBe(f.posts[0].key);
    expect(f.committed).toHaveLength(2); expect(await restarted.list()).toEqual([]);
  } finally { clock.mockRestore(); }
});

test.each([409, 412, 422])("a %i conflict stalls the head and keeps following entries until explicit action", async (status) => {
  const f = fixture(), { ledger, transfers } = await f.ready();
  f.change("offline"); await expect(ledger.create(tx)).rejects.toThrow(notice);
  await expect(transfers.submit("transfer", transfer)).rejects.toThrow(notice);
  f.change("online"); f.reject(status);
  const restarted = f.open().box;
  await restarted.sync(); await restarted.sync();
  const [head, next] = await restarted.list();
  expect(head).toMatchObject({ path: txPath, issue: String(status) }); expect(next).toMatchObject({ path: transferPath, issue: null });
  expect(f.posts.map(({ path }) => path)).toEqual([txPath]); expect(f.committed).toEqual([]);
  await restarted.discard(head.id); f.reject(0); await restarted.sync();
  expect(f.posts.map(({ path }) => path)).toEqual([txPath, transferPath]); expect(await restarted.list()).toEqual([]);
});

test.each(["revocation", "sign-out"])("%s purges that workspace outbox without sending", async (reason) => {
  const f = fixture(), { box, ledger, service } = await f.ready();
  f.change("offline"); await expect(ledger.create(tx)).rejects.toThrow(notice);
  if (reason === "revocation") { f.revoke(); f.change("online"); await box.sync(); }
  else await service.beforeSignOut();
  expect(f.posts).toEqual([]); expect(await f.open().box.list()).toEqual([]);
});
