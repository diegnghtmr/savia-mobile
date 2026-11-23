import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Storage from "expo-secure-store";
import { createInbox } from "../src/foundation/notification-inbox";
import { createTransport } from "../src/foundation/transport";
import { NotificationInbox } from "../src/mobile-shell/notification-inbox";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, first, second] = [1, 2, 3, 4].map(id);
const timestamp = "2026-11-01T00:00:00.000001Z", after = Buffer.from(JSON.stringify([timestamp, first])).toString("base64url");
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup() {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]), pending = () => [...storage].filter(([key]) => key.startsWith("savia.ledger."));
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { storage.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { storage.delete(key); });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let readItem = false, available = 200, revoked = false, profileStatus = 200, lose = false;
  const posts: string[] = [];
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), headers = new Headers(init.headers);
    expect(headers.get("X-Workspace-Id")).toBeNull();
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: "Sun, 01 Nov 2026 00:00:00 GMT" }), json: async () => body });
    if (pathname === "/v1/me") return reply({ id: profile }, profileStatus);
    if (pathname === "/v1/workspaces") return reply({ items: revoked ? [] : [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    if (pathname.endsWith("/read")) {
      expect(pathname).toBe(`/v1/notifications/${first}/read`); expect(init.method).toBe("POST");
      const key = headers.get("Idempotency-Key")!; posts.push(key); expect(JSON.parse(pending()[0][1]).key).toBe(key);
      readItem = true;
      if (lose) { lose = false; throw new Error("lost reply"); }
      return { ...reply(null, 204), json: async () => { throw new Error("No JSON on 204"); } };
    }
    expect(pathname).toBe("/v1/notifications"); expect(searchParams.get("limit")).toBe("20");
    if (available !== 200) return reply({}, available);
    const later = searchParams.has("cursor"); if (later) expect(searchParams.get("cursor")).toBe(after);
    const unread = searchParams.get("unreadOnly") === "true";
    const item = { id: later ? second : first, title: later ? "Segundo aviso" : "Alerta de presupuesto", type: "budget_threshold", body: "Presupuesto al 80 %",
      createdAt: timestamp, read: later || readItem, actionUrl: "https://must-not-open.invalid" };
    return reply({ items: unread && item.read ? [] : [item], pageInfo: { hasNextPage: !later && !unread, nextCursor: !later && !unread ? after : null } });
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  const reopen = () => createInbox(requestInWorkspace, workspace);
  return { reopen, read, send, posts, pending, lose: () => { lose = true; }, status: (status: number) => { available = status; }, revoke: () => { revoked = true; }, noProfile: () => { profileStatus = 404; } };
}

test("loads pages, marks read on a real no-content response, and filters unread notifications", async () => {
  const f = setup(); await render(<NotificationInbox api={f.reopen()} back={jest.fn()} />);
  expect(await screen.findByText("Alerta de presupuesto")).toBeTruthy(); expect(screen.getByText("No leída")).toBeTruthy();
  await press("Cargar más"); expect(await screen.findByText("Segundo aviso")).toBeTruthy();
  await press("Marcar como leída: Alerta de presupuesto");
  expect(screen.queryByText("No leída")).toBeNull(); expect(f.pending()).toEqual([]);
  expect(screen.queryByRole("link")).toBeNull();
  await press("Solo no leídas"); expect(await screen.findByText("No hay notificaciones.")).toBeTruthy();
  expect(f.posts).toHaveLength(1);
});

test("validates before session and reuses a persisted read key after reopen", async () => {
  const f = setup(), firstApi = f.reopen();
  await expect(firstApi.list({ cursor: "W10" })).rejects.toThrow("Filtros de notificaciones no válidos.");
  await expect(firstApi.list({ unreadOnly: [true, true] })).rejects.toThrow("Filtros de notificaciones no válidos.");
  await expect(firstApi.mark([first])).rejects.toThrow("Notificación no válida.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.pending()).toEqual([]);
  f.lose(); await expect(firstApi.mark(first)).rejects.toThrow(); expect(f.pending()).toHaveLength(1);
  await expect(f.reopen().mark(first)).resolves.toBeUndefined(); expect(f.posts).toEqual([f.posts[0], f.posts[0]]);
  expect(f.pending()).toEqual([]);
  f.revoke(); f.send.mockClear(); await expect(f.reopen().list()).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
});

test.each([404, 501])("shows inbox unavailable for endpoint %s, not for identity failure", async (status) => {
  const f = setup(); f.status(status);
  await render(<NotificationInbox api={f.reopen()} back={jest.fn()} />);
  expect(await screen.findByText("Notificaciones no disponibles.")).toBeTruthy();
  f.noProfile(); await press("Actualizar notificaciones");
  expect(await screen.findByText("No pudimos cargar las notificaciones.")).toBeTruthy();
});
