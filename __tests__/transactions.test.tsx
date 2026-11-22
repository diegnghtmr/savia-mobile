import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createTransactions } from "../src/foundation/transactions";
import { createTransport } from "../src/foundation/transport";
import { TransactionsScreen } from "../src/mobile-shell/transactions-screen";

jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));

const id = (n: number) => `abcdefab-abcd-4abc-8abc-abcdefabcde${n}`;
const [workspace, other, profile, movement, account, category, payee, tag, next] = Array.from({ length: 9 }, (_, n) => id(n));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const nextTransaction = encode(["2026-11-01T15:00:00.000001Z", movement]);
const nextCategory = encode([workspace, "2026-11-01T15:00:00.000000Z", category]);
const row = {
  id: movement, type: "refund", status: "reconciled", accountId: account.toUpperCase(), categoryId: category, payeeId: payee.toUpperCase(), tagIds: [tag.toUpperCase()],
  amount: { amountMinor: "-9007199254740993012", currency: "KWD" }, occurredAt: "2026-11-01T15:00:00Z", description: "Reembolso aceptado",
  splits: [{ amount: { amountMinor: "-5", currency: "KWD" }, categoryId: category.toUpperCase(), tagIds: [tag] }],
};
const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: nextCursor !== null, nextCursor } });
const secure = jest.mocked(SecureStore);
beforeEach(() => { jest.resetAllMocks(); secure.getItemAsync.mockResolvedValue(workspace); });

function setup({ revokeAfterDetail = false, detailId = movement, transactionCursor = nextTransaction, categoryCursor = nextCategory } = {}) {
  let member = true;
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture-bearer" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url), path = parsed.pathname, more = parsed.searchParams.has("cursor");
    const reply = (body: unknown, status = 200) => ({ status, ok: status === 200, redirected: false, headers: new Headers(), json: async () => body });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply(more ? page(member ? [{ id: workspace, name: "Casa" }] : []) : page([{ id: other, name: "Oficina" }], "next_ws"));
    if (new Headers(init.headers).get("X-Workspace-Id") !== workspace) return reply({}, 403);
    if (path === "/v1/transactions") return reply(more ? page([{ ...row, description: "Segundo movimiento", id: next.toUpperCase() }]) : page([row], transactionCursor));
    if (path === `/v1/transactions/${movement}`) {
      if (revokeAfterDetail) member = false;
      return reply({ ...row, id: detailId });
    }
    if (path === "/v1/accounts") return reply(page([{ id: account, name: "Caja" }]));
    if (path === "/v1/categories") return reply(more ? page([{ id: category.toUpperCase(), name: "Compras" }]) : page([], categoryCursor));
    if (path === "/v1/payees") return reply(page([{ id: payee, name: "Tienda" }]));
    if (path === "/v1/tags") return reply(page([{ id: tag, name: "Viaje" }]));
    return reply({}, 404);
  });
  const api = createTransactions(createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace, workspace);
  const paths = () => send.mock.calls.map(([url, init]) => [new URL(url).pathname + new URL(url).search, new Headers(init.headers).get("X-Workspace-Id")] as const);
  return { api, read, send, paths };
}

test("rejects all malformed or repeated parameters, including limit, before any session, storage, or network access", async () => {
  const { api, read, send } = setup();
  for (const [key, value] of Object.entries({ limit: "2", from: "2024-02-29", to: "2026-04-30", query: "coffee", cursor: nextTransaction, status: "reconciled", accountId: account, categoryId: category })) {
    await expect(api.list({ [key]: [value, value] })).rejects.toThrow("Revisa los filtros.");
  }
  for (const limit of ["0", "201", "1.5", "1e2", " 1", "1\n", "", 1, undefined]) await expect(api.list({ limit })).rejects.toThrow("Revisa los filtros.");
  for (const filters of [{ from: "2026-02-29" }, { to: "2026-04-31" }, { from: "2026-11-20", to: "2026-11-19" }, { cursor: "" }, { cursor: "bad#cursor" }, { cursor: "a" }, { cursor: "W10" }, { cursor: encode(["2026-02-29T00:00:00.000000Z", movement]) }, { cursor: encode([workspace, "2026-01-01T00:00:00.000000Z", movement]) }, { status: "unknown" }, { accountId: "bad" }, { categoryId: "bad" }, { query: "x".repeat(201) }, { query: "a\0b" }, { workspaceId: other }, new URLSearchParams("limit=1&limit=2")]) {
    await expect(api.list(filters)).rejects.toThrow("Revisa los filtros.");
  }
  await expect(api.detail([movement])).rejects.toThrow("Movimiento no válido.");
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
});

test("accepts limits 1 and 200, sends every filter with lowercase UUIDs and retains them on cursor pages", async () => {
  const { api, paths } = setup();
  const filters = { accountId: account.toUpperCase(), categoryId: category.toUpperCase(), from: "2024-02-29", to: "2026-11-20", query: "Caja & café", status: "reconciled", limit: "200" };
  await expect(api.list({ limit: "1" })).resolves.toMatchObject({ nextCursor: nextTransaction });
  await expect(api.list(filters)).resolves.toMatchObject({ items: [{ id: movement, amount: "−9007199254740993,012 KWD" }], nextCursor: nextTransaction });
  await expect(api.list({ ...filters, cursor: nextTransaction })).resolves.toMatchObject({ items: [{ id: next }], nextCursor: null });
  const scoped = paths().filter(([, header]) => header === workspace).map(([path]) => Object.fromEntries(new URL(path, "https://api.invalid").searchParams));
  const expected = { ...filters, accountId: account, categoryId: category };
  expect(scoped).toEqual([{ limit: "1" }, expected, { ...expected, cursor: nextTransaction }]);
  expect(paths().slice(0, 4)).toEqual([["/v1/me", null], ["/v1/workspaces", null], ["/v1/workspaces?cursor=next_ws", null], ["/v1/transactions?limit=1", workspace]]);
});

test("opens an uppercase detail ID against a lowercase response, then resolves labels through scoped paginated catalogs", async () => {
  const { api, paths } = setup();
  await expect(api.detail(movement.toUpperCase())).resolves.toMatchObject({ id: movement, account: "Caja", category: "Compras", payee: "Tienda", tags: ["Viaje"], splits: [{ category: "Compras", tags: ["Viaje"], amount: "−0,005 KWD" }] });
  expect(paths().filter(([, header]) => header !== null).sort()).toEqual([
    [`/v1/transactions/${movement}`, workspace], ["/v1/accounts?limit=200", workspace], ["/v1/categories?limit=200", workspace],
    [`/v1/categories?limit=200&cursor=${nextCategory}`, workspace], ["/v1/payees?limit=200", workspace], ["/v1/tags?limit=200", workspace],
  ].sort());
});

test("does not fetch or expose catalogs after membership is revoked or the returned detail ID differs", async () => {
  for (const options of [{ revokeAfterDetail: true }, { detailId: next }]) {
    const { api, paths } = setup(options);
    await expect(api.detail(movement)).rejects.toThrow();
    expect(paths().filter(([, header]) => header !== null)).toEqual([[`/v1/transactions/${movement}`, workspace]]);
  }
});

test("does not follow a catalog cursor bound to another workspace", async () => {
  const { api, paths } = setup({ categoryCursor: encode([other, "2026-11-01T15:00:00.000000Z", category]) });
  await expect(api.detail(movement)).rejects.toThrow();
  expect(paths().filter(([path]) => path.startsWith("/v1/categories"))).toEqual([["/v1/categories?limit=200", workspace]]);
});

test("does not expose a server-supplied malformed next cursor", async () => {
  const { api } = setup({ transactionCursor: "W10" });
  await render(<TransactionsScreen api={api} back={jest.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos cargar los movimientos.");
  expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
});

const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
test("shows invalid limit without a request, and lets a corrected filter paginate and open a labeled detail", async () => {
  const { api, send, paths } = setup();
  await render(<TransactionsScreen api={api} back={jest.fn()} />);
  await screen.findByRole("button", { name: "Reembolso aceptado" });
  await press("Filtros");
  await press("Elegir cuenta");
  await press("Caja");
  await press("Elegir categoría");
  await press("Compras");
  await press("Conciliada");
  await fireEvent.changeText(screen.getByLabelText("Buscar texto"), "café");
  const before = send.mock.calls.length;
  await fireEvent.changeText(screen.getByLabelText("Resultados por página (1–200)"), "0");
  await press("Aplicar filtros");
  expect(await screen.findByRole("alert")).toHaveTextContent("Revisa los filtros.");
  expect(send).toHaveBeenCalledTimes(before);
  await fireEvent.changeText(screen.getByLabelText("Resultados por página (1–200)"), "2");
  await press("Aplicar filtros");
  await press("Cargar más");
  await screen.findByRole("button", { name: "Segundo movimiento" });
  const last = paths().filter(([path]) => path.startsWith("/v1/transactions?")).at(-1)?.[0] ?? "";
  expect(Object.fromEntries(new URL(last, "https://api.invalid").searchParams)).toEqual({ accountId: account, categoryId: category, status: "reconciled", limit: "2", query: "café", cursor: nextTransaction });
  await press("Reembolso aceptado");
  expect(await screen.findByRole("header", { name: "Reembolso aceptado" })).toBeTruthy();
  for (const text of ["−9007199254740993,012 KWD", "Cuenta: Caja", "Categoría: Compras", "Contraparte: Tienda", "Etiquetas: Viaje", "Compras · −0,005 KWD"]) expect(screen.getByText(text)).toBeTruthy();
});

// Reviewer regression for mobile M3 (verify mwr3ili1, PASS). Append to __tests__/transactions.test.tsx
// using its existing fixtures (setup, row, page, category, movement).
test.each([
  ["JPY", "9007199254740993001", "9007199254740993001 JPY", "1 JPY"],
  ["COP", "9007199254740993001", "90071992547409930,01 COP", "0,01 COP"],
  ["KWD", "-9007199254740993001", "−9007199254740993,001 KWD", "0,001 KWD"],
])("preserves exact %s amounts on the list, detail and splits", async (currency, amountMinor, display, split) => {
  const { api, send } = setup();
  const originalSend = send.getMockImplementation()!;
  const entry = {
    ...row,
    amount: { amountMinor, currency },
    splits: [{ amount: { amountMinor: "1", currency }, categoryId: category }],
  };
  send.mockImplementation(async (url, init) => {
    const result = await originalSend(url, init);
    const path = new URL(url).pathname;
    if (path === "/v1/transactions") return { ...result, json: async () => page([entry]) };
    if (path === "/v1/transactions/" + movement) return { ...result, json: async () => entry };
    return result;
  });

  await expect(api.list()).resolves.toMatchObject({ items: [{ amount: display }] });
  await expect(api.detail(movement.toUpperCase())).resolves.toMatchObject({
    id: movement,
    amount: display,
    splits: [{ amount: split }],
  });
});
