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
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: async () => ({ accessToken: "fixture" }),
  localPrincipal: async () => "00000000-0000-4000-8000-000000000001" }) }));

const ids = [1, 2, 3, 4].map((id) => `00000000-0000-4000-8000-00000000000${id}`);
const [profile, workspace, conversation, approval] = ids;
const at = "2026-11-22T00:00:00Z", conv = { id: conversation, title: "Mis gastos", createdAt: at, updatedAt: at };
const row = (version: number, status = "pending", createdBy: unknown = profile) => ({ id: approval, createdBy, toolName: "create_transaction", riskClass: "financial_write", argumentsHash: `hash-${version}`,
  preview: { amountMinor: String(version * 1000), currency: "COP" }, status, expiresAt: "2026-11-24T00:00:00Z" });
const list = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false } });
const conversations = "/v1/agent/conversations", approvals = "/v1/approvals", detail = `${approvals}/${approval}`, messages = `${conversations}/${conversation}/messages`;
const ask = "Consulta privada de prueba", answer = "Respuesta privada con ácento";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const change = async (label: string, value: string) => fireEvent.changeText(screen.getByLabelText(label), value);
function stream() {
  const event = (type: string, data?: object) => `event: ${type}\r\ndata: ${JSON.stringify({ type, runId: conversation, timestamp: at, data })}\r\n\r\n`;
  const bytes = new TextEncoder().encode(event("run_started") + event("text_delta", { text: answer }) + event("approval_required", { approvalId: approval }) + event("run_completed"));
  const split = bytes.indexOf(0xc3) + 1;
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } }),
    { headers: { "Content-Type": "text/event-stream" } });
}
function setup() {
  jest.clearAllMocks();
  const saved = new Map([[`savia.workspace.${profile}`, workspace]]), calls: { path: string; key: string | null; body: unknown }[] = [];
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => saved.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { saved.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { saved.delete(key); });
  let now = Date.parse(at), lost = 2, version = 1, revoked = false, offline = false, inboxStatus = 200, denied = false;
  let creator: unknown = profile;
  const json = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
    headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => body });
  (send as unknown as jest.Mock).mockImplementation(async (url: string, options: RequestInit) => {
    if (offline) throw new Error("offline");
    const { pathname: path, searchParams } = new URL(url), headers = new Headers(options.headers);
    if (path === "/v1/me") return json({ id: profile });
    if (path === "/v1/workspaces") return json(list(revoked ? [] : [{ id: workspace, name: "Casa" }]));
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (options.method === "POST") calls.push({ path, key: headers.get("Idempotency-Key"), body: JSON.parse(options.body as string) });
    if (path === conversations) return options.method === "POST" ? json(conv, 201) : json(list([]));
    if (path === messages) {
      expect(headers.get("Accept")).toContain("text/event-stream");
      if (lost-- > 0) throw new Error("lost");
      return stream();
    }
    if (path === approvals) { expect(searchParams.get("status")).toBe("pending"); return json(list([row(version)]), inboxStatus); }
    if (path === detail) {
      const result: { createdBy?: unknown } = row(version, "pending", creator);
      if (creator === undefined) delete result.createdBy;
      return json(result);
    }
    expect(headers.get("If-Match")).toBeNull();
    if (denied && (path === `${detail}/confirm` || path === `${detail}/reject`)) return json({}, 403);
    if (path === `${detail}/reject`) return json(row(version, "rejected"));
    if (path === `${detail}/confirm`) return version++ === 1 ? json({}, 412) : json(row(2, "approved"));
    throw new Error("unexpected route");
  });
  return { calls, advance: () => { now += 23 * 3600_000; }, revoke: () => { revoked = true; }, offline: () => { offline = true; }, inbox: (status: number) => { inboxStatus = status; }, deny: () => { denied = true; }, creator: (value: unknown) => { creator = value; } };
}

test("assistant validates before session, fences replays by server Date, and requires review of a changed approval", async () => {
  const f = setup(); await render(<Index />); await press("Asistente");
  expect(await screen.findByText("No hay conversaciones.")).toBeTruthy();
  (send as unknown as jest.Mock).mockClear();
  await change("Título (opcional)", "a".repeat(121)); await press("Crear conversación");
  expect(await screen.findByText("Revisa el título de la conversación.")).toBeTruthy(); expect(send).not.toHaveBeenCalled();
  await change("Título (opcional)", conv.title); await press("Crear conversación");
  await screen.findByLabelText("Mensaje");
  (send as unknown as jest.Mock).mockClear();
  await change("Mensaje", "a".repeat(20_001)); await press("Enviar mensaje");
  expect(await screen.findByText("Escribe un mensaje de hasta 20 000 caracteres.")).toBeTruthy(); expect(send).not.toHaveBeenCalled();
  await change("Mensaje", ask);
  for (let i = 0; i < 2; i++) { await press("Enviar mensaje"); await screen.findByText("No pudimos enviar el mensaje."); }
  expect(f.calls.slice(1)).toEqual([{ path: messages, key: expect.any(String), body: { message: ask } }, f.calls[1]]);
  f.advance(); await press("Enviar mensaje"); await screen.findByRole("button", { name: "Confirmar reintento" });
  expect(f.calls).toHaveLength(3);
  await press("Confirmar reintento"); expect(await screen.findByText(answer)).toBeTruthy();
  expect(f.calls[3].key).not.toBe(f.calls[2].key);
  expect(JSON.stringify(jest.mocked(Storage.setItemAsync).mock.calls)).not.toMatch(/Consulta privada|Respuesta privada|hash-1/);
  expect(f.calls).toHaveLength(4);
  await press("Revisar propuesta"); expect(await screen.findByText(/1000/)).toBeTruthy();
  await press("Aprobar propuesta");
  expect(await screen.findByText("La propuesta cambió. Revisa los datos actualizados.")).toBeTruthy();
  expect(screen.getByText(/2000/)).toBeTruthy(); expect(f.calls).toHaveLength(5);
  expect(f.calls[4]).toMatchObject({ path: `${detail}/confirm`, body: { argumentsHash: "hash-1" }, key: expect.any(String) });
  await press("Aprobar propuesta"); expect(await screen.findByText("Estado: Aprobada")).toBeTruthy();
  expect(f.calls[5]).toMatchObject({ path: `${detail}/confirm`, body: { argumentsHash: "hash-2" }, key: expect.any(String) });
  expect(f.calls[5].key).not.toBe(f.calls[4].key);
  f.offline(); await press("Volver a propuestas");
  expect(await screen.findByText("No pudimos cargar las propuestas.")).toBeTruthy(); expect(screen.queryByText(/2000|Respuesta privada/)).toBeNull();
});

test("the creator-only detail path can reject without the collection; a revoked workspace cannot dispatch", async () => {
  const f = setup(); f.inbox(404); await render(<Index />); await press("Asistente");
  await screen.findByText("No hay conversaciones."); await press("Propuestas pendientes");
  expect(await screen.findByText("Bandeja de propuestas no disponible.")).toBeTruthy();
  await change("Identificador de la propuesta", approval); await press("Consultar propuesta");
  await screen.findByText(/1000/); await press("Rechazar propuesta");
  expect(await screen.findByText("Estado: Rechazada")).toBeTruthy();
  expect(f.calls).toEqual([{ path: `${detail}/reject`, body: { argumentsHash: "hash-1" }, key: expect.any(String) }]);
  f.inbox(403); await press("Volver a propuestas");
  expect(await screen.findByText("No pudimos cargar las propuestas.")).toBeTruthy();
  expect(screen.queryByText("Bandeja de propuestas no disponible.")).toBeNull();
  f.revoke(); (send as unknown as jest.Mock).mockClear();
  await change("Identificador de la propuesta", approval); await press("Consultar propuesta");
  expect(await screen.findByText("No pudimos verificar la propuesta.")).toBeTruthy();
  expect((send as unknown as jest.Mock).mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
});

test.each([undefined, "not-a-uuid", conversation])("creator %s is not verified and the preview is read-only", async (createdBy) => {
  const f = setup(); f.creator(createdBy); await render(<Index />); await press("Asistente");
  await screen.findByText("No hay conversaciones."); await press("Propuestas pendientes");
  await press("Revisar: create_transaction"); expect(await screen.findByText(/1000/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^(Aprobar|Rechazar) propuesta$/ })).toBeNull();
  expect(screen.getByText("Vista de solo lectura.")).toBeTruthy(); expect(f.calls).toEqual([]);
});

test.each([["Aprobar propuesta", "confirm"], ["Rechazar propuesta", "reject"]])("a decision 403 after %s leaves the approval read-only", async (button, action) => {
  const f = setup(); f.deny(); await render(<Index />); await press("Asistente");
  await screen.findByText("No hay conversaciones."); await press("Propuestas pendientes");
  await press("Revisar: create_transaction"); await screen.findByText(/1000/);
  await press(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Solo quien creó la propuesta puede decidir.");
  expect(screen.getByText(/1000/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^(Aprobar|Rechazar) propuesta$/ })).toBeNull();
  expect(f.calls).toEqual([{ path: `${detail}/${action}`, key: expect.any(String), body: { argumentsHash: "hash-1" } }]);
});

// Reviewer regression (verify mwtk0xwr). Append to __tests__/assistant.test.tsx.
test("an acknowledged run_failed does not pin a later explicit send to the failed run", async () => {
  setup();
  const mock = send as unknown as jest.Mock, normal = mock.getMockImplementation()!;
  const keys: string[] = [];
  mock.mockImplementation(async (url: string, options: RequestInit) => {
    if (new URL(url).pathname !== messages) return normal(url, options);
    const key = new Headers(options.headers).get("Idempotency-Key")!;
    keys.push(key);
    if (key !== keys[0]) return stream();
    const ended = {
      type: "run_failed", runId: conversation, timestamp: at,
      data: { message: "Provider unavailable" },
    };
    return new Response(`event: run_failed\ndata: ${JSON.stringify(ended)}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  await render(<Index />); await press("Asistente");
  await screen.findByText("No hay conversaciones.");
  await press("Crear conversación"); await screen.findByLabelText("Mensaje");
  await change("Mensaje", ask); await press("Enviar mensaje");
  await screen.findByText("No pudimos enviar el mensaje.");
  expect(keys).toHaveLength(1);
  await press("Enviar mensaje");
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(await screen.findByText(answer)).toBeTruthy();
});
