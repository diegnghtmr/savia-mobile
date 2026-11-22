import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createTransactions } from "../src/foundation/transactions";
import { createTransport } from "../src/foundation/transport";
import { TransactionsScreen } from "../src/mobile-shell/transactions-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, randomUUID: require("node:crypto").randomUUID, digestStringAsync: async (_: string, input: string) => require("node:crypto").createHash("sha256").update(input).digest("hex") }));

const id = (n: number) => `abcdefab-abcd-4abc-8abc-abcdefabcde${n}`;
const [workspace, profile, account, category, payee, tag, movement] = Array.from({ length: 7 }, (_, n) => id(n));
const draft = { type: "expense", accountId: account, date: "2026-11-01", amount: "9007199254740993,012", description: "Café nuevo", categoryId: category, payeeId: payee, tagIds: [tag] };
const secure = jest.mocked(SecureStore);
const path = "/v1/transactions";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (label: string, value: string) => fireEvent.changeText(await screen.findByLabelText(label), value);
const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false } });
beforeEach(() => { jest.clearAllMocks(); });

function setup({ loseReply = false } = {}) {
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]), created = new Map<string, object>();
  const pending = () => [...storage].filter(([key]) => !key.startsWith("savia.workspace."));
  secure.getItemAsync.mockImplementation(async (key) => storage.get(key) ?? null);
  secure.setItemAsync.mockImplementation(async (key, value) => { storage.set(key, value); });
  secure.deleteItemAsync.mockImplementation(async (key) => { storage.delete(key); });
  let member = true;
  let row = { id: movement, type: "expense", status: "confirmed", accountId: account, amount: { currency: "KWD", amountMinor: "2500" }, occurredAt: "2026-11-01T15:00:00Z", description: "Café", version: 1 };
  const writes: { method: string; url: string; key: string | null; match: string | null; body: unknown; pending: boolean }[] = [];
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture-bearer" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url), headers = new Headers(init.headers);
    const reply = (data: unknown, status = 200, etag?: string) => ({ status, ok: status < 300, redirected: false, headers: new Headers(etag ? { ETag: etag } : {}), json: async () => data });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(page(member ? [{ id: workspace, name: "Casa" }] : []));
    if (headers.get("X-Workspace-Id") !== workspace) return reply({}, 403);
    if (init.method === "GET") {
      if (pathname === path) return reply(page([row]));
      if (pathname.startsWith(path)) return reply(row, 200, `"${row.version}"`);
      return reply(page(({ "/v1/accounts": [{ id: account, name: "Caja", status: "active", currency: "KWD" }], "/v1/categories": [{ id: category, name: "Comida" }], "/v1/payees": [{ id: payee, name: "Tienda" }], "/v1/tags": [{ id: tag, name: "Viaje" }] })[pathname as "/v1/accounts"] ?? []));
    }
    const key = headers.get("Idempotency-Key"), match = headers.get("If-Match"), body = JSON.parse(String(init.body));
    writes.push({ method: init.method!, url: pathname, key, match, body, pending: pending().some(([, value]) => value === key) });
    if (pathname === path && key) {
      if (created.has(key)) return reply(created.get(key), 201);
      const result = { ...row, ...body, id: id(7 + created.size) }; created.set(key, result);
      if (loseReply && created.size === 1) throw new Error("Reply lost after the backend committed");
      return reply(result, 201);
    }
    if (match !== `"${row.version}"`) return reply({}, 412);
    row = { ...row, ...body, ...(pathname.endsWith("/void") && { status: "voided" }), version: row.version + 1 };
    return reply(row);
  });
  const connect = () => createTransactions(createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace, workspace);
  return { connect, read, send, writes, pending, created, revoke: () => { member = false; }, remoteEdit: () => { row = { ...row, description: "Cambio remoto", version: 2 }; } };
}

async function newMovement(amount: string) {
  await press("Nuevo movimiento");
  await press("Gasto"); await press("Caja (KWD)"); await press("Comida"); await press("Tienda"); await press("Viaje");
  await enter("Importe", amount); await enter("Fecha (AAAA-MM-DD, UTC)", draft.date); await enter("Descripción", ` ${draft.description} `);
  await press("Crear movimiento");
}

test("reuses a securely persisted normalized draft after commit, lost reply and a fresh screen/API instance", async () => {
  const { connect, writes, pending, created } = setup({ loseReply: true });
  const first = await render(<TransactionsScreen api={connect()} back={jest.fn()} />);
  await newMovement(draft.amount);
  expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos guardar el movimiento. Vuelve a intentarlo.");
  expect(created.size).toBe(1); expect(pending()).toHaveLength(1);
  expect(pending()[0][0]).toMatch(new RegExp(`${workspace}.*[0-9a-f]{64}$`));
  expect(pending()[0][1]).toBe(writes[0].key);
  expect(writes[0]).toMatchObject({ method: "POST", url: path, match: null, pending: true, body: { type: "expense", accountId: account, occurredAt: "2026-11-01T00:00:00.000Z", amount: { currency: "KWD", amountMinor: "9007199254740993012" }, categoryId: category, payeeId: payee, tagIds: [tag], description: "Café nuevo" } });
  await first.unmount();
  const second = await render(<TransactionsScreen api={connect()} back={jest.fn()} />);
  await newMovement("09007199254740993.012");
  await screen.findByRole("button", { name: "Nuevo movimiento" });
  expect(writes[1]).toEqual(writes[0]); expect(created.size).toBe(1); expect(pending()).toEqual([]);
  await second.unmount();
  await render(<TransactionsScreen api={connect()} back={jest.fn()} />);
  await newMovement(draft.amount);
  await screen.findByRole("button", { name: "Nuevo movimiento" });
  expect(writes[2].key).not.toBe(writes[0].key); expect(created.size).toBe(2); expect(pending()).toEqual([]);
});

test("validates drafts and void bounds before session access and never writes with revoked membership", async () => {
  const { connect, read, send, writes, pending, revoke } = setup();
  const api = connect(); await api.formOptions(true);
  read.mockClear(); send.mockClear(); secure.getItemAsync.mockClear(); secure.setItemAsync.mockClear();
  for (const bad of [{ amount: "1.0001" }, { amount: "1e3" }, { amount: "9223372036854775.808" }, { date: "2026-02-29" }, { accountId: [account] }, { accountId: movement }, { type: "transfer" }, { tagIds: [tag, tag.toUpperCase()] }, { description: ["x"] }]) await expect(api.create({ ...draft, ...bad })).rejects.toThrow("Revisa los datos del movimiento.");
  for (const reason of ["  ab ", "x".repeat(501), ["razón"]]) await expect(api.void(movement, '"1"', reason, true)).rejects.toThrow("Escribe un motivo de 3 a 500 caracteres.");
  await expect(api.void(movement, '"1"', "motivo", false)).rejects.toThrow();
  await expect(api.update(movement, '*', { description: "Cambio" })).rejects.toThrow();
  await expect(api.update(movement, '"1"', { amount: "7" })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
  revoke(); await expect(api.create(draft)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(writes).toEqual([]); expect(pending()).toEqual([]);
  expect(send.mock.calls.map(([url, init]) => [new URL(url).pathname, new Headers(init.headers).get("X-Workspace-Id")])).toEqual([["/v1/me", null], ["/v1/workspaces", null]]);
});

test("does not submit when Secure Store cannot persist the retry key", async () => {
  const { connect, writes, created } = setup();
  const api = connect(); await api.formOptions(true);
  secure.setItemAsync.mockRejectedValueOnce(new Error("Secure Store unavailable"));
  await expect(api.create(draft)).rejects.toThrow("Secure Store unavailable");
  expect(writes).toEqual([]); expect(created.size).toBe(0);
});

test("retains a stale edit across explicit reload without resubmitting until Save", async () => {
  const { connect, writes, remoteEdit, pending } = setup();
  await render(<TransactionsScreen api={connect()} back={jest.fn()} />); await press("Café"); await press("Editar movimiento");
  await enter("Descripción", "Mi cambio"); remoteEdit(); await press("Guardar cambios");
  expect(await screen.findByRole("alert")).toHaveTextContent("El movimiento cambió. Recarga sus datos antes de volver a intentarlo.");
  expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
  await press("Recargar movimiento"); await screen.findByRole("header", { name: "Cambio remoto" });
  expect(screen.getByDisplayValue("Mi cambio")).toBeTruthy(); expect(writes).toHaveLength(1);
  await press("Guardar cambios"); await screen.findByRole("header", { name: "Mi cambio" });
  expect(writes.map(({ match, body, key }) => [match, body, key])).toEqual([['"1"', { description: "Mi cambio" }, writes[0].key], ['"2"', { description: "Mi cambio" }, writes[0].key]]);
  expect(pending()).toEqual([]);
});

test.each(["xyz", "á".repeat(500)])("voids only after explicit confirmation with a valid boundary reason, If-Match and a persisted key", async (reason) => {
  const { connect, writes, read, pending } = setup();
  await render(<TransactionsScreen api={connect()} back={jest.fn()} />); await press("Café"); await press("Anular movimiento");
  expect(writes).toEqual([]);
  const before = read.mock.calls.length;
  await enter("Motivo de anulación", "ab"); await press("Confirmar anulación");
  expect(await screen.findByRole("alert")).toHaveTextContent("Escribe un motivo de 3 a 500 caracteres."); expect(read).toHaveBeenCalledTimes(before);
  await enter("Motivo de anulación", `  ${reason}  `); await press("Confirmar anulación");
  await screen.findByText("Gasto · Anulada");
  expect(writes).toEqual([{ method: "POST", url: `${path}/${movement}/void`, key: expect.stringMatching(/^[a-f\d-]{36}$/), match: '"1"', body: { reason }, pending: true }]);
  expect(pending()).toEqual([]); expect(screen.queryByRole("button", { name: "Anular movimiento" })).toBeNull();
});
