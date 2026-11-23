import { fireEvent, render, screen } from "@testing-library/react-native";
import Constants from "expo-constants";
import { fetch as sendRequest } from "expo/fetch";
import * as Notifications from "expo-notifications";
import * as Storage from "expo-secure-store";
import { Platform } from "react-native";
import Index from "../src/app/index";
import { createNotificationPreferences } from "../src/foundation/notification-preferences";
import { createTransport } from "../src/foundation/transport";
import { NotificationSettings } from "../src/mobile-shell/notification-settings";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: null, easConfig: null } }));
jest.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 }, IosAuthorizationStatus: { PROVISIONAL: 3 }, setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), getExpoPushTokenAsync: jest.fn(),
}));
jest.mock("expo-sqlite");
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockReadSession = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: mockReadSession, localPrincipal: async () => "notification-tests" }) }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomBytesAsync: async (size: number) => require("node:crypto").randomBytes(size),
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, device] = [1, 2, 3].map(id), path = "/v1/me/notification-preferences", push = "/v1/me/push-devices";
const defaults = { channels: { in_app: true, push: true, email: true }, quietHours: null, digestEnabled: true };
const token = { expoPushToken: "ExpoPushToken[synthetic-fixture]", platform: "ios" as const, appVersion: "1.0.0" };
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup() {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace], ["savia.offline.key.v1", "a".repeat(64)]]);
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
    if (p === "/v1/notifications") return reply({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } });
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

const projectId = "abca0000-0000-4000-8000-000000000004";
const permission = (granted: boolean, canAskAgain: boolean): Notifications.NotificationPermissionsStatus => ({
  status: (granted ? "granted" : "denied") as Notifications.NotificationPermissionsStatus["status"], granted, canAskAgain, expires: "never",
});
afterEach(() => jest.restoreAllMocks());
async function openDefaultRegistration(platform: "ios" | "android", projectConfig: "extra" | "eas" | "missing", development = false) {
  const f = setup();
  jest.replaceProperty(globalThis as typeof globalThis & { __DEV__: boolean }, "__DEV__", development);
  jest.replaceProperty(Platform, "OS", platform);
  jest.replaceProperty(Constants, "expoConfig", { name: "Savia", slug: "savia-mobile", version: token.appVersion,
    extra: projectConfig === "extra" ? { eas: { projectId } } : undefined });
  jest.replaceProperty(Constants, "easConfig", projectConfig === "eas" ? { projectId } : null);
  mockReadSession.mockImplementation(f.read);
  (sendRequest as unknown as jest.Mock).mockImplementation(f.send);
  await render(<Index />);
  await press("Notificaciones"); await press("Preferencias de notificaciones"); await screen.findByText("Resumen del lunes");
  expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
  f.read.mockClear(); f.send.mockClear(); jest.mocked(Storage.setItemAsync).mockClear();
  return f;
}

test.each([["android", "extra"], ["ios", "eas"]] as const)("default registration on %s obtains an Expo token only after a tap", async (platform, projectConfig) => {
  const f = await openDefaultRegistration(platform, projectConfig);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce(permission(platform === "ios", true));
  if (platform === "android") jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValueOnce(permission(true, true));
  jest.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValueOnce({ type: "expo", data: token.expoPushToken });
  await press("Registrar este dispositivo"); await screen.findByText("Dispositivo registrado.");
  if (platform === "android") {
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith("savia", { name: "Savia", importance: Notifications.AndroidImportance.DEFAULT });
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(jest.mocked(Notifications.setNotificationChannelAsync).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(Notifications.requestPermissionsAsync).mock.invocationCallOrder[0]);
  } else {
    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  }
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
  // Passing the SDK's default URL explicitly prevents SDK-managed background token updates.
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId, url: "https://exp.host/--/api/v2/push/getExpoPushToken" });
  expect(f.writes).toEqual([{ path: push, method: "POST", body: { ...token, platform }, key: null, match: null }]);
  expect(screen.queryByText(/synthetic-fixture/)).toBeNull(); expect(Storage.setItemAsync).not.toHaveBeenCalled();
});

test("default registration explains permission denial without requesting a token or writing", async () => {
  const f = await openDefaultRegistration("ios", "extra");
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce(permission(false, true));
  jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValueOnce(permission(false, false));
  await press("Registrar este dispositivo");
  expect(await screen.findByRole("alert")).toHaveTextContent("Activa el permiso de notificaciones en los ajustes para registrar este dispositivo.");
  expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  expect(Storage.setItemAsync).not.toHaveBeenCalled(); expect(screen.queryByText("Dispositivo registrado.")).toBeNull();
});

test("default registration makes no Expo calls from a development build", async () => {
  const f = await openDefaultRegistration("android", "extra", true);
  await press("Registrar este dispositivo");
  expect(await screen.findByRole("alert")).toHaveTextContent("El registro push no está disponible en compilaciones de desarrollo.");
  expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  expect(Storage.setItemAsync).not.toHaveBeenCalled(); expect(screen.queryByText("Dispositivo registrado.")).toBeNull();
});

test("default registration explains a missing project ID without prompting for permission", async () => {
  const f = await openDefaultRegistration("android", "missing");
  await press("Registrar este dispositivo");
  expect(await screen.findByRole("alert")).toHaveTextContent("No se configuró el ID del proyecto Expo para registrar notificaciones.");
  expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  expect(Storage.setItemAsync).not.toHaveBeenCalled(); expect(screen.queryByText("Dispositivo registrado.")).toBeNull();
});
