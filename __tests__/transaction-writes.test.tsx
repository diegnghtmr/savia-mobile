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
const pendingKey = (value: string) => value.startsWith("{") ? JSON.parse(value).key : value;
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
  let member = true, membershipDate: string | null | undefined;
  let row = { id: movement, type: "expense", status: "confirmed", accountId: account, amount: { currency: "KWD", amountMinor: "2500" }, occurredAt: "2026-11-01T15:00:00Z", description: "Café", version: 1 };
  const writes: { method: string; url: string; key: string | null; match: string | null; body: unknown; pending: boolean }[] = [];
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture-bearer" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url), headers = new Headers(init.headers);
    const reply = (data: unknown, status = 200, etag?: string) => ({ status, ok: status < 300, redirected: false, headers: new Headers(etag ? { ETag: etag } : {}), json: async () => data });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") {
      const response = reply(page(member ? [{ id: workspace, name: "Casa" }] : []));
      if (membershipDate !== null) response.headers.set("Date", membershipDate ?? new Date(Date.now()).toUTCString());
      return response;
    }
    if (headers.get("X-Workspace-Id") !== workspace) return reply({}, 403);
    if (init.method === "GET") {
      if (pathname === path) return reply(page([row]));
      if (pathname.startsWith(path)) return reply(row, 200, `"${row.version}"`);
      return reply(page(({ "/v1/accounts": [{ id: account, name: "Caja", status: "active", currency: "KWD" }], "/v1/categories": [{ id: category, name: "Comida" }], "/v1/payees": [{ id: payee, name: "Tienda" }], "/v1/tags": [{ id: tag, name: "Viaje" }] })[pathname as "/v1/accounts"] ?? []));
    }
    const key = headers.get("Idempotency-Key"), match = headers.get("If-Match"), body = JSON.parse(String(init.body));
    writes.push({ method: init.method!, url: pathname, key, match, body, pending: pending().some(([, value]) => pendingKey(value) === key) });
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
  return { connect, read, send, writes, pending, created, setMembershipDate: (value: string | null) => { membershipDate = value; }, revoke: () => { member = false; }, remoteEdit: () => { row = { ...row, description: "Cambio remoto", version: 2 }; } };
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
  expect(pendingKey(pending()[0][1])).toBe(writes[0].key);
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
  expect(writes.map(({ match, body }) => [match, body])).toEqual([['"1"', { description: "Mi cambio" }], ['"2"', { description: "Mi cambio" }]]);
  expect(writes[1].key).not.toBe(writes[0].key);
  expect(pending().map(([, value]) => pendingKey(value))).toEqual([writes[0].key]);
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

// Reviewer regressions (verify mwr473ba, M4 FAIL). Append to __tests__/transaction-writes.test.tsx.
const replayReply = (body: unknown, status: number, etag?: string) => ({
  status, ok: status < 300, redirected: false,
  headers: new Headers(etag ? { ETag: etag } : {}), json: async () => body,
});

test.each(["lost reply", "interrupted clear"])("does not duplicate a committed create after the replay window: %s", async (failure) => {
  const { connect, send } = setup();
  const normal = send.getMockImplementation()!;
  const committed: string[] = [];
  const replay = new Map<string, { at: number; id: string }>();
  let now = Date.UTC(2026, 10, 1);
  const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  try {
    send.mockImplementation(async (url, init) => {
      if (new URL(url).pathname !== path || init.method !== "POST") return normal(url, init);
      const key = new Headers(init.headers).get("Idempotency-Key")!;
      const entry = replay.get(key);
      // Matches the backend's strictly-newer-than-24-hours replay rule.
      if (entry && now - entry.at < 24 * 60 * 60 * 1000) return replayReply({ id: entry.id }, 201);
      const saved = { id: id(7 + committed.length), at: now };
      committed.push(saved.id); replay.set(key, saved);
      if (committed.length === 1 && failure === "lost reply") throw new Error("Reply lost after commit");
      return replayReply({ id: saved.id }, 201);
    });
    if (failure === "interrupted clear") secure.deleteItemAsync.mockRejectedValueOnce(new Error("Stopped before clearing the vault"));
    const first = connect(); await first.formOptions(true);
    await expect(first.create(draft)).rejects.toThrow();
    expect(committed).toEqual([id(7)]);

    now += 25 * 60 * 60 * 1000;
    const reopened = connect(); await reopened.formOptions(true);
    await reopened.create(draft).catch(() => undefined);
    expect(committed).toEqual([id(7)]);
  } finally { clock.mockRestore(); }
});

test("saving the same fields on a newer ETag does not replay an older committed edit", async () => {
  const { connect, send } = setup();
  const normal = send.getMockImplementation()!;
  const change = { description: "Mi cambio" };
  const urlPath = path + "/" + movement;
  let row = { id: movement, type: "expense", status: "confirmed", accountId: account,
    amount: { currency: "KWD", amountMinor: "2500" }, occurredAt: "2026-11-01T15:00:00Z", description: "Café", version: 1 };
  const replay = new Map<string, typeof row>();
  send.mockImplementation(async (url, init) => {
    if (new URL(url).pathname !== urlPath) return normal(url, init);
    if (init.method === "GET") return replayReply(row, 200, '"' + row.version + '"');
    const headers = new Headers(init.headers);
    const key = headers.get("Idempotency-Key")!;
    const saved = replay.get(key);
    if (saved) return replayReply(saved, 200, '"' + saved.version + '"');
    if (headers.get("If-Match") !== '"' + row.version + '"') return replayReply({}, 412);
    row = { ...row, ...JSON.parse(String(init.body)), version: row.version + 1 };
    replay.set(key, row);
    if (row.version === 2) throw new Error("Reply lost after commit");
    return replayReply(row, 200, '"' + row.version + '"');
  });
  await expect(connect().update(movement, '"1"', change)).rejects.toThrow();
  expect(row).toMatchObject({ ...change, version: 2 });
  row = { ...row, description: "Cambio remoto posterior", version: 3 };

  const reopened = connect();
  const latest = await reopened.detail(movement);
  expect(latest.editable?.etag).toBe('"3"');
  await expect(reopened.update(movement, latest.editable!.etag, change)).resolves.toBe(movement);
  expect(row).toMatchObject({ ...change, version: 4 });
  expect(replay.size).toBe(2);
});

const expiredWarning = "Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo.";
const hours23 = 23 * 60 * 60 * 1000;

test("prompts at exactly 23 server hours and creates a fresh key only on explicit confirmation", async () => {
  const { connect, writes, pending, created, setMembershipDate } = setup({ loseReply: true });
  setMembershipDate(new Date(Date.UTC(2026, 10, 1)).toUTCString());
  const first = await render(<TransactionsScreen api={connect()} back={jest.fn()} />);
  await newMovement(draft.amount);
  expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos guardar el movimiento. Vuelve a intentarlo.");
  await first.unmount();
  setMembershipDate(new Date(Date.UTC(2026, 10, 1) + hours23).toUTCString());
  await render(<TransactionsScreen api={connect()} back={jest.fn()} />);
  await newMovement(draft.amount);
  expect(await screen.findByRole("alert")).toHaveTextContent(expiredWarning);
  expect(writes).toHaveLength(1); expect(pending()).toHaveLength(1); expect(created.size).toBe(1);
  await press("Registrar de todos modos"); await screen.findByRole("button", { name: "Nuevo movimiento" });
  expect(writes).toHaveLength(2); expect(writes[1].key).not.toBe(writes[0].key);
  expect(writes[1]).toMatchObject({ body: writes[0].body, pending: true });
  expect(pending()).toEqual([]); expect(created.size).toBe(2);
});

test("replays just below 23 server hours without extending the original timestamp", async () => {
  const { connect, writes, pending, created, setMembershipDate } = setup({ loseReply: true });
  const start = Date.UTC(2026, 10, 1);
  const clock = jest.spyOn(Date, "now").mockReturnValue(start + 2 * hours23);
  setMembershipDate(new Date(start).toUTCString());
  try {
    const api = connect(); await api.formOptions(true);
    await expect(api.create(draft)).rejects.toThrow();
    expect(JSON.parse(pending()[0][1])).toMatchObject({ key: writes[0].key, createdAt: start });
    setMembershipDate(new Date(start + hours23 - 1000).toUTCString());
    await api.create(draft);
    expect(writes[1]).toEqual(writes[0]); expect(created.size).toBe(1); expect(pending()).toEqual([]);
    expect(secure.setItemAsync).toHaveBeenCalledTimes(1);
  } finally { clock.mockRestore(); }
});

test("does not silently resend pre-upgrade records whose age or original precondition is unknown", async () => {
  const { connect, writes, pending } = setup();
  const endpoint = `${path}/${movement}`, body = { description: "Mi cambio" };
  const hash = require("node:crypto").createHash("sha256").update(JSON.stringify(["PATCH", endpoint, body])).digest("hex");
  await secure.setItemAsync(`savia.ledger.v1.${workspace}.${profile}.${hash}`, id(7));
  await expect(connect().update(movement, '"1"', body)).rejects.toThrow(expiredWarning);
  expect(writes).toEqual([]); expect(pending().map(([, value]) => value)).toEqual([id(7)]);
});

test("a void retry against a newer precondition gets a new key", async () => {
  const { connect, writes, remoteEdit } = setup();
  const api = connect(); remoteEdit();
  await expect(api.void(movement, '"1"', "motivo", true)).rejects.toMatchObject({ status: 412 });
  await expect(api.void(movement, '"2"', "motivo", true)).resolves.toBe(movement);
  expect(writes.map(({ match, body }) => [match, body])).toEqual([['"1"', { reason: "motivo" }], ['"2"', { reason: "motivo" }]]);
  expect(writes[1].key).not.toBe(writes[0].key);
});

test.each([
  [null, "Sun, 01 Nov 2026 00:00:00 GMT"], ["invalid", "Sun, 01 Nov 2026 00:00:00 GMT"],
  ["Sun, 01 Nov 2026 00:00:00 GMT", null], ["Sun, 01 Nov 2026 00:00:00 GMT", "0"],
  ["Sun, 01 Nov 2026 00:00:00 GMT", "Sat, 31 Oct 2026 23:59:59 GMT"],
])("does not replay with unusable membership dates: %s, %s", async (first, retry) => {
  const { connect, writes, pending, created, setMembershipDate } = setup({ loseReply: true });
  const api = connect(); await api.formOptions(true);
  setMembershipDate(first);
  await expect(api.create(draft)).rejects.toMatchObject({ kind: "network" });
  const original = pending();
  setMembershipDate(retry);
  await expect(api.create(draft)).rejects.toThrow(expiredWarning);
  expect(writes).toHaveLength(1); expect(created.size).toBe(1); expect(pending()).toEqual(original);
});

test("treats pre-upgrade device timestamps as unknown", async () => {
  const { connect, writes, pending, created } = setup({ loseReply: true });
  const api = connect(); await api.formOptions(true);
  await expect(api.create(draft)).rejects.toMatchObject({ kind: "network" });
  const [[slot]] = pending();
  const record = JSON.stringify({ key: writes[0].key, createdAt: Date.now() });
  await secure.setItemAsync(slot, record);
  await expect(api.create(draft)).rejects.toThrow(expiredWarning);
  expect(writes).toHaveLength(1); expect(created.size).toBe(1); expect(pending()).toEqual([[slot, record]]);
});

// Reviewer regression (verify mwr5qq51). Append to __tests__/transaction-writes.test.tsx.
test("a device clock correction cannot silently replay a create after the server window", async () => {
  const { connect, send } = setup();
  const normal = send.getMockImplementation()!;
  const hour = 60 * 60 * 1000;
  let serverNow = Date.UTC(2026, 10, 1, 8);
  let deviceNow = serverNow + 3 * hour;
  const clock = jest.spyOn(Date, "now").mockImplementation(() => deviceNow);
  const committed: string[] = [];
  const replay = new Map<string, { at: number; id: string }>();
  let postCount = 0;
  try {
    send.mockImplementation(async (url, init) => {
      const stamp = new Date(serverNow).toUTCString();
      if (new URL(url).pathname !== path || init.method !== "POST") {
        const response = await normal(url, init);
        response.headers.set("Date", stamp);
        return response;
      }
      postCount++;
      const token = new Headers(init.headers).get("Idempotency-Key")!;
      const previous = replay.get(token);
      const reply = (row: { id: string }) => ({ status: 201, ok: true, redirected: false,
        headers: new Headers({ Date: stamp }), json: async () => ({ id: row.id }) });
      if (previous && serverNow - previous.at < 24 * hour) return reply(previous);
      const current = { at: serverNow, id: id(7 + committed.length) };
      replay.set(token, current); committed.push(current.id);
      if (committed.length === 1) throw new Error("Reply lost after commit");
      return reply(current);
    });
    const first = connect(); await first.formOptions(true);
    await expect(first.create(draft)).rejects.toMatchObject({ kind: "network" });
    expect(committed).toEqual([id(7)]);
    serverNow += 25 * hour;
    deviceNow = serverNow; // Corrected: only 22 hours elapsed on the device clock.
    const reopened = connect(); await reopened.formOptions(true);
    const outcome = await reopened.create(draft).then(() => "resolved", (error: Error) => error.message);
    expect({ committed, postCount, outcome }).toEqual({ committed: [id(7)], postCount: 1,
      outcome: "Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo." });
  } finally { clock.mockRestore(); }
});
