import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createAccounts } from "../src/foundation/accounts";
import { createTransport } from "../src/foundation/transport";
import { AccountsScreen } from "../src/mobile-shell/accounts-screen";

jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const workspace = id(1);
const account = { id: id(2), name: "Ahorros", type: "savings", status: "active", currency: "USD", includeInNetWorth: true, updatedAt: "2026-02-20T10:11:11Z", createdAt: "2026-02-20T10:11:11Z", version: 1 };
const original = { amountMinor: "900719925474099301", currency: "USD" };
const balance = {
  accountId: account.id, asOf: "2026-02-20T10:11:11.000000Z", nativeBalance: original,
  pendingBalance: { amountMinor: "-5", currency: "USD" }, reconciledBalance: { amountMinor: "1", currency: "USD" },
  baseCurrencyEquivalent: { original, converted: { amountMinor: "450123", currency: "JPY" }, rate: "0.123456789012345678", rateDate: "2026-02-19", rateSource: "Fixture" },
};
const reply = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, redirected: false, headers: new Headers(), json: async () => body });
const input = { name: " Caja ", type: "cash", currency: "cop" };
const secure = jest.mocked(SecureStore);
beforeEach(() => { jest.resetAllMocks(); secure.getItemAsync.mockResolvedValue(workspace); });
function setup() {
  let member = true;
  let failCreate = false;
  const newKey = jest.fn().mockReturnValueOnce(id(4)).mockReturnValueOnce(id(5)).mockReturnValueOnce(id(6));
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture-bearer" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/me") return reply({ id: id(3) });
    if (parsed.pathname === "/v1/workspaces") return reply({ items: member ? [{ id: workspace, name: "Casa" }] : [], pageInfo: { hasNextPage: false } });
    if (init.method === "POST") {
      if (failCreate) { failCreate = false; return reply({}, 503); }
      return reply(account, 201);
    }
    if (parsed.pathname === "/v1/accounts") return reply({ items: parsed.searchParams.has("cursor") ? [] : [account], pageInfo: { hasNextPage: !parsed.searchParams.has("cursor"), nextCursor: parsed.searchParams.has("cursor") ? null : "opaque_1" } });
    if (parsed.pathname.endsWith("/balance")) return reply(balance);
    return reply(account);
  });
  const api = createAccounts(createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace, workspace, newKey);
  const calls = () => send.mock.calls.filter(([url]) => new URL(url).pathname.startsWith("/v1/accounts"));
  return { api, read, send, calls, newKey, revoke: () => { member = false; }, failNextCreate: () => { failCreate = true; } };
}

test("validates repeated or malformed params and create fields before accessing session or storage", async () => {
  const { api, read, send, newKey } = setup();
  for (const query of [{ status: ["active", "closed"] }, { status: "unknown" }, { cursor: ["opaque_1"] }, { cursor: "\n" }, { limit: ["2", "3"] }, { limit: "201" }, { status: "" }, { force: true }]) await expect(api.list(query)).rejects.toThrow("Filtros de cuentas no válidos.");
  await expect(api.list(new URLSearchParams("status=active&status=closed"))).rejects.toThrow("Filtros de cuentas no válidos.");
  await expect(api.detail([account.id, account.id])).rejects.toThrow("Cuenta no válida.");
  for (const bad of [{ name: ["Caja", "Caja"] }, { type: "wrong" }, { currency: "ZZZ" }, { openingBalance: ["1"] }, { openingBalance: "1.234" }, { openingBalance: "1e3" }, { openingBalance: "-92233720368547758.08" }, { openingBalanceDate: "2026-02-20" }, { openingBalance: "1", openingBalanceDate: "2025-02-29" }]) {
    await expect(api.draft()({ ...input, ...bad })).rejects.toThrow("Revisa los datos de la cuenta.");
  }
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(newKey).not.toHaveBeenCalled();
  expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
});

test("keeps status with the opaque cursor, reads exact balances and never sends a revoked workspace header", async () => {
  const { api, send, calls, revoke } = setup();
  await expect(api.list({ status: "active", limit: "2" })).resolves.toMatchObject({ items: [{ id: account.id, name: "Ahorros", status: "active", balance: "9007199254740993,01 USD" }], nextCursor: "opaque_1" });
  await expect(api.list({ status: "active", limit: "2", cursor: "opaque_1" })).resolves.toEqual({ items: [], nextCursor: null });
  expect(calls().map(([url]) => url)).toEqual([`https://api.invalid/v1/accounts?limit=2&status=active`, `https://api.invalid/v1/accounts/${account.id}/balance`, `https://api.invalid/v1/accounts?limit=2&status=active&cursor=opaque_1`]);
  for (const [url, init] of send.mock.calls) expect(new Headers(init.headers).get("X-Workspace-Id")).toBe(url.includes("/v1/accounts") ? workspace : null);
  revoke();
  await expect(api.detail(account.id)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(calls()).toHaveLength(3);
});

test("posts exact same-currency minor units and date, reuses a normalized retry, and gives edited drafts a new UUID", async () => {
  const { api, calls, failNextCreate } = setup();
  const create = api.draft();
  const draft = { ...input, openingBalance: "09007199254740993,01", openingBalanceDate: "2024-02-29" };
  failNextCreate();
  await expect(create(draft)).rejects.toMatchObject({ kind: "http", status: 503 });
  await create({ ...draft, openingBalance: "9007199254740993.01" });
  await create({ ...draft, currency: "JPY", openingBalance: "-5" });
  await create({ ...draft, currency: "KWD", openingBalance: "1.002" });
  const posts = calls().map(([, init]) => [new Headers(init.headers).get("Idempotency-Key"), JSON.parse(String(init.body))]);
  expect(posts).toEqual([
    [id(4), { name: "Caja", type: "cash", currency: "COP", openingBalance: { amountMinor: "900719925474099301", currency: "COP" }, openingBalanceDate: "2024-02-29" }],
    [id(4), { name: "Caja", type: "cash", currency: "COP", openingBalance: { amountMinor: "900719925474099301", currency: "COP" }, openingBalanceDate: "2024-02-29" }],
    [id(5), { name: "Caja", type: "cash", currency: "JPY", openingBalance: { amountMinor: "-5", currency: "JPY" }, openingBalanceDate: "2024-02-29" }],
    [id(6), { name: "Caja", type: "cash", currency: "KWD", openingBalance: { amountMinor: "1002", currency: "KWD" }, openingBalanceDate: "2024-02-29" }],
  ]);
});

test("renders a filtered accessible list, detail buckets and FX provenance without inventing missing balances", async () => {
  const { api, calls } = setup();
  await render(<AccountsScreen api={api} back={jest.fn()} />);
  await fireEvent.press(await screen.findByRole("button", { name: "Activas" }));
  await fireEvent.press(await screen.findByRole("button", { name: "Cargar más" }));
  expect(calls().some(([url]) => url.endsWith("status=active&cursor=opaque_1"))).toBe(true);
  await fireEvent.press(await screen.findByRole("button", { name: "Ahorros" }));
  expect(await screen.findByText("Saldo confirmado: 9007199254740993,01 USD")).toBeTruthy();
  expect(screen.getByText("Saldo pendiente: −0,05 USD")).toBeTruthy();
  expect(screen.getByText("Saldo conciliado: 0,01 USD")).toBeTruthy();
  expect(screen.getByText("Saldo disponible: No informado")).toBeTruthy();
  expect(screen.getByText("Equivalente en moneda base: 450123 JPY")).toBeTruthy();
  expect(screen.getByText(/0\.123456789012345678.*2026-02-19.*Fixture/)).toBeTruthy();
  expect(calls().some(([url]) => url.endsWith(`/${account.id}`))).toBe(true);
});

test("keeps the form recoverable after local rejection without an account request", async () => {
  const { api, calls, read } = setup();
  await render(<AccountsScreen api={api} back={jest.fn()} />);
  await screen.findByRole("button", { name: "Ahorros" });
  await fireEvent.press(screen.getByRole("button", { name: "Nueva cuenta" }));
  const before = read.mock.calls.length;
  await fireEvent.changeText(screen.getByLabelText("Saldo inicial"), "1.003");
  await fireEvent.press(screen.getByRole("button", { name: "Crear cuenta" }));
  expect(await screen.findByText("Revisa los datos de la cuenta.")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(before);
  expect(calls().filter(([, init]) => init.method === "POST")).toHaveLength(0);
});
