import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createTransactions } from "../src/foundation/transactions";
import { createTransfers } from "../src/foundation/transfers";
import { createTransport } from "../src/foundation/transport";
import { TransfersScreen } from "../src/mobile-shell/transfers-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, randomUUID: require("node:crypto").randomUUID, digestStringAsync: async (_: string, input: string) => require("node:crypto").createHash("sha256").update(input).digest("hex") }));

const id = (n: number) => `abcabcab-abcd-4abc-8abc-abcdefabcde${n}`;
const [workspace, profile, source, destination, yen, other] = Array.from({ length: 6 }, (_, n) => id(n));
const transfer = { sourceAccountId: source.toUpperCase(), destinationAccountId: destination, amount: "9007199254740993,012", date: "2024-02-29", description: "  Ahorro  " };
const exchange = { ...transfer, destinationAccountId: yen.toUpperCase(), received: "037", executedRate: "00,1234567890123456780" };
const lookupCursor = Buffer.from(JSON.stringify(["2026-11-01T15:00:00.000000Z", destination])).toString("base64url");
const rate = { id: id(6), baseCurrency: "KWD", quoteCurrency: "JPY", rate: "0.123456789012345678", effectiveAt: "2026-11-01T15:00:00.000Z", source: "frankfurter", isStale: true, ageHours: 73.5 };
const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: nextCursor !== null, nextCursor } });
const secure = jest.mocked(SecureStore);
const pendingKey = (value: string) => JSON.parse(value).key;
beforeEach(() => { jest.resetAllMocks(); });
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);

function setup({ lostReply = false } = {}) {
  const store = new Map([[`savia.workspace.${profile}`, workspace]]), records = new Map<string, object>();
  const pending = () => [...store].filter(([slot]) => slot.startsWith("savia.ledger."));
  secure.getItemAsync.mockImplementation(async (slot) => store.get(slot) ?? null);
  secure.setItemAsync.mockImplementation(async (slot, value) => { store.set(slot, value); });
  secure.deleteItemAsync.mockImplementation(async (slot) => { store.delete(slot); });
  const writes: { path: string; key: string; persisted: boolean; body: unknown }[] = [];
  let member = true;
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture-bearer" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: new Headers(), redirected: false, json: async () => body });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(searchParams.has("cursor") ? page(member ? [{ id: workspace, name: "Casa" }] : []) : page([{ id: other, name: "Oficina" }], "next_ws"));
    if (headers.get("X-Workspace-Id") !== workspace) return reply({}, 403);
    if (pathname === "/v1/accounts") return reply(searchParams.has("cursor") ? page([{ id: yen, name: "Viaje", currency: "JPY", status: "active" }]) : page([
      { id: source, name: "Efectivo", currency: "KWD", status: "active" }, { id: destination, name: "Ahorros", currency: "KWD", status: "active" },
      { id: other, name: "Cerrada", currency: "KWD", status: "closed" },
    ], lookupCursor));
    if (pathname === "/v1/exchange-rates" && init.method === "GET") return reply([rate,
      { ...rate, id: id(7), source: "manual", manual: true, isStale: false, ageHours: 1 },
      { ...rate, id: id(8), source: "Proveedor", isStale: undefined, ageHours: undefined }]);
    const key = headers.get("Idempotency-Key");
    if (init.method !== "POST" || !key || !["/v1/transfers", "/v1/currency-exchanges"].includes(pathname)) return reply({}, 404);
    const body = JSON.parse(String(init.body));
    writes.push({ path: pathname, key, persisted: pending().some(([, saved]) => pendingKey(saved) === key), body });
    if (records.has(key)) return reply(records.get(key), 201);
    const result = { id: id(9), sourceAccountId: body.sourceAccountId, destinationAccountId: body.destinationAccountId };
    records.set(key, result);
    if (lostReply && records.size === 1) throw new Error("Reply lost after commit");
    return reply(result, 201);
  });
  const connect = () => {
    const scoped = createTransport({ baseUrl: "https://api.invalid", sessions: { read }, send }).requestInWorkspace;
    return createTransfers(scoped, workspace, createTransactions(scoped, workspace).transferAccounts);
  };
  return { connect, read, send, writes, pending, records, revoke: () => { member = false; } };
}

test("rejects invalid drafts, account/currency mismatches, fees and invalid rate filters with no submission I/O", async () => {
  const { connect, read, send, writes, pending } = setup();
  const api = connect(); await api.loadAccounts();
  read.mockClear(); send.mockClear(); secure.getItemAsync.mockClear(); secure.setItemAsync.mockClear();
  for (const bad of [{ destinationAccountId: source }, { destinationAccountId: yen }, { destinationAccountId: other }, { destinationAccountId: [destination] }, { fee: "1" }, { received: "1" }, { amount: "0" }, { amount: "-1.01" }, { amount: "9.0001" }, { amount: "9223372036854775.808" }, { date: "2026-02-29" }]) {
    await expect(api.submit("transfer", { ...transfer, ...bad })).rejects.toThrow("Revisa los datos de la transferencia.");
  }
  for (const bad of [{ destinationAccountId: destination }, { received: undefined }, { received: "1.1" }, { executedRate: undefined }, { executedRate: "0.000" }, { executedRate: "2e5" }, { executedRate: ["1", "2"] }]) {
    await expect(api.submit("exchange", { ...exchange, ...bad })).rejects.toThrow("Revisa los datos de la transferencia.");
  }
  for (const bad of [{ baseCurrency: ["KWD", "KWD"] }, { quoteCurrency: "ZZZ" }, { from: "2026-02-29" }, { from: "2026-11-02", to: "2026-11-01" }, { limit: "5" }, new URLSearchParams("from=2026-11-01&from=2026-11-02")]) {
    await expect(api.rates(bad)).rejects.toThrow("Revisa los filtros.");
  }
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(writes).toEqual([]); expect(pending()).toEqual([]);
});

test.each([["transfer", transfer], ["exchange", exchange]])("replays a committed %s after a lost reply, using exact independent amounts and a persisted key", async (mode, input) => {
  const { connect, writes, records, pending, send, revoke } = setup({ lostReply: true });
  const first = connect(); await first.loadAccounts();
  await expect(first.submit(mode, input)).rejects.toMatchObject({ kind: "network" });
  const dest = mode === "transfer" ? destination : yen;
  const amount = { amountMinor: "9007199254740993012", currency: "KWD" };
  const body = { sourceAccountId: source, destinationAccountId: dest, occurredAt: "2024-02-29T00:00:00.000Z", description: "Ahorro", ...(mode === "transfer" ? { amount } : { sourceAmount: amount, destinationAmount: { amountMinor: "37", currency: "JPY" }, executedRate: "0.123456789012345678" }) };
  expect(writes).toEqual([{ path: mode === "transfer" ? "/v1/transfers" : "/v1/currency-exchanges", key: expect.stringMatching(/^[a-f\d-]{36}$/), persisted: true, body }]);
  expect(records.size).toBe(1); expect(pending().map(([, value]) => pendingKey(value))).toEqual([writes[0].key]);
  const second = connect(); await second.loadAccounts();
  await expect(second.submit(mode, { ...input, amount: "09007199254740993.012", description: "Ahorro", ...(mode === "exchange" && { executedRate: "0.123456789012345678" }) })).resolves.toBe(id(9));
  expect(writes[1]).toEqual(writes[0]); expect(records.size).toBe(1); expect(pending()).toEqual([]);
  await second.submit(mode, input);
  expect(writes[2].key).not.toBe(writes[0].key); expect(records.size).toBe(2);
  revoke(); send.mockClear();
  await expect(second.submit(mode, input)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(writes).toHaveLength(3); expect(pending()).toEqual([]);
  expect(send.mock.calls.map(([url, init]) => [new URL(url).pathname, new Headers(init.headers).get("X-Workspace-Id")])).toEqual([["/v1/me", null], ["/v1/workspaces", null], ["/v1/workspaces", null]]);
});

test("offers a transfer and exchange form without fees and requires both received amount and executed rate", async () => {
  const { connect, writes } = setup();
  await render(<TransfersScreen api={connect()} back={jest.fn()} />);
  expect(await screen.findByRole("button", { name: "Origen: Efectivo (KWD)" })).toBeTruthy();
  expect(screen.queryByLabelText("Importe recibido")).toBeNull();
  await press("Cambio de moneda"); await press("Origen: Efectivo (KWD)"); await press("Destino: Viaje (JPY)");
  await enter("Importe enviado", "25,125"); await enter("Fecha (AAAA-MM-DD, UTC)", "2024-02-29");
  expect(screen.queryByLabelText(/comisión/i)).toBeNull();
  await enter("Importe recibido", "3"); await press("Registrar cambio");
  expect(await screen.findByRole("alert")).toHaveTextContent("Revisa los datos de la transferencia."); expect(writes).toEqual([]);
  await enter("Tasa ejecutada", "0.12"); await press("Registrar cambio");
  expect(await screen.findByText("Cambio de moneda registrado.")).toBeTruthy();
  expect(writes).toHaveLength(1);
});

test.each(["transfer", "exchange"])("blocks an expired %s until explicit confirmation sends the same draft with a new key", async (mode) => {
  const { connect, writes, records, pending } = setup({ lostReply: true });
  let now = Date.UTC(2026, 10, 1);
  const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  const isExchange = mode === "exchange", submit = isExchange ? "Registrar cambio" : "Registrar transferencia";
  async function fill() {
    if (isExchange) await press("Cambio de moneda");
    await press("Origen: Efectivo (KWD)"); await press(isExchange ? "Destino: Viaje (JPY)" : "Destino: Ahorros (KWD)");
    await enter("Importe enviado", "25,125"); await enter("Fecha (AAAA-MM-DD, UTC)", "2024-02-29");
    if (isExchange) { await enter("Importe recibido", "3"); await enter("Tasa ejecutada", "0.12"); }
  }
  try {
    const first = await render(<TransfersScreen api={connect()} back={jest.fn()} />);
    await fill(); await press(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos registrar la operación. Vuelve a intentarlo.");
    await first.unmount(); now += 23 * 60 * 60 * 1000 + 1;
    await render(<TransfersScreen api={connect()} back={jest.fn()} />);
    await fill(); await press(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo.");
    expect(writes).toHaveLength(1); expect(records.size).toBe(1); expect(pending()).toHaveLength(1);
    await press("Registrar de todos modos");
    expect(await screen.findByText(isExchange ? "Cambio de moneda registrado." : "Transferencia registrada.")).toBeTruthy();
    expect(writes[1].key).not.toBe(writes[0].key); expect(writes[1]).toMatchObject({ body: writes[0].body, persisted: true });
    expect(records.size).toBe(2); expect(pending()).toEqual([]); expect(screen.getByLabelText("Importe enviado")).toHaveProp("value", "");
  } finally { clock.mockRestore(); }
});

test("filters read-only rates and shows exact rate, source, effective time and available freshness", async () => {
  const { connect, writes, send, read } = setup();
  await render(<TransfersScreen api={connect()} back={jest.fn()} />); await press("Tasas de cambio");
  expect(await screen.findAllByText("1 KWD = 0.123456789012345678 JPY")).toHaveLength(3);
  expect(screen.getByText("Fuente: frankfurter")).toBeTruthy(); expect(screen.getByText("Fuente: manual (manual)")).toBeTruthy();
  expect(screen.getAllByText("Vigente desde: 2026-11-01T15:00:00.000Z")).toHaveLength(3);
  for (const text of ["Estado: Desactualizada", "Estado: Vigente", "Estado: No disponible", "Antigüedad: 73,5 h", "Antigüedad: No disponible"]) expect(screen.getByText(text)).toBeTruthy();
  const before = read.mock.calls.length;
  await enter("Moneda base", "ZZZ"); await press("Filtrar tasas");
  expect(await screen.findByRole("alert")).toHaveTextContent("Revisa los filtros."); expect(read).toHaveBeenCalledTimes(before);
  await enter("Moneda base", "kwd"); await enter("Moneda cotizada", "JPY"); await enter("Desde (AAAA-MM-DD)", "2026-11-01"); await enter("Hasta (AAAA-MM-DD)", "2026-11-02"); await press("Filtrar tasas");
  await screen.findAllByText("1 KWD = 0.123456789012345678 JPY");
  const [url, init] = send.mock.calls.filter(([url]) => url.includes("/exchange-rates")).at(-1)!;
  expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ baseCurrency: "KWD", quoteCurrency: "JPY", from: "2026-11-01", to: "2026-11-02" });
  expect([init.method, new Headers(init.headers).get("X-Workspace-Id")]).toEqual(["GET", workspace]);
  expect(writes).toEqual([]);
});
