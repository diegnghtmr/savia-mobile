import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Storage from "expo-secure-store";
import { createNotificationPreferences } from "../src/foundation/notification-preferences";
import { createTransport } from "../src/foundation/transport";
import { NotificationSettings } from "../src/mobile-shell/notification-settings";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, device] = [1, 2, 3].map(id), path = "/v1/me/notification-preferences", push = "/v1/me/push-devices";
const defaults = { channels: { in_app: true, push: true, email: true }, quietHours: null, digestEnabled: true };
const token = { expoPushToken: "ExpoPushToken[synthetic-fixture]", platform: "ios" as const, appVersion: "1.0.0" };
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup() {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]);
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { storage.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { storage.delete(key); });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let preferencesStatus = 200, pushStatus = 201, conflict = false, revoked = false;
  const writes: { method?: string; path: string; body: unknown; match: string | null; key: string | null }[] = [];
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const p = new URL(url).pathname, headers = new Headers(init.headers);
    expect(headers.get("X-Workspace-Id")).toBeNull();
    const reply = (body: unknown, status = 200, etag = '"0"') => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: "Sun, 01 Nov 2026 00:00:00 GMT", ETag: etag }), json: async () => body });
    if (p === "/v1/me") return reply({ id: profile });
    if (p === "/v1/workspaces") return reply({ items: revoked ? [] : [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    if (p === path && init.method === "GET") return reply(defaults, preferencesStatus);
    const body = JSON.parse(String(init.body)), key = headers.get("Idempotency-Key");
    writes.push({ method: init.method, path: p, body, match: headers.get("If-Match"), key });
    if (p === push) return reply({ deviceId: device }, pushStatus);
    expect(p).toBe(path); expect(key).toBeTruthy();
    expect([...storage.values()].some((value) => value.includes(key!))).toBe(true);
    return reply(body, conflict ? 412 : 200, '"1"');
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  return { api: createNotificationPreferences(requestInWorkspace, workspace), read, send, writes, prefsStatus: (status: number) => { preferencesStatus = status; },
    pushStatus: (status: number) => { pushStatus = status; }, conflict: () => { conflict = true; }, revoke: () => { revoked = true; } };
}

test("edits full profile preferences with the pinned ETag, fixed budget alert thresholds and no unsupported fields", async () => {
  const f = setup(); await render(<NotificationSettings api={f.api} back={jest.fn()} />);
  expect(await screen.findByText("Umbrales fijos de alertas de presupuesto: 80 % y 100 %.")).toBeTruthy();
  await press("Correo electrónico"); await press("Activar horario de silencio");
  await fireEvent.changeText(screen.getByLabelText("Zona horaria (IANA)"), "America/Bogota");
  await press("Guardar preferencias");
  expect(await screen.findByText("Preferencias guardadas.")).toBeTruthy();
  expect(f.writes[0]).toEqual({ method: "PUT", path, match: '"0"', key: expect.any(String), body: { ...defaults,
    channels: { in_app: true, push: true, email: false }, quietHours: { start: "22:00", end: "07:00", timezone: "America/Bogota" } } });
  f.conflict(); await press("Resumen del lunes"); await press("Guardar preferencias");
  expect(await screen.findByText("Las preferencias cambiaron. Vuelve a cargarlas antes de guardar.")).toBeTruthy();
  expect(f.writes[1].match).toBe('"1"');
});

test("rejects invalid time, timezone and Expo registration before session, and trusts no token persistence", async () => {
  const f = setup();
  for (const quietHours of [{ start: "22:00", end: "22:00", timezone: "UTC" }, { start: "24:00", end: "07:00", timezone: "UTC" },
    { start: "22:00", end: "07:00", timezone: "+01:00" }]) {
    await expect(f.api.save({ ...defaults, quietHours }, '"0"')).rejects.toThrow("Revisa las preferencias de notificaciones.");
  }
  await expect(f.api.register({ ...token, expoPushToken: "native-device-id" })).rejects.toThrow("Token de notificaciones no válido.");
  await expect(f.api.register({ ...token, platform: "web" })).rejects.toThrow("Token de notificaciones no válido.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(Storage.setItemAsync).not.toHaveBeenCalled();
  const source = jest.fn().mockResolvedValue(token);
  await render(<NotificationSettings api={f.api} back={jest.fn()} tokenSource={source} />);
  await press("Registrar este dispositivo"); expect(await screen.findByText("Dispositivo registrado.")).toBeTruthy();
  expect(source).toHaveBeenCalledTimes(1); expect(f.writes[0]).toEqual({ path: push, method: "POST", body: token, key: null, match: null });
  expect(screen.queryByText(/synthetic-fixture/)).toBeNull(); expect(Storage.setItemAsync).not.toHaveBeenCalled();
  f.pushStatus(200); await expect(f.api.register(token)).resolves.toBe(device);
  f.revoke(); await expect(f.api.register(token)).rejects.toThrow("Este espacio ya no está disponible.");
});

test.each([404, 501])("preferences and push can independently report unavailable on %s", async (status) => {
  const f = setup(); f.prefsStatus(status); f.pushStatus(status);
  await render(<NotificationSettings api={f.api} back={jest.fn()} tokenSource={async () => token} />);
  expect(await screen.findByText("Preferencias de notificaciones no disponibles.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Guardar preferencias" })).toBeNull();
  await press("Registrar este dispositivo"); expect(await screen.findByText("Registro de notificaciones push no disponible.")).toBeTruthy();
});
