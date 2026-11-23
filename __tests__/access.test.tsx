import { fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as send } from "expo/fetch";
import * as Storage from "expo-secure-store";
import Index from "../src/app/index";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-sqlite");
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, getRandomBytesAsync: async (size: number) => require("node:crypto").randomBytes(size),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockReadSession = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: () => mockReadSession(), localPrincipal: async () => "b0000000-0000-4000-8000-000000000001" }) }));

const [profile, casa, team, id, other, account] = [1, 2, 3, 4, 5, 6].map((n) => `b0000000-0000-4000-8000-00000000000${n}`);
const path = "/v1/mcp/grants", cli = "/v1/cli/device/approve", at = "2026-11-22T00:00:00.000000Z", expiresAt = "2026-11-25T00:00:00Z";
const cursor = Buffer.from(JSON.stringify([at, other])).toString("base64url");
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const type = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);
const writesToDisk = () => JSON.stringify(jest.mocked(Storage.setItemAsync).mock.calls);
function setup() {
  jest.clearAllMocks(); mockReadSession.mockResolvedValue({ accessToken: "fixture" });
  const storage = new Map([[`savia.workspace.${profile}`, casa]]);
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { storage.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { storage.delete(key); });
  let now = Date.parse(at), missing = 0, cliStatus = 204, lost = 2, teamAllowed = true, casaAllowed = true;
  const posts: { path: string; method?: string; key: string | null; body: unknown }[] = [];
  const hidden = { id: other, clientName: "Solo otro espacio", scopes: ["accounts:read"], workspaceIds: [team], toolAllowlist: [], schedule: [], status: "active", createdAt: at };
  const response = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
    headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => { if (status === 204) throw new Error("No content"); return body; } });
  const fetch = jest.mocked(send);
  (fetch as unknown as jest.Mock).mockImplementation(async (url: string, options: RequestInit) => {
    const { pathname, searchParams } = new URL(url), headers = new Headers(options.headers);
    if (pathname === "/v1/me") return response({ id: profile });
    if (pathname === "/v1/workspaces") return response({ items: [...(casaAllowed ? [{ id: casa, name: "Casa" }] : []), ...(teamAllowed ? [{ id: team, name: "Equipo" }] : [])], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBeNull(); expect(headers.get("Authorization")).toBe("Bearer fixture");
    if (pathname === path && options.method === "GET") return missing ? response({}, missing) : searchParams.get("cursor") === cursor
      ? response({ items: [], pageInfo: { hasNextPage: false } }) : response({ items: [hidden], pageInfo: { hasNextPage: true, nextCursor: cursor } });
    const body = options.body ? JSON.parse(options.body as string) : undefined;
    posts.push({ path: pathname, method: options.method, key: headers.get("Idempotency-Key"), body });
    if (pathname === path) { if (lost-- > 0) throw new Error("response lost"); return response({ ...body, id, status: "active", createdAt: at }, 201); }
    if (pathname === `${path}/${id}`) return response(null, 204);
    if (pathname === cli) return response({ detail: "Private device detail" }, cliStatus);
    throw new Error("unexpected route");
  });
  return { fetch, posts, advance: () => { now += 23 * 3600_000; }, missing: (status: number) => { missing = status; }, cliStatus: (status: number) => { cliStatus = status; },
    revoke: (workspace: string) => { if (workspace === casa) casaAllowed = false; else teamAllowed = false; } };
}

test("restricted MCP grants page by subject, validate locally, and use server-clock replay rules", async () => {
  const f = setup(); await render(<Index />); expect(screen.getByRole("button", { name: "Notificaciones" })).toBeTruthy();
  await press("Accesos de MCP y CLI"); await screen.findByText("No hay permisos para este espacio.");
  expect(screen.queryByText("Solo otro espacio")).toBeNull(); await press("Más permisos MCP");
  expect(f.fetch.mock.calls.some(([url]) => typeof url === "string" && new URL(url).searchParams.get("cursor") === cursor)).toBe(true);
  await type("Nombre del cliente MCP", "Cliente privado"); await press("accounts:read"); await press("Incluir Equipo");
  await type("Herramientas permitidas (opcional)", "fake_tool"); mockReadSession.mockClear(); f.fetch.mockClear();
  await press("Crear permiso MCP"); await screen.findByText("Revisa las restricciones del permiso MCP.");
  expect(mockReadSession).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.posts).toEqual([]);
  await type("Herramientas permitidas (opcional)", "list_accounts"); await type("Horario semanal (opcional)", "1 09:00-17:00");
  await type("IDs de cuentas (opcional)", account); await type("Límite de escritura (opcional)", "123,45");
  await type("Moneda del límite", "COP"); await type("Vencimiento ISO (opcional)", expiresAt);
  for (let i = 0; i < 2; ++i) { await press("Crear permiso MCP"); await screen.findByText("No pudimos crear el permiso MCP con esas restricciones."); }
  expect(f.posts).toEqual([{ path, method: "POST", key: expect.any(String), body: { clientName: "Cliente privado", scopes: ["accounts:read"], workspaceIds: [casa, team], accountIds: [account],
    toolAllowlist: ["list_accounts"], schedule: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }], maxWriteAmount: { amountMinor: "12345", currency: "COP" }, expiresAt } }, f.posts[0]]);
  f.advance(); await press("Crear permiso MCP"); await screen.findByRole("button", { name: "Confirmar reintento MCP" }); expect(f.posts).toHaveLength(2);
  await press("Confirmar reintento MCP"); await screen.findByText("Cliente privado"); expect(f.posts[2].key).not.toBe(f.posts[1].key);
  f.revoke(team); await press("Crear permiso MCP"); await screen.findByText("Uno de los espacios elegidos ya no está disponible."); expect(f.posts).toHaveLength(3);
  await press("Revocar: Cliente privado"); expect(f.posts).toHaveLength(3); await press("Confirmar revocación MCP");
  await screen.findByText("Permiso revocado."); expect(f.posts[3]).toMatchObject({ path: `${path}/${id}`, method: "DELETE", key: expect.any(String) });
  expect(writesToDisk()).not.toMatch(/Cliente privado|list_accounts|12345|09:00/);
});

test("CLI approval requires explicit action, has uniform 400, and never persists the code; absent routes stay unavailable", async () => {
  const f = setup(); f.missing(404); await render(<Index />); await press("Accesos de MCP y CLI");
  await screen.findByText("Permisos MCP no disponibles."); expect(screen.queryByRole("button", { name: "Crear permiso MCP" })).toBeNull();
  await press("Autorizar dispositivo CLI"); await type("Código del dispositivo", "ABCD-0000");
  mockReadSession.mockClear(); await press("Aprobar dispositivo"); await screen.findByText("Código no válido o vencido.");
  expect(mockReadSession).not.toHaveBeenCalled(); expect(f.posts).toEqual([]);
  await type("Código del dispositivo", " abcd-2345 "); await press("Cancelar"); expect(f.posts).toEqual([]);
  await press("Autorizar dispositivo CLI"); expect(screen.getByLabelText("Código del dispositivo").props.value).toBe("");
  await type("Código del dispositivo", " abcd-2345 "); f.cliStatus(400); await press("Aprobar dispositivo");
  await screen.findByText("Código no válido o vencido."); expect(screen.queryByText("Private device detail")).toBeNull();
  expect(f.posts).toEqual([{ path: cli, method: "POST", key: null, body: { userCode: "ABCD2345" } }]);
  await type("Código del dispositivo", "ABCD2345"); f.cliStatus(204); await press("Aprobar dispositivo");
  await screen.findByText("Dispositivo CLI autorizado."); expect(screen.getByLabelText("Código del dispositivo").props.value).toBe("");
  await type("Código del dispositivo", "ABCD2345"); f.cliStatus(501); await press("Aprobar dispositivo"); await screen.findByText("Autorización de dispositivos CLI no disponible.");
  f.revoke(casa); await type("Código del dispositivo", "ABCD2345"); await press("Aprobar dispositivo");
  await screen.findByText("No pudimos aprobar el dispositivo."); expect(f.posts).toHaveLength(3);
  expect(writesToDisk()).not.toMatch(/ABCD2345|abcd-2345|Private device detail/);
});
