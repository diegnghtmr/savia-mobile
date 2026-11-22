import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createDebtPayments } from "../src/foundation/debt-payments";
import { createDebts } from "../src/foundation/debts";
import { createTransport } from "../src/foundation/transport";
import { DebtsScreen } from "../src/mobile-shell/debts-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `c0ffee00-0000-4000-8000-00000000000${n}`;
const [workspace, profile, debt, account, foreign, receipt] = [1, 2, 3, 4, 5, 6].map(id);
const path = `/v1/debts/${debt}/payments`, hour = 3_600_000, start = Date.UTC(2026, 10, 21);
const amount = (amountMinor: string) => ({ currency: "KWD", amountMinor });
const draft = { accountId: account.toUpperCase(), totalAmount: "9007199254740993,012", date: "2026-11-21" };
const split = { principalAmount: "9007199254740992,999", interestAmount: "0,012", feeAmount: "0,001" };
const secure = jest.mocked(SecureStore);
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (label: string, value: string) => fireEvent.changeText(await screen.findByLabelText(label), value);

function setup() {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]);
  secure.getItemAsync.mockImplementation(async (key) => storage.get(key) ?? null);
  secure.setItemAsync.mockImplementation(async (key, value) => { storage.set(key, value); });
  secure.deleteItemAsync.mockImplementation(async (key) => { storage.delete(key); });
  const pending = () => [...storage].filter(([key]) => key.startsWith("savia.ledger."));
  let online = true, revoked = false, lose = false, corrupt = false, now = start, balance = 9007199254740994012n;
  const commits = new Map<string, { at: number; body: unknown }>();
  const posts: { key: string; body: object; persisted: boolean; match: string | null }[] = [];
  const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    if (!online) throw new Error("Offline");
    const { pathname } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => body });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(page(revoked ? [] : [{ id: workspace, name: "Casa" }]));
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (init.method === "GET") {
      expect(pathname).toBe("/v1/debts");
      return reply(page([{ id: debt, name: "Préstamo", currency: "KWD", principal: amount("9007199254740994012"),
        outstandingBalance: amount(String(balance)), annualRate: "0.045", status: "active" }]));
    }
    expect(init.method).toBe("POST"); expect(pathname).toBe(path);
    const body = JSON.parse(String(init.body)), key = headers.get("Idempotency-Key")!;
    posts.push({ key, body, persisted: pending().some(([, value]) => JSON.parse(value).key === key), match: headers.get("If-Match") });
    const saved = commits.get(key);
    if (saved && now - saved.at < 24 * hour) return reply(saved.body, 201);
    const principalMinor = ["principalAmount", "interestAmount", "feeAmount"].some((part) => Object.hasOwn(body, part)) ? body.principalAmount?.amountMinor ?? "0" : body.totalAmount.amountMinor;
    balance -= BigInt(principalMinor);
    const result = { id: receipt, accountId: body.accountId, type: "debt_payment", status: "confirmed", occurredAt: body.occurredAt, amount: amount(`-${body.totalAmount.amountMinor}`) };
    commits.set(key, { at: now, body: result });
    if (lose) { lose = false; throw new Error("Reply lost"); }
    if (corrupt) { corrupt = false; return reply({ ...result, amount: body.totalAmount }, 201); }
    return reply(result, 201);
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  const connect = () => createDebtPayments(requestInWorkspace, workspace, async () => [{ id: account, name: "Caja", currency: "KWD" }, { id: foreign, name: "Yenes", currency: "JPY" }]);
  return { api: createDebts(requestInWorkspace, workspace), connect, read, send, pending, posts, commits, lose: () => { lose = true; }, corrupt: () => { corrupt = true; },
    advance: (ms: number) => { now += ms; }, revoke: () => { revoked = true; }, disconnect: () => { online = false; } };
}

test("rejects invalid payments, repeated inputs, wrong-currency accounts and inexact splits before session or storage", async () => {
  const f = setup(), writer = f.connect(); await writer.loadAccounts();
  for (const bad of [{ totalAmount: "0" }, { totalAmount: "-1" }, { totalAmount: "9223372036854775,808" }, { totalAmount: "1e3" }, { totalAmount: "1,0001" },
    { totalAmount: ["1", "2"] }, { accountId: [account] }, { accountId: foreign }, { accountId: debt }, { date: "2026-02-29" }, { date: [draft.date] },
    { interestAmount: "0,012" }, { ...split, principalAmount: "-0,001" }, { ...split, feeAmount: "0,002" }, { ...split, feeAmount: ["0,001"] }, { installmentId: id(7) }]) {
    await expect(writer.pay(debt, "KWD", { ...draft, ...bad })).rejects.toThrow("Revisa los datos del pago.");
  }
  await expect(writer.pay([debt], "KWD", draft)).rejects.toThrow("Revisa los datos del pago.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(f.pending()).toEqual([]); expect(f.posts).toEqual([]); expect(f.commits.size).toBe(0);
});

test("posts an exact split, refreshes the balance by principal only, and refuses a later revoked payment", async () => {
  const f = setup(), writer = f.connect();
  await render(<DebtsScreen api={f.api} payments={writer} back={jest.fn()} />);
  await press("Préstamo"); await press("Registrar pago"); await press("Cuenta: Caja (KWD)");
  expect(screen.queryByRole("button", { name: "Cuenta: Yenes (JPY)" })).toBeNull();
  await enter("Importe total", draft.totalAmount); await enter("Fecha (AAAA-MM-DD, UTC)", draft.date);
  await enter("Capital (opcional)", split.principalAmount); await enter("Interés (opcional)", split.interestAmount); await enter("Comisiones (opcional)", split.feeAmount);
  await press("Guardar pago"); expect(await screen.findByText("Saldo pendiente: 1,013 KWD")).toBeTruthy();
  expect(f.posts[0]).toMatchObject({ persisted: true, match: null, body: { accountId: account, totalAmount: amount("9007199254740993012"),
    principalAmount: amount("9007199254740992999"), interestAmount: amount("12"), feeAmount: amount("1"), occurredAt: `${draft.date}T00:00:00.000Z` } });
  f.send.mockClear(); f.revoke(); await expect(writer.pay(debt, "KWD", draft)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]); expect(f.posts).toHaveLength(1); expect(f.pending()).toEqual([]);
});

test("omits the split when absent and retries a lost reply with persisted server-time identity after reopen", async () => {
  const f = setup(), writer = f.connect(); await writer.loadAccounts(); f.lose();
  await expect(writer.pay(debt, "KWD", draft)).rejects.toThrow(/Necesitas conexión/);
  expect(f.posts[0].body).toEqual({ accountId: account, totalAmount: amount("9007199254740993012"), occurredAt: `${draft.date}T00:00:00.000Z` });
  expect(f.pending()).toHaveLength(1); f.advance(23 * hour - 1000);
  const reopened = f.connect(); await reopened.loadAccounts();
  await expect(reopened.pay(debt.toUpperCase(), "KWD", { ...draft, totalAmount: "09007199254740993.012" })).resolves.toBe(receipt);
  expect(f.posts[1]).toEqual(f.posts[0]); expect(f.pending()).toEqual([]); expect(f.commits.size).toBe(1);
});

test("after server expiry requires single-use confirmation and keeps a different draft from consuming it", async () => {
  const f = setup(), writer = f.connect(); await writer.loadAccounts(); f.lose();
  const clock = jest.spyOn(Date, "now").mockReturnValue(start + 4 * hour);
  try {
    await expect(writer.pay(debt, "KWD", draft)).rejects.toThrow();
    f.advance(23 * hour); clock.mockReturnValue(start + 23 * hour);
    const warning = await writer.pay(debt, "KWD", draft).catch(error => error);
    expect(warning.message).toMatch(/^Puede que este movimiento/); expect(f.posts).toHaveLength(1);
    await expect(writer.pay(debt, "KWD", { ...draft, totalAmount: "2" }, warning)).rejects.toThrow("Pending submission changed");
    expect(f.posts).toHaveLength(1); f.lose();
    await expect(writer.pay(debt, "KWD", draft, warning)).rejects.toThrow(/Necesitas conexión/);
    expect(f.posts[1].key).not.toBe(f.posts[0].key);
    f.advance(23 * hour);
    await expect(writer.pay(debt, "KWD", draft, warning)).rejects.toThrow("Pending submission changed");
    await expect(writer.pay(debt, "KWD", draft)).rejects.toThrow(warning.message);
    expect(f.posts).toHaveLength(2); expect(f.pending()).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("does not clear an invalid receipt or enqueue a new offline payment", async () => {
  const f = setup(), writer = f.connect(); await writer.loadAccounts(); f.corrupt();
  await expect(writer.pay(debt, "KWD", draft)).rejects.toThrow(); expect(f.pending()).toHaveLength(1);
  await expect(writer.pay(debt, "KWD", draft)).resolves.toBe(receipt); expect(f.posts[1]).toEqual(f.posts[0]); expect(f.pending()).toEqual([]);
  f.disconnect(); await expect(writer.pay(debt, "KWD", draft)).rejects.toThrow(/Necesitas conexión/);
  expect(f.pending()).toEqual([]); expect(f.posts).toHaveLength(2); expect(f.commits.size).toBe(1);
});
