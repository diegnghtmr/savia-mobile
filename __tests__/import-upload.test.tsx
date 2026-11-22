import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Storage from "expo-secure-store";
import { createImports } from "../src/foundation/imports";
import { createTransport } from "../src/foundation/transport";
import { ImportsScreen } from "../src/mobile-shell/imports-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "abca0000-0000-4000-8000-000000000005" }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, jobId] = [1, 2, 3].map(id);
const fileName = "extracto.CSV", mime = "text/csv", bytes = "fecha,importe,descripcion\n2026-01-01,-120,Solo archivo";
function setup() {
  jest.clearAllMocks(); jest.mocked(Storage.getItemAsync).mockResolvedValue(workspace);
  let revoked = false, fail = false;
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers);
    if (path === "/v1/me") return Response.json({ id: profile });
    if (path === "/v1/workspaces") return Response.json({ items: revoked ? [] : [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (path === "/v1/import-jobs") {
      expect(init.method).toBe("POST"); expect(headers.get("Content-Type")).toBeNull();
      expect(headers.get("Idempotency-Key")).toBe(id(5));
      expect(init.body).toBeInstanceOf(FormData);
      const data = init.body as FormData, file = data.get("file") as File;
      expect(file.name).toBe(fileName); expect(file.type).toBe(mime); expect(await file.text()).toBe(bytes);
      expect(data.get("formatHint")).toBe("csv");
      if (fail) return Response.json({ detail: bytes }, { status: 422, headers: { "Content-Type": "application/problem+json" } });
    } else { expect(path).toBe(`/v1/import-jobs/${jobId}`); expect(init.method).toBe("GET"); }
    return { status: init.method === "POST" ? 202 : 200, ok: true, headers: new Headers(), redirected: false,
      json: async () => ({ id: jobId, fileName, detectedFormat: "csv", status: "awaiting_mapping", totalRows: 4, validRows: 2,
        duplicateRows: 1, errorRows: 1, createdAt: "2026-11-01T00:00:00Z", sourceColumns: ["fecha", "importe", "descripcion"] }) };
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  const file = { name: fileName, blob: new Blob([bytes], { type: mime }) };
  return { api: createImports(requestInWorkspace, workspace), file, send, read, revoke: () => { revoked = true; }, fail: () => { fail = true; } };
}

test("rejects missing, oversize, conflicting types and unsupported declared formats before a session", async () => {
  const f = setup();
  for (const [name, blob] of [["x.txt", f.file.blob], ["x.csv", new Blob([])], ["x.csv", new Blob([new Uint8Array(5 * 1024 * 1024 + 1)])],
    ["x.csv", new Blob(["x"], { type: "application/pdf" })], ["bad\r\n.csv", f.file.blob]] as const) {
    await expect(f.api.upload({ name, blob })).rejects.toThrow(/CSV de hasta 5 MiB/);
  }
  for (const name of ["report.qif", "report.OFX"]) await expect(f.api.upload({ ...f.file, name })).rejects.toThrow("El servidor todavía no admite QIF ni OFX.");
  await expect(f.api.detail([jobId])).rejects.toThrow("Importación no válida.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(Storage.getItemAsync).not.toHaveBeenCalled();
});

test("uploads only through verified multipart transport, shows classification counts and safely refreshes by job ID", async () => {
  const f = setup(), source = jest.fn().mockResolvedValue(f.file);
  await render(<ImportsScreen api={f.api} source={source} back={jest.fn()} />);
  await fireEvent.press(screen.getByRole("button", { name: "Elegir extracto" }));
  expect(await screen.findByText(fileName)).toBeTruthy(); expect(f.send).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Subir para analizar" }));
  for (const label of ["Filas totales: 4", "Válidas: 2", "Duplicadas: 1", "Con errores: 1", "El servidor no muestra las filas individuales."]) expect(await screen.findByText(label)).toBeTruthy();
  expect(screen.queryByText(/Solo archivo/)).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Actualizar estado" }));
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces", "/v1/import-jobs", "/v1/me", "/v1/workspaces", `/v1/import-jobs/${jobId}`]);
  expect(Storage.setItemAsync).not.toHaveBeenCalled();
});

test("does not render backend problem detail or upload in a revoked workspace", async () => {
  const f = setup(); f.fail(); await render(<ImportsScreen api={f.api} source={async () => f.file} back={jest.fn()} />);
  await fireEvent.press(screen.getByRole("button", { name: "Elegir extracto" }));
  await fireEvent.press(screen.getByRole("button", { name: "Subir para analizar" }));
  expect(await screen.findByText("El servidor no pudo analizar el extracto. Revisa el formato del archivo.")).toBeTruthy();
  expect(screen.queryByText(/Solo archivo/)).toBeNull(); f.revoke(); f.send.mockClear();
  await expect(f.api.upload(f.file)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
});
