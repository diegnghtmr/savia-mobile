import { fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as send } from "expo/fetch";
import * as Storage from "expo-secure-store";
import Index from "../src/app/index";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-sqlite");
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ getRandomBytesAsync: async (size: number) => require("node:crypto").randomBytes(size) }));
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockReadSession = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: mockReadSession, localPrincipal: async () => "fixture-recurring-rules" }) }));

const [profile, workspace, first, second] = [1, 2, 3, 4].map((n) => `caac0000-0000-4000-8000-00000000000${n}`);
const recurring = "/v1/recurring-rules", stamp = "2026-11-22T00:00:00.000000Z";
const encode = (scope: string) => Buffer.from(JSON.stringify([scope, stamp, first])).toString("base64url");
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup(cursor = encode(workspace)) {
  jest.clearAllMocks(); mockReadSession.mockResolvedValue({ accessToken: "fixture" });
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => key === `savia.workspace.${profile}` ? workspace : key === "savia.offline.key.v1" ? "a".repeat(64) : null);
  let revoked = false;
  const fetch = jest.mocked(send) as unknown as jest.Mock;
  const reads: (string | null)[] = [];
  fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown) => ({ status: 200, ok: true, redirected: false, headers: new Headers(), json: async () => body });
    const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: !!nextCursor, nextCursor } });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(page(revoked ? [] : [{ id: workspace, name: "Casa" }]));
    expect(pathname).toBe(recurring); expect(init.method).toBe("GET"); expect(headers.get("X-Workspace-Id")).toBe(workspace);
    expect(headers.get("Idempotency-Key")).toBeNull(); expect(searchParams.get("limit")).toBe("20");
    const next = searchParams.get("cursor"); reads.push(next);
    return reply(next ? page([{ id: second, name: "Renta", frequency: "monthly", behavior: "create_draft", active: false, nextOccurrenceAt: stamp }])
      : page([{ id: first, name: "Donación", frequency: "weekly", behavior: "remind", active: true, nextOccurrenceAt: stamp,
        template: { notes: "private-template-note" } }], cursor));
  });
  return { fetch, reads, revoke: () => { revoked = true; } };
}

test("lists paginated recurring rules as read-only in the verified workspace", async () => {
  const f = setup(); await render(<Index />); await press("Reglas recurrentes");
  await screen.findByText("Donación"); expect(screen.getByText("Semanal · Recordatorio")).toBeTruthy();
  expect(screen.getByText("Próxima ocurrencia (UTC): 2026-11-22")).toBeTruthy();
  expect(screen.queryByText(/private-template-note/)).toBeNull(); expect(screen.queryByRole("button", { name: /Crear|Editar|Eliminar/ })).toBeNull();
  await press("Cargar más reglas"); await screen.findByText("Renta");
  expect(screen.getByText("Donación")).toBeTruthy(); expect(screen.getByText("Mensual · Crear borrador")).toBeTruthy();
  expect(screen.getByText("Inactiva")).toBeTruthy(); expect(f.reads).toEqual([null, encode(workspace)]);
  f.revoke(); f.fetch.mockClear(); await press("Actualizar reglas"); await screen.findByText("No pudimos cargar las reglas recurrentes.");
  expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
  expect(screen.queryByText("Donación")).toBeNull(); expect(screen.queryByText("Renta")).toBeNull();
});

test("rejects a foreign-workspace continuation without exposing rows or a load-more action", async () => {
  const f = setup(encode(profile)); await render(<Index />); await press("Reglas recurrentes");
  await screen.findByText("No pudimos cargar las reglas recurrentes.");
  expect(screen.queryByText("Donación")).toBeNull(); expect(screen.queryByRole("button", { name: "Cargar más reglas" })).toBeNull();
  expect(f.reads).toEqual([null]);
});
