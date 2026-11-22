import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createBudgets } from "../src/foundation/budgets";
import { createBudgetWrites } from "../src/foundation/budget-writes";
import { createTransport } from "../src/foundation/transport";
import { BudgetsScreen } from "../src/mobile-shell/budgets-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const secure = jest.mocked(SecureStore);
const id = (n: number) => `acdeb000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, budget, copy, category, target] = [1, 2, 3, 4, 5, 6].map(id);
const path = "/v1/budgets", detail = `${path}/${budget}`, hours = 3_600_000;
const input = { name: "Casa", method: "cash_flow", periodStart: "2026-01-01", periodEnd: "2026-02-01" };
const allocation = { categoryId: category.toUpperCase(), planned: "9007199254740993,012", rolloverPolicy: "to_category", rolloverTargetId: target.toUpperCase() };
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);

function setup() {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]);
  secure.getItemAsync.mockImplementation(async (key) => storage.get(key) ?? null);
  secure.setItemAsync.mockImplementation(async (key, value) => { storage.set(key, value); });
  secure.deleteItemAsync.mockImplementation(async (key) => { storage.delete(key); });
  const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
  let current = { id: budget, ...input, currency: "KWD", allocations: [], version: 1 }, lose = false, member = true, now = Date.UTC(2026, 0, 1);
  const replay = new Map<string, { result: typeof current; at: number }>(), created = new Map<string, typeof current>();
  const posts: { method: string; path: string; key: string; match: string | null; body: object; saved: boolean }[] = [];
  const session = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  const send = jest.fn(async (url: string, options: RequestInit) => {
    const name = new URL(url).pathname, headers = new Headers(options.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(now).toUTCString(), ETag: `"${current.version}"` }), json: async () => body });
    if (name === "/v1/me") return reply({ id: profile });
    if (name === "/v1/workspaces") return reply(page(member ? [{ id: workspace, name: "Casa" }] : []));
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (options.method === "GET") {
      const row = created.get(name);
      return reply(name === path ? page([current, ...created.values()]) : row ?? current);
    }
    const key = headers.get("Idempotency-Key")!, match = headers.get("If-Match"), body = JSON.parse(String(options.body));
    posts.push({ method: options.method!, path: name, key, match, body,
      saved: [...storage.values()].some((raw) => raw.startsWith("{") && JSON.parse(raw).key === key) });
    const previous = replay.get(key), status = name === path ? 201 : 200;
    if (previous && now - previous.at < 24 * hours) return reply(previous.result, status);
    if (name !== path && match !== `"${current.version}"`) return reply({}, 412);
    const result = name === path ? { ...current, ...body, id: copy, version: 1 } : (current = { ...current, ...(name === detail && body), version: current.version + 1 });
    if (name === path) created.set(`${path}/${result.id}`, result);
    replay.set(key, { result, at: now });
    if (lose) { lose = false; throw new Error("Reply lost after commit"); }
    return reply(result, status);
  });
  const request = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read: session } }).requestInWorkspace;
  const api = createBudgets(request, workspace, async () => new Map([[category, "Mercado"], [target, "Hogar"]]));
  const connect = () => createBudgetWrites(request, workspace);
  return { connect, api, send, session, posts, replay, lose: () => { lose = true; }, advance: (ms: number) => { now += ms; },
    remote: () => { current = { ...current, name: "Remoto", version: current.version + 1 }; }, revoke: () => { member = false; }, current: () => current };
}

test("rejects malformed creates, copies, original versions and allocations before any session or vault work", async () => {
  const { connect, session, send, posts } = setup(), api = connect();
  for (const change of [{ name: ["Casa"] }, { name: " ".repeat(121) }, { name: "x".repeat(121) }, { method: "other" },
    { periodStart: "2026-02-29" }, { periodEnd: input.periodStart }, { periodEnd: "2027-01-03" }, { copyFromBudgetId: [budget] }, { currency: "KWD" }]) {
    await expect(api.create({ ...input, ...change })).rejects.toThrow("Revisa los datos del presupuesto.");
  }
  for (const tag of ['W/"1"', "*", '"1", "2"', '"0"', ['"1"']]) await expect(api.update(budget, tag, { name: "X" })).rejects.toThrow();
  for (const rows of [[allocation, { ...allocation, categoryId: category }], [{ ...allocation, planned: "1e2" }], [{ ...allocation, planned: "1,0001" }],
    [{ ...allocation, rolloverTargetId: "" }], [{ ...allocation, rolloverPolicy: "to_fund" }], [{ ...allocation, rolloverPolicy: "none" }]]) {
    await expect(api.replace(budget, '"1"', "KWD", rows)).rejects.toThrow("Revisa las asignaciones.");
  }
  expect(session).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled();
  expect(secure.setItemAsync).not.toHaveBeenCalled(); expect(secure.deleteItemAsync).not.toHaveBeenCalled(); expect(posts).toEqual([]);
});

test("copies from detail, sends only contract fields and checks membership before each write", async () => {
  const f = setup(), writes = f.connect();
  await render(<BudgetsScreen api={f.api} writes={writes} back={jest.fn()} />); await press("Casa");
  await press("Copiar a un nuevo presupuesto");
  await enter("Nombre", "  Casa de febrero  "); await enter("Inicio (AAAA-MM-DD)", "2026-02-01"); await enter("Fin (AAAA-MM-DD)", "2026-03-01");
  await press("Crear presupuesto");
  expect(await screen.findByRole("header", { name: "Casa de febrero" })).toBeTruthy();
  expect(f.posts[0]).toMatchObject({ method: "POST", path, match: null, saved: true,
    body: { name: "Casa de febrero", method: "cash_flow", periodStart: "2026-02-01", periodEnd: "2026-03-01", copyFromBudgetId: budget } });
  f.revoke(); f.send.mockClear();
  await expect(writes.create(input)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]); expect(f.posts).toHaveLength(1);
});

test("replays against the original If-Match and uses a distinct key for an explicit edit of a newer version", async () => {
  const f = setup(), update = { name: "Revisado" };
  f.lose(); await expect(f.connect().update(budget.toUpperCase(), '"1"', update)).rejects.toThrow();
  f.remote(); expect(f.current().version).toBe(3);
  await expect(f.connect().update(budget, '"1"', update)).resolves.toBe(budget);
  expect(f.posts[1]).toEqual(f.posts[0]); expect(f.current()).toMatchObject({ version: 3, name: "Remoto" });
  await expect(f.connect().update(budget, '"3"', update)).resolves.toBe(budget);
  expect(f.posts[2]).toMatchObject({ method: "PATCH", match: '"3"', body: update, saved: true });
  expect(f.posts[2].key).not.toBe(f.posts[0].key); expect(f.current()).toMatchObject({ version: 4, name: "Revisado" });
});

test("keeps a stale edit draft and does not automatically resubmit against the newer version", async () => {
  const f = setup();
  await render(<BudgetsScreen api={f.api} writes={f.connect()} back={jest.fn()} />);
  await press("Casa"); await press("Editar presupuesto"); await enter("Nombre", "Conservar el cambio");
  f.remote(); await press("Guardar cambios");
  expect(await screen.findByText("El presupuesto cambió. Vuelve al detalle antes de editarlo.")).toBeTruthy();
  expect(screen.getByDisplayValue("Conservar el cambio")).toBeTruthy(); expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
  expect(f.posts).toHaveLength(1); expect(f.posts[0]).toMatchObject({ match: '"1"', body: { name: "Conservar el cambio" } });
  expect(f.current()).toMatchObject({ name: "Remoto", version: 2 });
});

test("replaces allocations atomically in exact minor units, including a deliberate empty replacement", async () => {
  const f = setup(), writes = f.connect();
  await render(<BudgetsScreen api={f.api} writes={writes} back={jest.fn()} />);
  await press("Casa"); await press("Editar asignaciones"); await press("Agregar asignación: Mercado");
  await enter("Planeado: Mercado", allocation.planned); await press("Mercado: Transferir a otra categoría"); await press("Destino de Mercado: Hogar");
  await press("Reemplazar asignaciones"); await screen.findByRole("header", { name: "Casa" });
  expect(f.posts[0]).toMatchObject({ method: "PUT", path: `${detail}/allocations`, match: '"1"', saved: true, body: { allocations: [
    { categoryId: category, planned: { amountMinor: "9007199254740993012", currency: "KWD" }, rolloverPolicy: "to_category", rolloverTargetId: target },
  ] } });
  await writes.replace(budget, '"2"', "KWD", []);
  expect(f.posts[1]).toMatchObject({ match: '"2"', body: { allocations: [] } });
  expect(f.posts[1].key).not.toBe(f.posts[0].key);
  await writes.replace(budget, '"3"', "KWD", [{ ...allocation, planned: "-9223372036854775,808" }]);
  expect(f.posts[2].body).toMatchObject({ allocations: [{ planned: { amountMinor: "-9223372036854775808", currency: "KWD" } }] });
});

test("requires explicit fresh-key confirmation for a create at 23 server hours", async () => {
  const f = setup(), writes = f.connect(); f.lose();
  await expect(writes.create(input)).rejects.toThrow();
  f.advance(23 * hours);
  const warning = await writes.create(input).catch((error) => error);
  expect(warning.message).toMatch(/^Puede que este movimiento ya se haya registrado\./);
  expect(f.posts).toHaveLength(1); expect(f.replay.size).toBe(1);
  await expect(writes.create(input, warning)).resolves.toBe(copy);
  expect(f.posts[1].key).not.toBe(f.posts[0].key); expect(f.posts[1].body).toEqual(f.posts[0].body);
});
