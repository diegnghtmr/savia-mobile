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
