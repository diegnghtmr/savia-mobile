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
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: () => mockReadSession(), localPrincipal: async () => "d0000000-0000-4000-8000-000000000001" }) }));

const [profile, workspace, member, owner, user, inviteId] = [1, 2, 3, 4, 5, 6].map((n) => `d0000000-0000-4000-8000-00000000000${n}`);
const root = `/v1/workspaces/${workspace}`, roster = `${root}/members`, invitations = `${root}/invitations`, email = "amiga@fixture.invalid";
const at = "2026-11-22T00:00:00.000000Z", cursor = Buffer.from(JSON.stringify([workspace, at, owner])).toString("base64url");
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup(role = "administrator") {
  jest.clearAllMocks(); mockReadSession.mockResolvedValue({ accessToken: "fixture" });
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]);
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { storage.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { storage.delete(key); });
  let now = Date.parse(at), memberRole = "viewer", haveMember = true, lost = 2, stale = true, revoked = false, missing = false;
  let invitation: { email: string; role: string; status: string } | undefined;
  const writes: { path: string; method: string; body: unknown; key: string | null }[] = [];
  const mkMember = (id: string, userId: string, displayName: string, role: string) => ({ id, userId, displayName, role, status: "active", joinedAt: at });
  const invited = () => ({ ...invitation, id: inviteId, expiresAt: "2026-11-30T00:00:00Z", createdAt: at });
  const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: !!nextCursor, nextCursor } });
  const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
    headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => { if (status === 204) throw new Error("No content"); return body; } });
  const fetch = jest.mocked(send);
  (fetch as unknown as jest.Mock).mockImplementation(async (url: string, init: RequestInit) => {
    const { pathname: path, searchParams } = new URL(url), h = new Headers(init.headers), method = init.method!;
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply(page(revoked ? [] : [{ id: workspace, name: "Casa" }]));
    expect(h.get("X-Workspace-Id")).toBeNull();
    if (path === root) return reply({ id: workspace, role, kind: "family" });
    if (method === "GET" && path === roster) return missing ? reply({}, 501) : searchParams.get("cursor") === cursor
      ? reply(page([mkMember("d0000000-0000-4000-8000-000000000007", profile, "Mi perfil", role)]))
      : reply(page([mkMember(owner, owner, "Persona propietaria", "owner"), ...(haveMember ? [mkMember(member, user, "Persona invitada", memberRole)] : [])], cursor));
    if (method === "GET" && path === invitations) return reply(page(invitation ? [invited()] : []));
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    writes.push({ path, method, body, key: h.get("Idempotency-Key") });
    if (path === `${roster}/${member}` && method === "PATCH") {
      if (stale) { stale = false; memberRole = "editor"; return reply({}, 412); }
      memberRole = body.role; return reply(mkMember(member, user, "Persona invitada", memberRole));
    }
    if (path === `${roster}/${member}` && method === "DELETE") { haveMember = false; return reply(null, 204); }
    if (path === invitations && method === "POST") {
      if (lost-- > 0) throw new Error("response lost");
      invitation = { ...body, status: "pending" }; return reply(invited(), 201);
    }
    if (path === `${invitations}/${inviteId}/revoke`) { invitation = { ...invitation!, status: "revoked" }; return reply(invited()); }
    throw new Error("unexpected route");
  });
  return { writes, fetch, advance: () => { now += 23 * 3600_000; }, revoke: () => { revoked = true; }, missing: () => { missing = true; } };
}

test("roster pagination, role changes after explicit review, and confirmed removal stay in the verified workspace", async () => {
  const f = setup(); await render(<Index />); await press("Miembros del espacio");
  await screen.findByText("Persona invitada"); expect(screen.queryByRole("button", { name: "Gestionar a Persona propietaria" })).toBeNull();
  await press("Más miembros"); await screen.findByText("Mi perfil");
  expect(f.fetch.mock.calls.some(([url]) => typeof url === "string" && new URL(url).searchParams.get("cursor") === cursor)).toBe(true);
  await press("Gestionar a Persona invitada"); expect(screen.queryByRole("button", { name: "Rol: Propietario" })).toBeNull();
  await press("Rol: Editor"); await press("Guardar rol"); await screen.findByText("La membresía cambió. Revisa los datos actualizados.");
  expect(f.writes).toEqual([{ path: `${roster}/${member}`, method: "PATCH", body: { role: "editor" }, key: null }]);
  expect(screen.queryByRole("button", { name: "Guardar rol" })).toBeNull();
  await press("Gestionar a Persona invitada"); await press("Rol: Lector"); await press("Guardar rol"); await screen.findByText("Rol actualizado.");
  expect(f.writes[1]).toMatchObject({ method: "PATCH", body: { role: "viewer" }, key: null });
  await press("Gestionar a Persona invitada"); await press("Eliminar miembro"); expect(f.writes).toHaveLength(2);
  await press("Confirmar eliminación"); await screen.findByText("Miembro eliminado."); expect(screen.queryByText("Persona invitada")).toBeNull();
  expect(f.writes[2]).toMatchObject({ path: `${roster}/${member}`, method: "DELETE", key: expect.any(String) });
});

test("invitations validate before session, use the backend clock, and revoke only on confirmation", async () => {
  const f = setup(); await render(<Index />); await press("Miembros del espacio"); await press("Ver invitaciones");
  await screen.findByText("No hay invitaciones.");
  const typeEmail = async (value: string) => fireEvent.changeText(await screen.findByLabelText("Correo de invitación"), value);
  await typeEmail("bad@address"); mockReadSession.mockClear(); f.fetch.mockClear(); await press("Enviar invitación");
  await screen.findByText("Revisa el correo y el rol de la invitación."); expect(mockReadSession).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  await typeEmail(`  ${email.toUpperCase()}  `);
  for (let i = 0; i < 2; i++) { await press("Enviar invitación"); await screen.findByText("No pudimos enviar la invitación."); }
  expect(f.writes).toEqual([{ path: invitations, method: "POST", body: { email, role: "viewer" }, key: expect.any(String) }, f.writes[0]]);
  f.advance(); await press("Enviar invitación"); await screen.findByRole("button", { name: "Confirmar reintento" }); expect(f.writes).toHaveLength(2);
  await press("Confirmar reintento"); await screen.findByText(email); expect(f.writes[2].key).not.toBe(f.writes[1].key);
  await press(`Revocar invitación: ${email}`); expect(f.writes).toHaveLength(3); await press("Confirmar revocación");
  await screen.findByText("Invitación revocada."); expect(f.writes[3]).toMatchObject({ path: `${invitations}/${inviteId}/revoke`, method: "POST", key: expect.any(String) });
  expect(JSON.stringify(jest.mocked(Storage.setItemAsync).mock.calls)).not.toContain(email);
});

test("viewers get a read-only roster; absent or revoked workspaces do not expose or dispatch management", async () => {
  const f = setup("viewer"); await render(<Index />); await press("Miembros del espacio"); await screen.findByText("Persona invitada");
  expect(screen.queryByRole("button", { name: /Gestionar|Ver invitaciones/ })).toBeNull();
  f.missing(); await press("Actualizar lista"); await screen.findByText("Miembros del espacio no disponibles.");
  expect(screen.queryByText("Persona invitada")).toBeNull(); f.revoke(); f.fetch.mockClear(); await press("Actualizar lista");
  await screen.findByText("No pudimos cargar la lista.");
  expect(f.fetch.mock.calls.map(([url]) => typeof url === "string" && new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
  expect(f.writes).toEqual([]);
});
