import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as send } from "expo/fetch";
import { openURL } from "expo-linking";
import * as Storage from "expo-secure-store";
import Index from "../src/app/index";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-linking", () => ({ openURL: jest.fn() }));
jest.mock("expo-sqlite");
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, getRandomBytesAsync: async (n: number) => require("node:crypto").randomBytes(n),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockRead = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: mockRead, localPrincipal: async () => "data-job-fixtures" }) }));

const [profile, space, definition, job] = [1, 2, 3, 4].map((n) => `fade0000-0000-4000-8000-00000000000${n}`);
const date = "2026-11-25T00:00:00Z", signed = "https://store.invalid/d/result?token=fixture-link";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup({ role = "owner", unavailable = 0, lose = false, complete = true } = {}) {
  jest.clearAllMocks(); mockRead.mockResolvedValue({ accessToken: "fixture" });
  jest.mocked(openURL).mockResolvedValue(true);
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => key === `savia.workspace.${profile}` ? space : key === "savia.offline.key.v1" ? "a".repeat(64) : null);
  let link = signed, expiresAt = "2026-11-25T00:15:00Z", format: string | undefined, revoked = false;
  const posts: { path: string; key: string | null; body: unknown }[] = [], reads: string[] = [];
  const client = jest.mocked(send) as unknown as jest.Mock;
  client.mockImplementation(async (url: string, init: RequestInit) => {
    const { pathname: path, searchParams } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(date).toUTCString() }), json: async () => body });
    const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply(page(revoked ? [] : [{ id: space, name: "Casa" }]));
    if (path === `/v1/workspaces/${space}`) return reply({ id: space, role });
    expect(headers.get("X-Workspace-Id")).toBe(space);
    if (path === "/v1/report-definitions") {
      expect(searchParams.get("limit")).toBe("20");
      return reply(page([{ id: definition, name: "Mi resumen", dimensions: [], measures: ["expense_total"], visualization: "table", filters: {}, version: 1 }]));
    }
    if (init.method === "POST") {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ path, body, key: headers.get("Idempotency-Key") }); format = body?.format;
      if (path === "/v1/backup-jobs" && unavailable) return reply({}, unavailable);
      if (lose) { lose = false; throw new Error("Reply lost"); }
      return reply({ id: job, status: "queued", format, createdAt: date, downloadUrl: null, expiresAt: null }, 202);
    }
    expect(path).toMatch(new RegExp(`^/v1/(report-runs|export-jobs|backup-jobs)/${job}$`)); reads.push(path);
    return reply({ id: job, status: complete ? "completed" : "processing", format, createdAt: date,
      downloadUrl: complete ? link : null, expiresAt: complete ? expiresAt : null });
  });
  return { posts, reads, client, finish: () => { complete = true; }, revoke: () => { revoked = true; },
    demote: () => { role = "administrator"; }, setLink: (value: string, expiry = expiresAt) => { link = value; expiresAt = expiry; } };
}
const open = async () => { await render(<Index />); await press("Informes y exportaciones"); };

test("shows the applied rates from a completed report run without opening its download", async () => {
  const f = setup(), normal = f.client.getMockImplementation()!;
  f.client.mockImplementation(async (url: string, init: RequestInit) => {
    const response = await normal(url, init);
    if (new URL(url).pathname !== `/v1/report-runs/${job}`) return response;
    return { ...response, json: async () => ({ ...await response.json(), fxRatesUsed: [
      { baseCurrency: "USD", quoteCurrency: "COP", rate: "4150.125", rateDate: "2026-11-20", source: "manual", freshness: "fresh" },
    ] }) };
  });
  await open(); await press("Informe: Mi resumen"); await press("Generar informe"); await press("Actualizar estado");
  await screen.findByText("USD → COP · 4150.125 · 2026-11-20 · manual · Vigente");
  expect(f.reads).toEqual([`/v1/report-runs/${job}`]); expect(openURL).not.toHaveBeenCalled();
});

test("runs a saved report, polls it, and only opens a fresh signed link on tap", async () => {
  const f = setup({ complete: false }); jest.useFakeTimers();
  try {
    const view = await render(<Index />); await press("Informes y exportaciones");
    await press("Informe: Mi resumen"); await press("PDF"); await press("Generar informe"); await screen.findByText("En cola");
    expect(f.posts).toEqual([{ path: "/v1/report-runs", key: expect.any(String), body: { definitionId: definition, format: "pdf" } }]);
    await act(async () => { await jest.advanceTimersByTimeAsync(2000); }); await screen.findByText("En proceso");
    f.finish(); await act(async () => { await jest.advanceTimersByTimeAsync(2000); }); await screen.findByText("Completado");
    expect(openURL).not.toHaveBeenCalled(); expect(screen.queryByText(/fixture-link/)).toBeNull();
    await press("Descargar archivo"); expect(openURL).toHaveBeenCalledWith(signed);
    expect(f.reads).toEqual(Array(3).fill(`/v1/report-runs/${job}`));
    f.revoke(); (openURL as jest.Mock).mockClear(); await press("Descargar archivo"); await screen.findByText("No pudimos abrir la descarga.");
    expect(openURL).not.toHaveBeenCalled(); expect(f.reads).toHaveLength(3);
    await view.unmount();
  } finally { jest.useRealTimers(); }
});

test("validates export dates before session and reuses its key after a lost response", async () => {
  const f = setup({ lose: true }); await open(); await press("Exportar datos"); await press("Movimientos"); await press("Excel (XLSX)");
  await fireEvent.changeText(screen.getByLabelText("Desde (AAAA-MM-DD)"), "2026-02-29"); mockRead.mockClear(); f.client.mockClear();
  await press("Crear exportación"); await screen.findByText("Revisa los datos de la exportación.");
  expect(mockRead).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled(); expect(f.posts).toEqual([]);
  await fireEvent.changeText(screen.getByLabelText("Desde (AAAA-MM-DD)"), "2026-02-28"); jest.mocked(Storage.setItemAsync).mockClear();
  await press("Crear exportación"); await screen.findByText("No pudimos iniciar el trabajo.");
  await press("Crear exportación"); await press("Actualizar estado"); await screen.findByText("Completado");
  expect(f.posts).toEqual([{ path: "/v1/export-jobs", key: expect.any(String), body: { format: "xlsx", resource: "transactions", from: "2026-02-28" } }, f.posts[0]]);
  expect(Storage.setItemAsync).not.toHaveBeenCalled();
  for (const [url, expires] of [["http://store.invalid/unsafe", "2026-11-25T00:15:00Z"], [signed, date]]) {
    f.setLink(url, expires); await press("Descargar archivo"); await screen.findByText("No hay un enlace de descarga vigente.");
    expect(openURL).not.toHaveBeenCalled();
  }
});

test("only the owner can create and retrieve a full backup, with no request body", async () => {
  const f = setup(); await open(); await press("Copia completa");
  expect(f.posts).toEqual([]); await press("Crear copia completa"); await screen.findByText("En cola");
  expect(f.posts).toEqual([{ path: "/v1/backup-jobs", key: expect.any(String), body: undefined }]);
  await press("Actualizar estado"); await screen.findByText("Completado"); await press("Descargar archivo"); expect(openURL).toHaveBeenCalledWith(signed);
  f.demote(); jest.mocked(openURL).mockClear(); await press("Descargar archivo"); await screen.findByText("Solo el propietario puede crear y descargar copias completas.");
  expect(f.reads).toEqual(Array(2).fill(`/v1/backup-jobs/${job}`)); expect(openURL).not.toHaveBeenCalled();
});

test.each([404, 501])("a verified backup endpoint returning %s reports unavailable", async (status) => {
  const f = setup({ unavailable: status }); await open(); await press("Copia completa"); await press("Crear copia completa");
  await screen.findByText("Copia completa no disponible en este servidor.");
  expect(f.posts).toHaveLength(1); expect(f.reads).toEqual([]); expect(openURL).not.toHaveBeenCalled();
});

test("an administrator cannot start a full backup", async () => {
  const f = setup({ role: "administrator" }); await open(); await press("Copia completa");
  await screen.findByText("Solo el propietario puede crear y descargar copias completas.");
  expect(screen.queryByRole("button", { name: "Crear copia completa" })).toBeNull(); expect(f.posts).toEqual([]);
});

// Reviewer regressions (verify mwts5k0k). Append to __tests__/data-jobs.test.tsx.
test.each([404, 501])("classifies a missing export status endpoint (%s) as unavailable", async (status) => {
  const f = setup(), normal = f.client.getMockImplementation()!;
  f.client.mockImplementation(async (url: string, init: RequestInit) => {
    const response = await normal(url, init);
    return new URL(url).pathname === `/v1/export-jobs/${job}` ? { ...response, ok: false, status } : response;
  });
  await open(); await press("Exportar datos"); await press("Crear exportación");
  await press("Actualizar estado");
  expect(await screen.findByRole("alert")).toHaveTextContent("Esta función no está disponible en este servidor.");
  expect(openURL).not.toHaveBeenCalled();
});

test("a workspace with no saved definitions can still run the monthly preset", async () => {
  const f = setup(), normal = f.client.getMockImplementation()!;
  f.client.mockImplementation(async (url: string, init: RequestInit) => {
    const response = await normal(url, init);
    if (new URL(url).pathname !== "/v1/report-definitions") return response;
    return { ...response, json: async () => ({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } }) };
  });
  await open();
  fireEvent.press(await screen.findByRole("button", { name: /Resumen mensual/i }));
  await press("Generar informe"); await screen.findByText("En cola");
  expect(f.posts).toEqual([{ path: "/v1/report-runs", key: expect.any(String), body: { preset: "monthly_summary", format: "pdf" } }]);
});

test("the known unsupported generic report export is not presented as usable", async () => {
  const f = setup(), normal = f.client.getMockImplementation()!;
  f.client.mockImplementation(async (url: string, init: RequestInit) => {
    const response = await normal(url, init);
    if (new URL(url).pathname !== "/v1/export-jobs" || JSON.parse(String(init.body)).resource !== "report") return response;
    return { ...response, ok: false, status: 422, json: async () => ({ title: "Export resource unavailable" }) };
  });
  await open(); await press("Exportar datos");
  const option = screen.queryByRole("button", { name: /^Informes$/ });
  if (!option || option.props.accessibilityState?.disabled) return;
  await fireEvent.press(option); await press("Crear exportación");
  expect(await screen.findByRole("alert")).toHaveTextContent("Esta función no está disponible en este servidor.");
});

test.each(["create", "poll"])("demotion blocks backup %s before the job request", async (phase) => {
  const f = setup(); await open(); await press("Copia completa");
  await screen.findByRole("button", { name: "Crear copia completa" });
  if (phase === "poll") { await press("Crear copia completa"); await screen.findByText("En cola"); }
  f.demote();
  await press(phase === "create" ? "Crear copia completa" : "Actualizar estado");
  expect(await screen.findByRole("alert")).toHaveTextContent("Solo el propietario puede crear y descargar copias completas.");
  expect(f.posts).toHaveLength(phase === "create" ? 0 : 1);
  expect(f.reads).toEqual([]);
  expect(openURL).not.toHaveBeenCalled();
});

test("backup download uses only the new HTTPS link and leaves cache and outbox unchanged", async () => {
  const f = setup(); await open(); await press("Copia completa");
  await press("Crear copia completa"); await press("Actualizar estado"); await screen.findByText("Completado");
  const { offlineStore } = require("../src/foundation/offline-db") as typeof import("../src/foundation/offline-db");
  const hash = () => offlineStore()(async (db) => require("node:crypto").createHash("sha256").update(JSON.stringify([
    await db.getAllAsync("SELECT * FROM cache ORDER BY rowid"), await db.getAllAsync("SELECT * FROM outbox ORDER BY id"),
  ])).digest("hex"));
  const before = await hash();
  expect(openURL).not.toHaveBeenCalled();
  jest.mocked(Storage.setItemAsync).mockClear();
  const fresh = "https://store.invalid/d/archive.zip?token=fixture-fresh";
  f.setLink(fresh, date);
  await press("Descargar archivo"); await screen.findByText("No hay un enlace de descarga vigente.");
  expect(openURL).not.toHaveBeenCalled(); expect(await hash()).toBe(before);
  f.setLink(fresh, "2026-11-25T00:15:00Z");
  await press("Descargar archivo");
  expect(openURL).toHaveBeenCalledTimes(1); expect(openURL).toHaveBeenCalledWith(fresh);
  expect(await hash()).toBe(before); expect(Storage.setItemAsync).not.toHaveBeenCalled();
});

test("only backend-supported export resources appear in the export form", async () => {
  const f = setup(); await open(); await press("Exportar datos");
  for (const name of ["Todos los datos", "Movimientos", "Cuentas"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  for (const name of ["Presupuestos", "Deudas", "Informes"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(f.posts).toEqual([]); expect(openURL).not.toHaveBeenCalled();
});

test("offers every authority preset and switches from a saved definition without sending both selectors", async () => {
  const f = setup(); await open(); await press("Informe: Mi resumen");
  const labels = ["Resumen mensual", "Flujo de caja", "Gastos", "Ingresos", "Presupuesto", "Patrimonio neto", "Deudas",
    "Fondos", "Espacio familiar", "Multimoneda", "Pronóstico", "Comparación de períodos"];
  for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeTruthy();
  await press("Comparación de períodos"); await press("CSV"); await press("Generar informe"); await screen.findByText("En cola");
  expect(f.posts).toEqual([{ path: "/v1/report-runs", key: expect.any(String), body: { preset: "period_comparison", format: "csv" } }]);
});

test.each([401, 403])("keeps an export status denial (%s) distinct from unavailability", async (status) => {
  const f = setup(), normal = f.client.getMockImplementation()!;
  f.client.mockImplementation(async (url: string, init: RequestInit) => {
    const response = await normal(url, init);
    return new URL(url).pathname === `/v1/export-jobs/${job}` ? { ...response, ok: false, status } : response;
  });
  await open(); await press("Exportar datos"); await press("Crear exportación"); await press("Actualizar estado");
  expect(await screen.findByRole("alert")).toHaveTextContent(status === 403 ? "No tienes permiso para realizar esta operación." : "No pudimos actualizar el estado del trabajo.");
  expect(f.posts).toHaveLength(1); expect(openURL).not.toHaveBeenCalled();
});
