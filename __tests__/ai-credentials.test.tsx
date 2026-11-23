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
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: () => mockReadSession(), localPrincipal: async () => "a0000000-0000-4000-8000-000000000001" }) }));

const [profile, workspace, id] = [1, 2, 3].map((n) => `a0000000-0000-4000-8000-00000000000${n}`);
const credentials = "/v1/ai/credentials", detail = `${credentials}/${id}`, oldSecret = "test-private-key-old", newSecret = "test-private-key-new";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const type = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);
const capabilityWrites = () => jest.mocked(Storage.setItemAsync).mock.calls.filter(([slot]) => slot !== "savia.offline.key.v1");
function setup(conflict = 412) {
  jest.clearAllMocks(); mockReadSession.mockResolvedValue({ accessToken: "fixture" });
  const store = new Map([[`savia.workspace.${profile}`, workspace]]);
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { store.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { store.delete(key); });
  let now = Date.parse("2026-11-22T00:00:00Z"), lose = 2, exists = false, version = 7, status = "active", missing = 0, revoked = false;
  const row = () => ({ id, providerId: "openai", ownerType: "workspace", ownerSubjectId: null, credentialType: "api_key", maskedIdentifier: version === 7 ? oldSecret : "••••1234",
    secret: newSecret, alias: "Equipo", version, status, createdAt: "2026-11-22T00:00:00Z" });
  const reply = (value: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
    headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => { if (status === 204) throw new Error("No content"); return value; } });
  const writes: Array<{ method: string; path: string; body: unknown; key: string | null; tag: string | null }> = [];
  const fetch = jest.mocked(send);
  (fetch as unknown as jest.Mock).mockImplementation(async (url: string, init: RequestInit) => {
    const { pathname: path } = new URL(url), headers = new Headers(init.headers), method = init.method!;
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply({ items: revoked ? [] : [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (missing) return reply({}, missing);
    if (path === "/v1/ai/providers") return reply([
      { providerId: "openai", displayName: "OpenAI", enabled: true, policyStatus: "approved", credentialTypes: ["api_key", "oauth"], models: ["gpt-5"] },
      { providerId: "blocked", displayName: "Bloqueado", enabled: true, policyStatus: "disabled", credentialTypes: ["api_key"] },
    ]);
    if (method === "GET") return reply(exists ? [row()] : []);
    writes.push({ method, path, body: init.body ? JSON.parse(init.body as string) : undefined, key: headers.get("Idempotency-Key"), tag: headers.get("If-Match") });
    if (path === credentials && method === "POST") { if (lose-- > 0) throw new Error("lost response"); exists = true; return reply(row(), 201); }
    if (path === detail && method === "PATCH") {
      if (version++ === 7) return reply({}, conflict);
      const body = writes.at(-1)?.body as { status?: string }; status = body.status ?? status; return reply(row());
    }
    if (path === "/v1/ai/default-model" && method === "PUT") return reply(null, 204);
    if (path === detail && method === "DELETE") { exists = false; return reply(null, 204); }
    throw new Error("unexpected route");
  });
  return { writes, fetch, advance: () => { now += 23 * 3600_000; }, missing: (code: number) => { missing = code; }, revoke: () => { revoked = true; } };
}

test.each([412, 409])("AI credentials validate locally, keep secret retries in memory, and require a fresh explicit version after %i", async (conflict) => {
  const f = setup(conflict); await render(<Index />); await press("Credenciales de IA");
  await screen.findByText("No hay credenciales guardadas.");
  expect(screen.queryByRole("button", { name: /Bloqueado|oauth/ })).toBeNull();
  await press("OpenAI · api_key"); await press("Del espacio"); await type("Alias (opcional)", "Equipo");
  mockReadSession.mockClear(); f.fetch.mockClear(); await press("Agregar credencial");
  expect(await screen.findByText("Ingresa un secreto válido.")).toBeTruthy(); expect(mockReadSession).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Secreto del proveedor").props.secureTextEntry).toBe(true);
  for (let i = 0; i < 2; ++i) {
    await type("Secreto del proveedor", oldSecret); await press("Agregar credencial"); await screen.findByText("No pudimos guardar la credencial.");
  }
  expect(f.writes).toEqual([{ method: "POST", path: credentials, body: { providerId: "openai", credentialType: "api_key", ownerType: "workspace", alias: "Equipo", secret: oldSecret }, key: expect.any(String), tag: null }, f.writes[0]]);
  expect(capabilityWrites()).toEqual([]);
  f.advance(); await type("Secreto del proveedor", oldSecret); await press("Agregar credencial");
  await screen.findByRole("button", { name: "Confirmar reintento" }); expect(f.writes).toHaveLength(2);
  await press("Confirmar reintento"); await screen.findByText("Equipo · ••••"); expect(f.writes[2].key).not.toBe(f.writes[1].key);
  expect(screen.getByLabelText("Secreto del proveedor").props.value).toBe("");
  expect(screen.queryByText(/test-private-key/)).toBeNull();
  await press("Editar credencial: Equipo"); await type("Nuevo secreto (opcional)", newSecret); await press("Guardar cambios de credencial");
  await screen.findByText("La credencial cambió. Revisa los datos actualizados.");
  expect(f.writes).toHaveLength(4); expect(f.writes[3]).toMatchObject({ method: "PATCH", path: detail, tag: '"7"', body: { replacementSecret: newSecret } });
  await press("Editar credencial: Equipo"); expect(screen.getByLabelText("Nuevo secreto (opcional)").props.value).toBe("");
  await type("Nuevo secreto (opcional)", newSecret); await press("Guardar cambios de credencial"); await screen.findByText("Credencial guardada.");
  expect(f.writes[4]).toMatchObject({ method: "PATCH", path: detail, tag: '"8"' }); expect(f.writes[4].key).not.toBe(f.writes[3].key);
  expect(capabilityWrites()).toEqual([]);
  await type("Modelo (proveedor:modelo)", "openai:gpt-5"); await press("Usar credencial: Equipo"); await press("Guardar modelo predeterminado");
  await screen.findByText("Modelo predeterminado guardado.");
  expect(f.writes[5]).toMatchObject({ method: "PUT", path: "/v1/ai/default-model", body: { modelRef: "openai:gpt-5", credentialId: id }, key: expect.any(String) });
  await press("Revocar credencial: Equipo"); expect(f.writes).toHaveLength(6); await press("Confirmar revocación"); await screen.findByText("No hay credenciales guardadas.");
  expect(f.writes[6]).toMatchObject({ method: "DELETE", path: detail, key: expect.any(String), tag: null });
  expect(JSON.stringify(jest.mocked(Storage.setItemAsync).mock.calls)).not.toMatch(/test-private-key|••••|gpt-5/);
});

test("only verified absent AI routes are unavailable and revoked workspaces cannot dispatch", async () => {
  const f = setup(); f.missing(501); await render(<Index />); await press("Credenciales de IA");
  await screen.findByText("Credenciales de IA no disponibles."); expect(screen.queryByRole("button", { name: "Agregar credencial" })).toBeNull();
  f.revoke(); f.fetch.mockClear(); await press("Actualizar credenciales"); await screen.findByText("No pudimos cargar las credenciales de IA.");
  expect(f.fetch.mock.calls.every(([url]) => typeof url === "string" && ["/v1/me", "/v1/workspaces"].includes(new URL(url).pathname))).toBe(true);
});

// Reviewer regressions (verify mwtkxri2). Append to __tests__/ai-credentials.test.tsx.
test("failed credential registration clears the secret instead of supplying it to the next render", async () => {
  const f = setup(); await render(<Index />); await press("Credenciales de IA");
  await screen.findByText("No hay credenciales guardadas."); await press("OpenAI · api_key");
  await type("Secreto del proveedor", oldSecret); await press("Agregar credencial");
  await screen.findByText("No pudimos guardar la credencial.");
  expect(f.writes).toHaveLength(1);
  expect(capabilityWrites()).toEqual([]);
  expect(screen.getByLabelText("Secreto del proveedor").props.value.length).toBe(0);
});

test("initial version zero is editable with a strong If-Match tag", async () => {
  const f = setup(), mock = f.fetch as unknown as jest.Mock, normal = mock.getMockImplementation()!;
  let patched = false;
  const record = { id, providerId: "openai", ownerType: "workspace", ownerSubjectId: null, credentialType: "api_key",
    maskedIdentifier: "••••1234", alias: "Nueva", version: 0, status: "active", createdAt: "2026-11-22T00:00:00Z" };
  mock.mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === credentials && init.method === "GET") {
      return { status: 200, ok: true, redirected: false, headers: new Headers(), json: async () => [record] };
    }
    if (path === detail && init.method === "PATCH") {
      expect(new Headers(init.headers).get("If-Match")).toBe('"0"');
      expect(JSON.parse(String(init.body))).toEqual({ replacementSecret: newSecret });
      patched = true;
      return { status: 200, ok: true, redirected: false, headers: new Headers(), json: async () => ({ ...record, version: 1 }) };
    }
    return normal(url, init);
  });
  await render(<Index />); await press("Credenciales de IA");
  await screen.findByText("Nueva · ••••1234");
  expect(screen.getByRole("button", { name: "Editar credencial: Nueva" }).props.accessibilityState?.disabled).toBe(false);
  await press("Editar credencial: Nueva"); await type("Nuevo secreto (opcional)", newSecret);
  await press("Guardar cambios de credencial"); await screen.findByText("Credencial guardada.");
  expect(patched).toBe(true);
});

test("ordinary rotation failure clears the replacement secret on the still-visible form", async () => {
  const f = setup(), mock = f.fetch as unknown as jest.Mock, normal = mock.getMockImplementation()!;
  mock.mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === credentials && init.method === "GET") return {
      status: 200, ok: true, redirected: false, headers: new Headers(), json: async () => [{ id, providerId: "openai",
        ownerType: "workspace", ownerSubjectId: null, credentialType: "api_key", maskedIdentifier: "••••1234", alias: "Equipo", version: 8, status: "active" }],
    };
    if (path === detail && init.method === "PATCH") return { status: 503, ok: false, redirected: false, headers: new Headers(), json: async () => ({}) };
    return normal(url, init);
  });
  await render(<Index />); await press("Credenciales de IA");
  await press("Editar credencial: Equipo"); await type("Nuevo secreto (opcional)", newSecret);
  await press("Guardar cambios de credencial"); await screen.findByText("No pudimos guardar la credencial.");
  expect(capabilityWrites()).toEqual([]);
  expect(screen.getByLabelText("Nuevo secreto (opcional)").props.value.length).toBe(0);
});

// Reviewer regression (verify mwtlm9y7). Append to __tests__/ai-credentials.test.tsx.
test("registration clears private fields before the request settles", async () => {
  const f = setup(), mock = f.fetch as unknown as jest.Mock, normal = mock.getMockImplementation()!;
  let finish!: (result: unknown) => void;
  const held = new Promise((resolve) => { finish = resolve; });
  mock.mockImplementation(async (url: string, init: RequestInit) => new URL(url).pathname === credentials && init.method === "POST"
    ? held : normal(url, init));
  await render(<Index />); await press("Credenciales de IA"); await screen.findByText("No hay credenciales guardadas.");
  await press("OpenAI · api_key");
  await type("Secreto del proveedor", oldSecret);
  await type("Metadatos JSON (opcional)", '{"note":"private"}');
  await press("Agregar credencial");
  try {
    expect(screen.getByLabelText("Secreto del proveedor").props.value).toBe("");
    expect(screen.getByLabelText("Metadatos JSON (opcional)").props.value).toBe("");
  } finally {
    finish({ status: 503, ok: false, redirected: false, headers: new Headers(), json: async () => ({}) });
    await screen.findByText("No pudimos guardar la credencial.");
  }
  expect(capabilityWrites()).toEqual([]);
});
