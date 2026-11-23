import { fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as send } from "expo/fetch";
import * as Storage from "expo-secure-store";
import Index from "../src/app/index";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-sqlite");
jest.mock("expo-crypto", () => ({ getRandomBytesAsync: async (n: number) => require("node:crypto").randomBytes(n) }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockSignOut = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ signOut: mockSignOut, readSession: async () => ({ accessToken: "fixture" }), localPrincipal: async () => "sessions-fixture" }) }));

const id = (n: number) => `fade0000-0000-4000-8000-00000000020${n}`;
const [profile, space, current, other] = [1, 2, 3, 4].map(id);
const root = "/v1/me/sessions", stamp = "2026-11-25T01:02:03Z";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup(failure = 0) {
  jest.clearAllMocks(); mockSignOut.mockResolvedValue(undefined);
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => key === `savia.workspace.${profile}` ? space : key === "savia.offline.key.v1" ? "a".repeat(64) : null);
  const calls: [string, string][] = []; let revoked = false, removed = false;
  jest.mocked(send).mockImplementation((async (url: string, init: RequestInit) => {
    const { pathname: path, searchParams } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false, headers: new Headers(), json: async () => body });
    const page = (items: unknown[], cursor: string | null = null) => ({ items, pageInfo: { hasNextPage: cursor !== null, nextCursor: cursor } });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply(page(removed ? [] : [{ id: space, name: "Casa" }]));
    expect(headers.get("X-Workspace-Id")).toBeNull();
    if (path === `/v1/workspaces/${space}`) return reply({ id: space });
    calls.push([init.method!, path]);
    if (path === `${root}/revoke-others`) {
      expect(init.body).toBeUndefined(); expect(headers.get("Idempotency-Key")).toBeNull();
      revoked = true; return reply(undefined, 204);
    }
    expect(path).toBe(root); expect(searchParams.get("limit")).toBe("20");
    if (failure) return reply({}, failure);
    const device = (id: string, current: boolean, userAgent: string) => ({ id, current, createdAt: stamp, lastActiveAt: stamp, userAgent });
    return searchParams.has("cursor") ? reply(page([device(other, false, "Navegador externo")])) :
      reply(page([device(current, true, "Este teléfono")], revoked ? null : "session-continuation"));
  }) as typeof send);
  return { calls, remove: () => { removed = true; } };
}
async function open() { await render(<Index />); await press("Sesiones"); }

test("lists active sessions without a workspace header and closes others only after confirmation", async () => {
  const f = setup(); await open(); await screen.findByText("Sesión actual"); await screen.findByText("Este teléfono");
  await press("Cargar más sesiones"); await screen.findByText("Navegador externo");
  expect(screen.queryByRole("button", { name: /Navegador externo|Este teléfono/ })).toBeNull();
  await press("Cerrar las demás sesiones"); expect(f.calls).toEqual([["GET", root], ["GET", root]]);
  await press("Confirmar cierre"); await screen.findByText("Se cerraron las demás sesiones.");
  expect(f.calls).toEqual([["GET", root], ["GET", root], ["POST", `${root}/revoke-others`], ["GET", root]]);
  expect(screen.getByText("Sesión actual")).toBeTruthy(); expect(screen.queryByText("Navegador externo")).toBeNull();
  expect(mockSignOut).not.toHaveBeenCalled(); expect(Storage.setItemAsync).not.toHaveBeenCalled();
});

test("close all calls global sign-out before local sign-out and returns to sign-in", async () => {
  const f = setup(); await open(); await screen.findByText("Sesión actual");
  await press("Cerrar todas las sesiones"); expect(mockSignOut).not.toHaveBeenCalled();
  await press("Confirmar cierre"); await screen.findByText("Iniciar sesión");
  expect(mockSignOut.mock.calls).toEqual([["global"], []]); expect(f.calls).toEqual([["GET", root]]);
  expect(screen.queryByText("Este teléfono")).toBeNull();
});

test("failed global sign-out closes locally and shows a notice on the sign-in screen", async () => {
  const f = setup(); await open(); await screen.findByText("Sesión actual");
  mockSignOut.mockRejectedValueOnce(new Error("provider refused"));
  await press("Cerrar todas las sesiones"); await press("Confirmar cierre"); await screen.findByText("Iniciar sesión");
  expect(screen.getByText("No pudimos cerrar todas las sesiones.")).toBeTruthy();
  expect(mockSignOut.mock.calls).toEqual([["global"], []]); expect(f.calls).toEqual([["GET", root]]);
  expect(screen.queryByText("Este teléfono")).toBeNull();
});

test.each([404, 501])("shows missing sessions route (%s) without rendering users as signed out", async (status) => {
  const f = setup(status); await open(); await screen.findByText("Esta función no está disponible en este servidor.");
  expect(f.calls).toEqual([["GET", root]]); expect(screen.queryByText("Iniciar sesión")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cerrar las demás sesiones" })).toBeNull(); expect(mockSignOut).not.toHaveBeenCalled();
});

// Reviewer regression (verify mwtv01w4). __tests__/sessions.test.tsx (append; replace the part of the existing test expecting lost membership to block global logout).
test("the account-level close-all is not blocked by loss of the selected workspace", async () => {
  const f = setup(); await open(); await screen.findByText("Sesión actual");
  await press("Cerrar todas las sesiones"); f.remove(); await press("Confirmar cierre");
  await screen.findByText("Iniciar sesión");
  expect(mockSignOut.mock.calls[0]).toEqual(["global"]);
  expect(f.calls).toEqual([["GET", root]]);
});

test("session metadata does not display or store stray credential fields", async () => {
  const f = setup(), normal = jest.mocked(send).getMockImplementation()!;
  jest.mocked(send).mockImplementation(async (...args) => {
    const response = await normal(...args);
    if (new URL(String(args[0])).pathname !== root) return response;
    const body = await response.json() as { items: object[] };
    return Object.assign(response, { json: async () => ({ ...body, items: body.items.map((row) => ({
      ...row, accessToken: "not-for-display-A", refreshToken: "not-for-display-B",
    })) }) });
  });
  await open(); await screen.findByText("Este teléfono");
  expect(screen.queryByText(/not-for-display-/)).toBeNull();
  expect(Storage.setItemAsync).not.toHaveBeenCalled(); expect(f.calls).toEqual([["GET", root]]);
});
