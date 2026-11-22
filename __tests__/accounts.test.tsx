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
const reply = (body: unknown, status = 200, etag?: string) => ({ status, ok: status >= 200 && status < 300, redirected: false, headers: new Headers(etag ? { ETag: etag } : {}), json: async () => body });
const input = { name: " Caja ", type: "cash", currency: "cop" };
const secure = jest.mocked(SecureStore);
beforeEach(() => { jest.resetAllMocks(); secure.getItemAsync.mockResolvedValue(workspace); });
function setup({ omitETag = false, loseCloseResponse = false } = {}) {
  let member = true;
  let failCreate = false;
  let current = { ...account, institution: "Banco" as string | null };
  let closeKey: string | null = null;
  const etag = () => `"${current.version}"`;
  const newKey = jest.fn().mockReturnValueOnce(id(4)).mockReturnValueOnce(id(5)).mockReturnValueOnce(id(6));
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture-bearer" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/me") return reply({ id: id(3) });
    if (parsed.pathname === "/v1/workspaces") return reply({ items: member ? [{ id: workspace, name: "Casa" }] : [], pageInfo: { hasNextPage: false } });
    const headers = new Headers(init.headers);
    if (init.method === "PATCH" && parsed.pathname === `/v1/accounts/${account.id}`) {
      if (headers.get("If-Match") !== etag()) return reply({}, 412);
      current = { ...current, ...JSON.parse(String(init.body)), version: current.version + 1 };
      return reply(current, 200, etag());
    }
    if (init.method === "POST" && parsed.pathname === `/v1/accounts/${account.id}/close`) {
      if (closeKey && headers.get("Idempotency-Key") === closeKey) return reply(current);
      if (current.status === "closed") return reply({}, 409);
      if (headers.get("If-Match") !== etag()) return reply({}, 412);
      closeKey = headers.get("Idempotency-Key");
      current = { ...current, status: "closed", version: current.version + 1 };
      return loseCloseResponse ? reply({}, 503) : reply(current);
    }
    if (init.method === "POST" && parsed.pathname === "/v1/accounts") {
      if (failCreate) { failCreate = false; return reply({}, 503); }
      return reply(account, 201);
    }
    if (parsed.pathname === "/v1/accounts") return reply({ items: parsed.searchParams.has("cursor") ? [] : [current], pageInfo: { hasNextPage: !parsed.searchParams.has("cursor"), nextCursor: parsed.searchParams.has("cursor") ? null : "opaque_1" } });
    if (parsed.pathname.endsWith("/balance")) return reply(balance);
    return reply(current, 200, omitETag ? undefined : etag());
  });
  const api = createAccounts(createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace, workspace, newKey);
  const calls = () => send.mock.calls.filter(([url]) => new URL(url).pathname.startsWith("/v1/accounts"));
  const writes = () => calls().filter(([, init]) => init.method !== "GET");
  return { api, read, send, calls, writes, newKey, current: () => current, revoke: () => { member = false; }, failNextCreate: () => { failCreate = true; }, remoteEdit: () => { current = { ...current, name: "Cambio remoto", version: current.version + 1 }; } };
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
  for (const [url, init] of send.mock.calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("X-Workspace-Id")).toBe(url.includes("/v1/accounts") ? workspace : null);
    expect(headers.has("If-Match")).toBe(false);
  }
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
  expect(calls().every(([, init]) => !new Headers(init.headers).has("If-Match"))).toBe(true);
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

const invalidAccount = "Revisa los datos de la cuenta.";
const conflict = "La cuenta cambió. Recarga sus datos antes de volver a intentarlo.";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
async function openDetail(api: ReturnType<typeof createAccounts>) {
  await render(<AccountsScreen api={api} back={jest.fn()} />);
  await press("Ahorros");
  await screen.findByText(/Saldo confirmado:/);
}

test("rejects repeated, malformed or unconfirmed account mutations before session, storage or key generation", async () => {
  const { api, current, read, send, newKey } = setup();
  for (const body of [{}, { name: ["A", "B"] }, { name: " " }, { institution: ["Banco"] }, { maskedNumber: "1".repeat(33) }, { includeInNetWorth: "false" }, { status: "closed" }, { status: ["active", "archived"] }, { currency: "COP" }]) {
    await expect(api.update(account.id, '"1"', body)).rejects.toThrow(invalidAccount);
  }
  for (const tag of [undefined, 'W/"1"', '"1", "2"', '"2147483648"', '*', ['"1"'], '"1"\n']) {
    await expect(api.update(account.id, tag, { name: "Caja" })).rejects.toThrow(invalidAccount);
    await expect(api.close(account.id, tag, true)).rejects.toThrow(invalidAccount);
  }
  await expect(api.update([account.id], '"1"', { name: "Caja" })).rejects.toThrow(invalidAccount);
  await expect(api.close([account.id], '"1"', true)).rejects.toThrow(invalidAccount);
  for (const confirm of [false, "true", [true]]) await expect(api.close(account.id, '"1"', confirm)).rejects.toThrow(invalidAccount);
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(newKey).not.toHaveBeenCalled();
  expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(current()).toMatchObject({ name: "Ahorros", status: "active", version: 1 });
});

test("keeps the edit draft after a stale ETag without overwriting, then saves only after an explicit reload", async () => {
  const { api, current, writes, remoteEdit } = setup();
  await openDetail(api);
  await press("Editar cuenta");
  await fireEvent.changeText(screen.getByLabelText("Nombre de la cuenta"), "Mi edición");
  remoteEdit();
  await press("Guardar cambios");
  expect(await screen.findByRole("alert")).toHaveTextContent(conflict);
  expect(screen.getByDisplayValue("Mi edición")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
  expect(current()).toMatchObject({ name: "Cambio remoto", version: 2 });
  expect(writes()).toHaveLength(1);
  expect(new Headers(writes()[0][1].headers).get("If-Match")).toBe('"1"');
  await press("Recargar cuenta");
  await screen.findByRole("header", { name: "Cambio remoto" });
  await press("Editar cuenta");
  expect(screen.getByDisplayValue("Cambio remoto")).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("Nombre de la cuenta"), " Caja ");
  await fireEvent.changeText(screen.getByLabelText("Institución"), "");
  await press("Incluir en el patrimonio");
  await press("Guardar cambios");
  await screen.findByRole("header", { name: "Caja" });
  const [url, init] = writes()[1];
  expect([new URL(url).pathname, init.method, new Headers(init.headers).get("If-Match"), JSON.parse(String(init.body))]).toEqual([`/v1/accounts/${account.id}`, "PATCH", '"2"', { name: "Caja", institution: null, includeInNetWorth: false }]);
  expect(current()).toMatchObject({ name: "Caja", institution: null, includeInNetWorth: false, version: 3 });
});

test("archives and reactivates using the current ETag and a status-only patch", async () => {
  const { api, current, writes } = setup();
  await openDetail(api);
  await press("Archivar cuenta");
  await press("Reactivar cuenta");
  await screen.findByRole("button", { name: "Archivar cuenta" });
  expect(writes().map(([, init]) => [new Headers(init.headers).get("If-Match"), JSON.parse(String(init.body))])).toEqual([['"1"', { status: "archived" }], ['"2"', { status: "active" }]]);
  expect(current()).toMatchObject({ name: "Ahorros", status: "active", version: 3 });
});

test("confirms a close explicitly, retains the same idempotency key after a lost response, and hides mutations when closed", async () => {
  const { api, current, writes, newKey } = setup({ loseCloseResponse: true });
  await openDetail(api);
  await press("Cerrar cuenta");
  expect(screen.getByText(/no elimina sus movimientos/i)).toBeTruthy();
  expect(writes()).toHaveLength(0); expect(newKey).not.toHaveBeenCalled();
  await press("Cancelar cierre");
  expect(writes()).toHaveLength(0); expect(newKey).not.toHaveBeenCalled();
  await press("Cerrar cuenta");
  await press("Confirmar cierre");
  expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos cerrar la cuenta. Vuelve a intentarlo.");
  await press("Confirmar cierre");
  await screen.findByText("Ahorros · Cerrada · USD");
  expect(writes().map(([url, init]) => [new URL(url).pathname, init.method, new Headers(init.headers).get("Idempotency-Key"), new Headers(init.headers).get("If-Match"), init.body])).toEqual(Array(2).fill([`/v1/accounts/${account.id}/close`, "POST", id(4), '"1"', undefined]));
  expect(newKey).toHaveBeenCalledTimes(1);
  expect(current()).toMatchObject({ status: "closed", version: 2 });
  for (const name of ["Editar cuenta", "Archivar cuenta", "Reactivar cuenta", "Cerrar cuenta"]) expect(screen.queryByRole("button", { name })).toBeNull();
});

test("requires a current ETag to offer writes without hiding readable account details", async () => {
  const { api, writes } = setup({ omitETag: true });
  await openDetail(api);
  for (const name of ["Editar cuenta", "Archivar cuenta", "Cerrar cuenta"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(writes()).toHaveLength(0);
});

test("checks fresh workspace membership before each write, with no workspace header on confirmation requests", async () => {
  const { api, current, send, revoke } = setup();
  await api.update(account.id, '"1"', { status: "archived" });
  revoke();
  await expect(api.update(account.id, '"2"', { status: "active" })).rejects.toThrow("Este espacio ya no está disponible.");
  await expect(api.close(account.id, '"2"', true)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(send.mock.calls.map(([url, init]) => [new URL(url).pathname, new Headers(init.headers).get("X-Workspace-Id")])).toEqual([
    ["/v1/me", null], ["/v1/workspaces", null], [`/v1/accounts/${account.id}`, workspace],
    ["/v1/me", null], ["/v1/workspaces", null], ["/v1/me", null], ["/v1/workspaces", null],
  ]);
  expect(current()).toMatchObject({ status: "archived", version: 2 });
});
