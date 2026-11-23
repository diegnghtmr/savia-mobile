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
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: mockRead, localPrincipal: async () => "bulk-fixtures" }) }));

const id = (n: number) => `fade0000-0000-4000-8000-00000000010${n}`;
const [profile, space, one, two, account] = [1, 2, 3, 4, 5].map(id), stamp = "2026-11-25T00:00:00Z";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const route = "/v1/transactions/bulk";
function setup({ failure = 0, lose = false } = {}) {
  jest.clearAllMocks(); mockRead.mockResolvedValue({ accessToken: "fixture" });
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => key === `savia.workspace.${profile}` ? space : key === "savia.offline.key.v1" ? "a".repeat(64) : null);
  let revoked = false, listReads = 0, stale = false;
  const requests: { key: string | null; body: unknown }[] = [], effects = new Map<string, object>();
  jest.mocked(send).mockImplementation((async (url: string, init: RequestInit) => {
    const { pathname: path } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(stamp).toUTCString() }), json: async () => body });
    const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply(page(revoked ? [] : [{ id: space, name: "Casa" }]));
    expect(headers.get("X-Workspace-Id")).toBe(space);
    if (path === "/v1/transactions") {
      listReads++;
      return reply(page([one, two].map((id, i) => ({ id, description: stale && !i ? "Café actualizado" : i ? "Pan" : "Café", accountId: account,
        version: stale && !i ? 4 : i + 2 + effects.size, amount: { amountMinor: "-420", currency: "USD" }, occurredAt: stamp, type: "adjustment", status: "confirmed", source: "import" }))));
    }
    expect(path).toBe(route); expect(init.method).toBe("POST");
    const key = headers.get("Idempotency-Key"), body = JSON.parse(String(init.body)); requests.push({ key, body });
    if (failure) { if (failure === 412) stale = true; return reply({}, failure); }
    if (!effects.has(key!)) effects.set(key!, { updated: body.targets.map(({ id, expectedVersion }: { id: string; expectedVersion: number }) => ({ id, version: expectedVersion + 1 })) });
    if (lose) { lose = false; throw new Error("Reply lost"); }
    return reply(effects.get(key!));
  }) as typeof send);
  return { requests, effects, listReads: () => listReads, revoke: () => { revoked = true; } };
}
async function chooseTwo() {
  await render(<Index />); await press("Movimientos"); await press("Acciones en lote");
  await press("Seleccionar: Café"); await press("Seleccionar: Pan");
}

test("bulk conversion requires an explicit income or expense choice and previews before dispatching one atomic request", async () => {
  const f = setup(); await chooseTwo(); await press("Convertir importados");
  mockRead.mockClear(); await press("Revisar lote"); await screen.findByText("Selecciona Ingreso o Gasto.");
  expect(mockRead).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  await press("Gasto"); await press("Revisar lote"); await screen.findByText("Convertir importados: Gasto");
  expect(screen.getByText(/Café.*USD/)).toBeTruthy(); expect(screen.getByText(/Pan.*USD/)).toBeTruthy(); expect(f.requests).toEqual([]);
  await press("Aplicar a 2 movimientos"); await screen.findByText("2 movimientos actualizados.");
  expect(f.requests).toEqual([{ body: { targets: [{ id: one, expectedVersion: 2 }, { id: two, expectedVersion: 3 }], action: { type: "convertImported", targetType: "expense" } }, key: expect.any(String) }]);
  expect(f.effects.size).toBe(1); expect(f.listReads()).toBe(2);
});

test("a stale target refreshes the list, clears the preview and never resends the batch", async () => {
  const f = setup({ failure: 412 }); await chooseTwo(); await press("Archivar"); await press("Revisar lote"); await press("Aplicar a 2 movimientos");
  await screen.findByText("Los movimientos cambiaron. Revisa la lista actualizada.");
  await screen.findByRole("button", { name: "Café actualizado" });
  expect(f.requests).toHaveLength(1); expect(f.effects.size).toBe(0); expect(f.listReads()).toBe(2);
  expect(screen.queryByRole("button", { name: "Aplicar a 2 movimientos" })).toBeNull();
});

test.each([404, 501])("an unavailable bulk endpoint (%s) does not change the list", async (failure) => {
  const f = setup({ failure }); await chooseTwo(); await press("Archivar"); await press("Revisar lote"); await press("Aplicar a 2 movimientos");
  await screen.findByText("Esta función no está disponible en este servidor.");
  expect(f.requests).toHaveLength(1); expect(f.effects.size).toBe(0); expect(f.listReads()).toBe(1);
});

test("a lost bulk reply retains only a memory retry key, and revoked membership prevents dispatch", async () => {
  const f = setup({ lose: true }); await chooseTwo(); jest.mocked(Storage.setItemAsync).mockClear();
  await press("Excluir de informes"); await press("Revisar lote"); await press("Aplicar a 2 movimientos"); await screen.findByText("No pudimos aplicar el lote.");
  await press("Aplicar a 2 movimientos"); await screen.findByText("2 movimientos actualizados.");
  expect(f.requests).toEqual([f.requests[0], f.requests[0]]); expect(f.effects.size).toBe(1); expect(Storage.setItemAsync).not.toHaveBeenCalled();
  await press("Acciones en lote"); await press("Seleccionar: Café"); await press("Archivar"); await press("Revisar lote"); f.revoke();
  await press("Aplicar a 1 movimiento"); await screen.findByText("Este espacio ya no está disponible.");
  expect(f.requests).toHaveLength(2); expect(f.effects.size).toBe(1);
});

// Reviewer regression (verify mwtv01w4). __tests__/transaction-bulk.test.tsx (append).
test("cached movements cannot be the source of an online-only bulk preview", async () => {
  const f = setup(); const { unmount } = await render(<Index />);
  await press("Movimientos"); await screen.findByRole("button", { name: "Café" }); await unmount();
  jest.mocked(send).mockRejectedValue(new Error("offline"));
  await render(<Index />); await press("Movimientos"); await screen.findByRole("button", { name: "Café" });
  const bulk = screen.queryByRole("button", { name: "Acciones en lote" });
  if (bulk && !bulk.props.accessibilityState?.disabled) await fireEvent.press(bulk);
  expect(screen.queryByRole("button", { name: "Seleccionar: Café" })).toBeNull();
  expect(f.requests).toEqual([]);
});

test("bulk validation refuses repeated targets, over-limit lists and missing versions before dispatch", async () => {
  const f = setup();
  const { createBulkTransactions } = require("../src/foundation/transaction-bulk") as typeof import("../src/foundation/transaction-bulk");
  const request = jest.fn(), api = createBulkTransactions(request, space, jest.fn());
  const target = { id: one, expectedVersion: 2 };
  const oversized = Array.from({ length: 101 }, (_, n) => ({
    id: `fade0000-0000-4000-8000-${String(n).padStart(12, "0")}`, expectedVersion: 1,
  }));
  for (const targets of [[], [target, target], [{ ...target, expectedVersion: 0 }], oversized]) {
    await expect(api.apply(targets, { type: "archive" })).rejects.toThrow("Revisa la selección y la acción del lote.");
  }
  expect(request).not.toHaveBeenCalled(); expect(f.requests).toEqual([]); expect(Storage.setItemAsync).not.toHaveBeenCalled();
});

test("a refused conversion keeps the versioned preview and does not change stored state", async () => {
  const f = setup({ failure: 422 }); await chooseTwo();
  await press("Convertir importados"); await press("Ingreso"); await press("Revisar lote");
  const { offlineStore } = require("../src/foundation/offline-db") as typeof import("../src/foundation/offline-db");
  const hash = () => offlineStore()(async (db) => require("node:crypto").createHash("sha256").update(JSON.stringify([
    await db.getAllAsync("SELECT * FROM cache ORDER BY rowid"), await db.getAllAsync("SELECT * FROM outbox ORDER BY id"),
  ])).digest("hex"));
  const before = await hash(); jest.mocked(Storage.setItemAsync).mockClear();
  expect(f.requests).toEqual([]); await press("Aplicar a 2 movimientos");
  await screen.findByText("El lote contiene movimientos no aptos para esta acción. No se aplicaron cambios.");
  expect(f.requests).toEqual([{ body: { targets: [{ id: one, expectedVersion: 2 }, { id: two, expectedVersion: 3 }],
    action: { type: "convertImported", targetType: "income" } }, key: expect.any(String) }]);
  expect(f.effects.size).toBe(0); expect(await hash()).toBe(before); expect(Storage.setItemAsync).not.toHaveBeenCalled();
});

// Reviewer regression (verify mwtw32mo, 9c3cee8). __tests__/transaction-bulk.test.tsx (append).
test.each([false, true])("bulk stays unavailable with a cached page (first page cached: %s) until a fresh reload", async (cachedFirst) => {
  const f = setup(), normal = jest.mocked(send).getMockImplementation()!;
  const cursor = Buffer.from(JSON.stringify(["2026-11-25T00:00:00.000000Z", one])).toString("base64url");
  let cachedPageOnly = false;
  jest.mocked(send).mockImplementation(async (...args) => {
    const url = new URL(String(args[0])), continuation = url.searchParams.has("cursor");
    if (url.pathname === "/v1/transactions" && cachedPageOnly && continuation !== cachedFirst) throw new Error("page offline");
    const reply = await normal(...args);
    if (url.pathname !== "/v1/transactions") return reply;
    const { items } = await reply.json() as { items: unknown[] };
    return Object.assign(reply, { json: async () => ({ items: [items[continuation ? 1 : 0]],
      pageInfo: { hasNextPage: !continuation, nextCursor: continuation ? null : cursor } }) });
  });
  const first = await render(<Index />); await press("Movimientos"); await press("Cargar más");
  await screen.findByRole("button", { name: "Pan" }); await first.unmount();
  cachedPageOnly = true;
  await render(<Index />); await press("Movimientos"); await screen.findByRole("button", { name: "Café" });
  if (cachedFirst) expect(screen.queryByRole("button", { name: "Acciones en lote" })).toBeNull();
  await press("Cargar más"); await screen.findByRole("button", { name: "Pan" });
  expect(screen.getByRole("button", { name: "Café" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Acciones en lote" })).toBeNull();
  cachedPageOnly = false;
  await press("Filtros"); await press("Aplicar filtros"); await press("Cargar más");
  await screen.findByRole("button", { name: "Pan" }); await press("Acciones en lote");
  expect(screen.getByRole("button", { name: "Seleccionar: Café" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Seleccionar: Pan" })).toBeEnabled();
  expect(f.requests).toEqual([]);
});
