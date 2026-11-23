import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createFunds } from "../src/foundation/funds";
import { createFundWrites } from "../src/foundation/fund-writes";
import { createTransport } from "../src/foundation/transport";
import { FundsScreen } from "../src/mobile-shell/funds-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const secure = jest.mocked(SecureStore);
const id = (n: number) => `cabc0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, fund, account, jpy, receipt] = [1, 2, 3, 4, 5, 6].map(id);
const path = "/v1/funds", detail = `${path}/${fund}`, contributions = `${detail}/contributions`, withdrawals = `${detail}/withdrawals`, hours = 3_600_000;
const targetDate = "2028-02-29", date = "2026-11-01";
const input = { name: "Viaje futuro", currency: "KWD", targetAmount: "9007199254740993,012", linkedAccountId: account.toUpperCase(), targetDate };
const contribution = { accountId: account.toUpperCase(), amount: "9007199254740993,012", date, notes: "  Aporte manual  " };
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);

function setup(live = false, tagPrefix = "") {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]);
  secure.getItemAsync.mockImplementation(async (key) => storage.get(key) ?? null);
  secure.setItemAsync.mockImplementation(async (key, value) => { storage.set(key, value); });
  secure.deleteItemAsync.mockImplementation(async (key) => { storage.delete(key); });
  const pending = () => [...storage].filter(([key]) => key.startsWith("savia.ledger."));
  const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
  const money = (amountMinor: string) => ({ amountMinor, currency: "KWD" });
  const funds = [{ id: fund, name: "Reserva", currency: "KWD", targetAmount: money("9007199254740993012"), currentAmount: money("0"), status: "active", linkedAccountId: account }];
  const replay = new Map<string, { body: object; at: number }>();
  const writes: { path: string; key: string; body: Record<string, unknown>; match: string | null; persisted: boolean }[] = [];
  let revoked = false, lose = false, invalidReceipt = false, now = Date.UTC(2026, 10, 1), online = true, version = 7, refusal = 0, detailMissing = false;
  const tag = () => `"${tagPrefix}${version}"`;
  if (live) funds[0].currentAmount = money("10000");
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    if (!online) throw new Error("Disconnected");
    const { pathname } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200, etag?: string) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(now).toUTCString(), ...(etag && { ETag: etag }), ...(status >= 400 && { "Content-Type": "application/problem+json" }) }), json: async () => body });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(page(revoked ? [] : [{ id: workspace, name: "Casa" }]));
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    const getDetail = () => ({ ...funds[0], etag: tag() });
    if (init.method === "GET") {
      if (live && pathname === detail) return detailMissing ? reply({}, 404) : reply(getDetail(), 200, tag());
      expect(pathname).toBe(path); return reply(page(funds));
    }
    expect([path, contributions, detail, withdrawals]).toContain(pathname);
    const body = JSON.parse(String(init.body)), key = headers.get("Idempotency-Key")!;
    writes.push({ path: pathname, key, body, match: headers.get("If-Match"), persisted: pending().some(([, value]) => JSON.parse(value).key === key) });
    const saved = replay.get(key);
    if (saved && now - saved.at < 24 * hours) return reply(saved.body, 201);
    if (pathname === detail) {
      expect(init.method).toBe("PATCH");
      if (headers.get("If-Match") !== tag()) return reply({}, 412);
      Object.assign(funds[0], body); version++;
      return reply(getDetail(), 200, tag());
    }
    expect(init.method).toBe("POST");
    if (pathname === withdrawals) {
      if (refusal) return reply(refusal === 422 ? { type: "https://savia.app/problems/insufficient-fund-balance" } : {}, refusal);
      funds[0].currentAmount = money(String(BigInt(funds[0].currentAmount.amountMinor) - BigInt(body.amount.amountMinor)));
      const result = { id: receipt, accountId: body.accountId, type: "adjustment", status: "confirmed", amount: body.amount, notes: body.reason };
      replay.set(key, { body: result, at: now });
      if (lose) { lose = false; throw new Error("Reply lost after commit"); }
      return reply(result, 201);
    }
    let result;
    if (pathname === path) {
      result = { ...body, id: id(funds.length + 6), currentAmount: money("0"), status: "active" };
      funds.push(result);
    } else {
      const minor = BigInt(body.amount.amountMinor);
      expect(minor > 0n).toBe(true);
      funds[0] = { ...funds[0], currentAmount: money(String(BigInt(funds[0].currentAmount.amountMinor) + minor)) };
      result = { id: receipt, accountId: body.accountId, type: "fund_contribution", status: "confirmed", amount: money(String(-minor)), occurredAt: body.occurredAt };
    }
    replay.set(key, { body: result, at: now });
    if (lose) { lose = false; throw new Error("Reply lost after commit"); }
    if (invalidReceipt) { invalidReceipt = false; return reply({ ...result, amount: money("1") }, 201); }
    return reply(result, 201);
  });
  const request = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace;
  const connect = () => createFundWrites(request, workspace, async () => [{ id: account, name: "Caja", currency: "KWD" }, { id: jpy, name: "Yenes", currency: "JPY" }]);
  return { api: createFunds(request, workspace, live ? request : undefined), connect, writes, pending, replay, read, send,
    refuse: (status: number) => { refusal = status; }, missingDetail: () => { detailMissing = true; }, bump: () => { version++; funds[0].name = "Reserva actualizada"; },
    lose: () => { lose = true; }, corrupt: () => { invalidReceipt = true; },
    revoke: () => { revoked = true; }, advance: (ms: number) => { now += ms; }, disconnect: () => { online = false; } };
}

test("rejects malformed creates and nonpositive, invalid or wrong-currency contributions before session and storage", async () => {
  const f = setup(), api = f.connect(); await api.loadAccounts();
  for (const bad of [{ currency: ["KWD"] }, { currency: "ZZZ" }, { targetAmount: "0" }, { targetAmount: "-1" }, { targetAmount: "9223372036854775,808" },
    { name: "\0" }, { name: "x".repeat(121) }, { targetDate: "2026-02-29" }, { linkedAccountId: [account] }, { status: "active" }]) {
    await expect(api.create({ ...input, ...bad })).rejects.toThrow("Revisa los datos del fondo.");
  }
  for (const bad of [{ amount: "-1" }, { amount: "-0" }, { amount: "0,000" }, { amount: ["1"] }, { amount: "1e3" }, { amount: "1,0001" },
    { accountId: jpy }, { accountId: fund }, { date: "2026-02-29" }, { notes: "a".repeat(501) }, { withdrawal: true }]) {
    await expect(api.contribute(fund, "KWD", { ...contribution, ...bad })).rejects.toThrow("Revisa los datos del aporte.");
  }
  await expect(api.contribute([fund], "KWD", contribution)).rejects.toThrow("Revisa los datos del aporte.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]); expect(f.pending()).toEqual([]);
});

test("creates a fund with exact units and shows it through the list, with no If-Match", async () => {
  const f = setup(), writer = f.connect();
  await render(<FundsScreen api={f.api} writes={writer} back={jest.fn()} />); await press("Nuevo fondo");
  await enter("Nombre", "  Viaje futuro  "); await enter("Moneda (ej. COP)", "kwd"); await enter("Importe objetivo", input.targetAmount);
  await enter("Fecha objetivo (AAAA-MM-DD)", targetDate); await press("Cuenta: Caja (KWD)"); await press("Crear fondo");
  expect(await screen.findByRole("header", { name: "Viaje futuro" })).toBeTruthy();
  expect(f.writes[0]).toMatchObject({ path, match: null, persisted: true, body: { name: input.name, currency: "KWD",
    targetAmount: { currency: "KWD", amountMinor: "9007199254740993012" }, targetDate, linkedAccountId: account } });
  f.send.mockClear(); f.revoke(); await expect(writer.create(input)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]); expect(f.writes).toHaveLength(1);
});

test("sends only a positive manual contribution from a matching account and refreshes the saved balance", async () => {
  const f = setup();
  await render(<FundsScreen api={f.api} writes={f.connect()} back={jest.fn()} />); await press("Reserva"); await press("Agregar aporte");
  await press("Cuenta: Caja (KWD)"); expect(screen.queryByRole("button", { name: "Cuenta: Yenes (JPY)" })).toBeNull();
  await enter("Importe del aporte", contribution.amount); await enter("Fecha (AAAA-MM-DD, UTC)", date); await enter("Notas (opcional)", contribution.notes);
  await press("Registrar aporte"); expect(await screen.findByText("Ahorrado: 9007199254740993,012 KWD")).toBeTruthy();
  expect(f.writes[0]).toMatchObject({ path: contributions, match: null, persisted: true, body: { accountId: account,
    amount: { currency: "KWD", amountMinor: "9007199254740993012" }, occurredAt: `${date}T00:00:00.000Z`, notes: "Aporte manual" } });
  expect(f.pending()).toEqual([]);
});

test.each(["create", "contribution"])("%s reuses the persisted key after a lost reply and a fresh API instance", async (kind) => {
  const f = setup(), first = f.connect(); await first.loadAccounts(); f.lose();
  const submit = (api: ReturnType<typeof createFundWrites>) => kind === "create" ? api.create(input) : api.contribute(fund, "KWD", contribution);
  await expect(submit(first)).rejects.toThrow(); expect(f.replay.size).toBe(1); expect(f.pending()).toHaveLength(1);
  const reopened = f.connect(); await reopened.loadAccounts(); await expect(submit(reopened)).resolves.toBe(kind === "create" ? id(7) : receipt);
  expect(f.writes[1]).toEqual(f.writes[0]); expect(f.replay.size).toBe(1); expect(f.pending()).toEqual([]);
});

test("blocks an expired contribution on server time despite device correction, then confirms with a new key", async () => {
  const f = setup(), writer = f.connect(); await writer.loadAccounts(); f.lose();
  const clock = jest.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 1) + 3 * hours);
  try {
    await expect(writer.contribute(fund, "KWD", contribution)).rejects.toThrow();
    f.advance(25 * hours); clock.mockReturnValue(Date.UTC(2026, 10, 1) + 25 * hours);
    const warning = await writer.contribute(fund, "KWD", contribution).catch((error) => error);
    expect(warning.message).toMatch(/^Puede que este movimiento ya se haya registrado\./);
    expect(f.writes).toHaveLength(1); expect(f.pending()).toHaveLength(1);
    await expect(writer.contribute(fund, "KWD", contribution, warning)).resolves.toBe(receipt);
    expect(f.writes[1].key).not.toBe(f.writes[0].key); expect(f.writes[1].body).toEqual(f.writes[0].body);
  } finally { clock.mockRestore(); }
});

test("retains the key after an invalid contribution receipt and does not queue a new offline write", async () => {
  const f = setup(), writer = f.connect(); await writer.loadAccounts(); f.corrupt();
  await expect(writer.contribute(fund, "KWD", contribution)).rejects.toThrow(); expect(f.pending()).toHaveLength(1);
  await expect(writer.contribute(fund, "KWD", contribution)).resolves.toBe(receipt);
  expect(f.writes[0]).toEqual(f.writes[1]); expect(f.replay.size).toBe(1);
  f.disconnect(); await expect(writer.create(input)).rejects.toThrow(/Necesitas conexión/);
  expect(f.pending()).toEqual([]); expect(f.writes).toHaveLength(2);
});

// Reviewer regression (verify mwr9bsco). Append to __tests__/fund-writes.test.tsx.
test.each(["create", "contribution"])(
  "%s uses a single approval and rechecks server age after its reply is lost",
  async (kind) => {
    const f = setup(), writer = f.connect();
    await writer.loadAccounts();
    const send = (confirmation?: Parameters<typeof writer.create>[1]) =>
      kind === "create" ? writer.create(input, confirmation)
        : writer.contribute(fund, "KWD", contribution, confirmation);

    f.lose();
    await expect(send()).rejects.toThrow(/Necesitas conexión/);

    f.advance(23 * hours);
    const first = await send().catch(error => error);
    expect(first.message).toMatch(/^Puede que este movimiento/);

    f.lose();
    await expect(send(first)).rejects.toThrow(/Necesitas conexión/);
    expect(f.writes).toHaveLength(2);
    expect(new Set(f.writes.map(({ key }) => key)).size).toBe(2);
    expect(f.writes.every(({ persisted }) => persisted)).toBe(true);

    f.advance(23 * hours);
    await expect(send(first)).rejects.toThrow("Pending submission changed");
    const second = await send().catch(error => error);
    expect(second.message).toBe(first.message);

    f.advance(2 * hours);
    await expect(send()).rejects.toThrow(first.message);
    expect(f.writes).toHaveLength(2);
    expect(f.replay.size).toBe(2);

    await expect(send(second)).resolves.toEqual(expect.any(String));
    expect(new Set(f.writes.map(({ key }) => key)).size).toBe(3);
    expect(f.pending()).toEqual([]);
  },
);

test("an older backend without fund detail still shows the verified list-derived fund and contribution", async () => {
  const f = setup(true); f.missingDetail();
  await render(<FundsScreen api={f.api} writes={f.connect()} back={jest.fn()} />);
  await press("Reserva"); await screen.findByRole("header", { name: "Reserva" });
  expect(screen.getByRole("button", { name: "Agregar aporte" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Editar fondo|Retirar del fondo/ })).toBeNull();
});

test("edits from the verified fund detail ETag and refreshes a stale edit without resubmitting", async () => {
  const f = setup(true, "fund-");
  await render(<FundsScreen api={f.api} writes={f.connect()} back={jest.fn()} />);
  await press("Reserva"); await press("Editar fondo");
  expect(f.send.mock.calls.some(([url]) => new URL(url).pathname === detail)).toBe(true);
  await enter("Nombre", "  Nuevo nombre  "); f.bump(); await press("Guardar cambios del fondo");
  await screen.findByText("El fondo cambió. Revisa los datos actualizados.");
  expect((await screen.findByLabelText("Nombre")).props.value).toBe("Reserva actualizada");
  expect(f.writes).toEqual([{ path: detail, key: expect.any(String), match: '"fund-7"', persisted: false, body: { name: "Nuevo nombre" } }]);
  await enter("Nombre", "Nuevo nombre"); await press("Guardar cambios del fondo");
  await screen.findByRole("header", { name: "Nuevo nombre" });
  expect(f.writes[1]).toMatchObject({ path: detail, key: expect.any(String), match: '"fund-8"', body: { name: "Nuevo nombre" } });
  expect(f.writes[1].key).not.toBe(f.writes[0].key); expect(f.pending()).toEqual([]);
});

test("withdrawal validates before dispatch, reuses a lost-response key and never persists its reason", async () => {
  const f = setup(true);
  await render(<FundsScreen api={f.api} writes={f.connect()} back={jest.fn()} />);
  await press("Reserva"); await press("Retirar del fondo"); await press("Cuenta: Caja (KWD)");
  expect(screen.queryByRole("button", { name: "Cuenta: Yenes (JPY)" })).toBeNull();
  await enter("Importe del retiro", "1,250"); f.read.mockClear(); f.send.mockClear(); secure.setItemAsync.mockClear();
  await press("Registrar retiro"); await screen.findByText("Revisa los datos del retiro.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  await enter("Motivo del retiro", "  Reparación  "); f.lose(); await press("Registrar retiro");
  await screen.findByText(/Necesitas conexión/);
  await press("Registrar retiro"); await screen.findByText("Ahorrado: 8,750 KWD");
  expect(f.writes).toEqual([expect.objectContaining({ path: withdrawals, key: expect.any(String), match: null, persisted: true,
    body: { accountId: account, amount: { amountMinor: "1250", currency: "KWD" }, reason: "Reparación" } }), f.writes[0]]);
  expect(f.replay.size).toBe(1); expect(f.pending()).toEqual([]);
  expect(secure.setItemAsync).toHaveBeenCalledTimes(1);
  expect(JSON.parse(secure.setItemAsync.mock.calls[0][1])).toEqual({ key: f.writes[0].key, createdAt: Date.UTC(2026, 10, 1), clock: "server" });
});

test.each([409, 422])("a refused withdrawal (%s) shows a Spanish error without changing the fund", async (status) => {
  const f = setup(true); f.refuse(status);
  await render(<FundsScreen api={f.api} writes={f.connect()} back={jest.fn()} />);
  await press("Reserva"); await press("Retirar del fondo"); await press("Cuenta: Caja (KWD)");
  await enter("Importe del retiro", "100"); await enter("Motivo del retiro", "Reparación"); await press("Registrar retiro");
  expect(await screen.findByRole("alert")).toHaveTextContent(status === 409 ? "El retiro supera el saldo ahorrado del fondo." : "El fondo no tiene saldo suficiente para este retiro.");
  expect(f.replay.size).toBe(0); expect(f.pending()).toEqual([]);
  await press("Volver al fondo"); await screen.findByText("Ahorrado: 10,000 KWD");
});

// Reviewer regression (verify mwtr0ep1). __tests__/fund-writes.test.tsx (append).
test("a withdrawal retried after reopening the app cannot debit twice", async () => {
  const f = setup(true), first = f.connect();
  const draft = { accountId: account, amount: "1,250", reason: "Reparación urgente" };
  await first.loadAccounts();
  f.lose();
  await expect(first.withdraw(fund, "KWD", draft)).rejects.toThrow(/Necesitas conexión/);
  expect((await f.api.detail(fund))?.saved).toBe("8,750 KWD");
  expect(f.replay.size).toBe(1);

  const reopened = f.connect();
  await reopened.loadAccounts();
  await reopened.withdraw(fund, "KWD", { ...draft, amount: "01.250" });
  expect(JSON.stringify(secure.setItemAsync.mock.calls)).not.toContain(draft.reason);
  expect({
    effects: f.replay.size,
    saved: (await f.api.detail(fund))?.saved,
    keys: new Set(f.writes.map(({ key }) => key)).size,
  }).toEqual({ effects: 1, saved: "8,750 KWD", keys: 1 });
});

test.each([401, 403])("fund detail does not downgrade a %s to a legacy list lookup", async (status) => {
  const f = setup(true), normal = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) => {
    const response = await normal(url, init);
    return new URL(url).pathname === detail ? { ...response, ok: false, status } : response;
  });
  await expect(f.api.detail(fund)).rejects.toMatchObject({ status });
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname))
    .toEqual(["/v1/me", "/v1/workspaces", detail]);
  expect(f.writes).toEqual([]);
});

test("an expired opaque withdrawal retry after reopen preserves the balance until explicitly confirmed", async () => {
  const f = setup(true), first = f.connect();
  const draft = { accountId: account, amount: "1,250", reason: "Reparación urgente" };
  await first.loadAccounts(); f.lose();
  await expect(first.withdraw(fund, "KWD", draft)).rejects.toThrow(/Necesitas conexión/);
  const { key, body } = f.writes[0];
  const hash = require("node:crypto").createHash("sha256").update(JSON.stringify(["POST", withdrawals, body])).digest("hex");
  const expectedSlot = [`savia.ledger.v1.${workspace}.${profile}.${hash}`, JSON.stringify({ key, createdAt: Date.UTC(2026, 10, 1), clock: "server" })];
  expect(f.pending()).toEqual([expectedSlot]);
  const reopened = f.connect(); await reopened.loadAccounts(); f.advance(23 * hours);
  const warning = await reopened.withdraw(fund, "KWD", draft).catch((error) => error);
  expect(warning.message).toBe("Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo.");
  expect(f.writes).toHaveLength(1); expect(f.pending()).toEqual([expectedSlot]); expect(f.replay.size).toBe(1);
  expect((await f.api.detail(fund))?.saved).toBe("8,750 KWD");
  await reopened.withdraw(fund, "KWD", draft, warning);
  expect(f.writes[1]).toMatchObject({ body, persisted: true }); expect(f.writes[1].key).not.toBe(key);
  expect(f.pending()).toEqual([]); expect(f.replay.size).toBe(2);
  expect((await f.api.detail(fund))?.saved).toBe("7,500 KWD");
});
