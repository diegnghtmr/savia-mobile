import { fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as send } from "expo/fetch";
import * as Storage from "expo-secure-store";
import Index from "../src/app/index";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-sqlite");
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, getRandomBytesAsync: async (n: number) => require("node:crypto").randomBytes(n),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockRead = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: mockRead, localPrincipal: async () => "catalog-fixtures" }) }));

const [profile, workspace, id] = [1, 2, 3].map((n) => `cabc0000-0000-4000-8000-00000000001${n}`);
const initial = Date.UTC(2026, 10, 25), hour = 3_600_000;
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (value: string) => fireEvent.changeText(screen.getByLabelText("Nombre"), value);
const open = async (label: string) => { await render(<Index />); await press("Crear en catálogos"); await press(label); };
const cases = [
  ["categories", "Nueva categoría", "Crear categoría", "Categoría creada.", "Ya existe una categoría con ese nombre en este espacio."],
  ["payees", "Nueva contraparte", "Crear contraparte", "Contraparte creada.", "Ya existe una contraparte con ese nombre en este espacio."],
  ["tags", "Nueva etiqueta", "Crear etiqueta", "Etiqueta creada.", "Ya existe una etiqueta con ese nombre en este espacio."],
] as const;

function setup({ conflict = false, lose = false } = {}) {
  jest.clearAllMocks(); mockRead.mockResolvedValue({ accessToken: "fixture" });
  const stored = new Map([[`savia.workspace.${profile}`, workspace], ["savia.offline.key.v1", "a".repeat(64)]]);
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => stored.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { stored.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { stored.delete(key); });
  const client = jest.mocked(send) as unknown as jest.Mock;
  const writes: { path: string; body: unknown; key: string | null }[] = [];
  const creations = new Map<string, unknown>(); let now = initial, removed = false;
  client.mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(now).toUTCString(), "Content-Type": status >= 400 ? "application/problem+json" : "application/json" }), json: async () => body });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply({ items: removed ? [] : [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBe(workspace); expect(init.method).toBe("POST");
    expect(path).toMatch(/^\/v1\/(categories|payees|tags)$/);
    const body = JSON.parse(String(init.body)), key = headers.get("Idempotency-Key");
    expect(key).toMatch(/^[a-f\d-]{36}$/); writes.push({ path, body, key });
    if (conflict) return reply({ type: "https://savia.app/problems/conflict" }, 409);
    if (creations.has(key!)) return reply(creations.get(key!), 201);
    const item = { id, ...body }; creations.set(key!, item);
    if (lose) { lose = false; throw new Error("reply lost"); }
    return reply(item, 201);
  });
  return { client, writes, creations, stored, revoke: () => { removed = true; }, expire: () => { now += 23 * hour; } };
}

test.each(cases)("creates %s with the exact normalized body and workspace-scoped idempotency", async (path, label, create, success) => {
  const f = setup(); await open(label); await enter("  Suministros  ");
  if (path === "categories") { await press("Gasto"); await press("Esencial"); }
  else expect(screen.queryByRole("button", { name: "Esencial" })).toBeNull();
  await press(create); await screen.findByText(success);
  expect(f.writes).toEqual([{ path: `/v1/${path}`, key: expect.any(String), body: { name: "Suministros",
    ...(path === "categories" ? { kind: "expense", essential: true } : {}) } }]);
  expect(f.creations.size).toBe(1);
  expect(JSON.stringify(jest.mocked(Storage.setItemAsync).mock.calls)).not.toContain("Suministros");
  expect([...f.stored.keys()].filter((key) => key.startsWith("savia.ledger."))).toEqual([]);
});

test.each(cases)("explains a duplicate %s name in Spanish without reporting success", async (path, label, create, success, duplicate) => {
  const f = setup({ conflict: true }); await open(label); await enter("Mercado");
  if (path === "categories") await press("Ingreso");
  await press(create); expect(await screen.findByRole("alert")).toHaveTextContent(duplicate);
  expect(screen.queryByText(success)).toBeNull(); expect(screen.getByLabelText("Nombre").props.value).toBe("Mercado");
  expect(f.writes).toHaveLength(1); expect(f.creations.size).toBe(0);
  expect([...f.stored.keys()].filter((key) => key.startsWith("savia.ledger."))).toEqual([]);
});

test("rejects bad category names and missing kind before the session, then blocks a revoked workspace before dispatch", async () => {
  const f = setup(); await open("Nueva categoría"); mockRead.mockClear(); f.client.mockClear();
  await enter("Despensa"); await press("Crear categoría"); await screen.findByText("Revisa el nombre y el tipo de la categoría.");
  await press("Gasto");
  for (const name of [" ", "A\0B", "á".repeat(121)]) {
    await enter(name); await press("Crear categoría"); await screen.findByText("Revisa el nombre y el tipo de la categoría.");
  }
  expect(mockRead).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  f.revoke(); await enter("á".repeat(120)); await press("Crear categoría"); await screen.findByText("Este espacio ya no está disponible.");
  expect(f.client.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
  expect(f.writes).toEqual([]); expect(f.creations.size).toBe(0);
});

test.each([false, true])("catalog lost reply replays unless the backend clock is expired (%s)", async (expired) => {
  const f = setup({ lose: true }); await open("Nueva etiqueta"); await enter("Casa");
  await press("Crear etiqueta"); await screen.findByText("No pudimos crear el elemento. Vuelve a intentarlo.");
  if (expired) f.expire();
  await press("Crear etiqueta");
  if (expired) {
    await screen.findByText(/Puede que este movimiento ya se haya registrado/);
    expect(f.writes).toHaveLength(1); await press("Confirmar reintento");
  }
  await screen.findByText("Etiqueta creada."); expect(f.writes).toHaveLength(2);
  expect(f.writes[1]).toEqual({ ...f.writes[0], key: expired ? expect.not.stringMatching(f.writes[0].key!) : f.writes[0].key });
  expect(f.creations.size).toBe(expired ? 2 : 1);
});
