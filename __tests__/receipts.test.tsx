import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as Storage from "expo-secure-store";
import { createReceipts } from "../src/foundation/receipts";
import { createTransport } from "../src/foundation/transport";
import { ReceiptsScreen } from "../src/mobile-shell/receipts-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digest: async (_: string, bytes: ArrayBuffer) => Uint8Array.from(require("node:crypto").createHash("sha256").update(Buffer.from(bytes)).digest()).buffer,
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, receipt, transaction] = [1, 2, 3, 4].map(id), start = Date.UTC(2026, 10, 1);
const image = () => ({ name: "recibo.png", blob: new Blob(["raw-image-fixture"], { type: "image/png" }) });
const extracted = { merchant: { value: "Tienda", confidence: 0.9 }, date: { value: "2026-11-01", confidence: 0.8 },
  currency: { value: "KWD", confidence: 0.6 }, total: { value: "9007199254740993.012", confidence: 0.7 } };
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
function setup() {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]), pending = () => [...storage].filter(([key]) => key.startsWith("savia.ledger."));
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { storage.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { storage.delete(key); });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let lost = false, ready = false, revoked = false, now = start;
  const posts: string[] = [];
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: true, redirected: false, headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => body });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply({ items: revoked ? [] : [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (path === "/v1/receipts") {
      const data = init.body as FormData;
      expect(init.method).toBe("POST"); expect(data.get("processingPreference")).toBe("savia"); expect(await (data.get("file") as File).text()).toBe("raw-image-fixture");
      posts.push(headers.get("Idempotency-Key")!); expect(JSON.parse(pending()[0][1]).key).toBe(posts.at(-1));
      if (lost) { lost = false; throw new Error("lost response"); }
    } else expect(path).toBe(`/v1/receipts/${receipt}`);
    return reply({ id: receipt, status: ready ? "awaiting_review" : "processing", fileName: "recibo.png", processingLocation: "savia",
      createdAt: new Date(start).toISOString(), transactionId: null, ...(ready ? extracted : {}) }, path === "/v1/receipts" ? 202 : 200);
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  const reopen = () => createReceipts(requestInWorkspace, workspace);
  return { reopen, send, read, pending, posts, lose: () => { lost = true; }, ready: () => { ready = true; }, revoke: () => { revoked = true; }, expire: () => { now += 23 * 3600000; } };
}

test("receipt upload validates size and type first and uses a persisted digest identity, never image bytes", async () => {
  const f = setup(), api = f.reopen();
  for (const blob of [new Blob([], { type: "image/png" }), new Blob(["x"], { type: "application/pdf" }),
    new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" })]) await expect(api.upload({ name: "x.png", blob })).rejects.toThrow("Elige una imagen JPEG, PNG o WebP de hasta 5 MiB.");
  await expect(api.detail([receipt])).rejects.toThrow("Recibo no válido.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.pending()).toEqual([]);
  f.lose(); await expect(api.upload(image())).rejects.toThrow();
  expect(JSON.parse(f.pending()[0][1])).toEqual({ key: f.posts[0], createdAt: start, clock: "server" });
  await expect(f.reopen().upload(image())).resolves.toMatchObject({ id: receipt });
  expect(f.posts).toEqual([f.posts[0], f.posts[0]]); expect(f.pending()).toEqual([]);
  f.revoke(); await expect(api.detail(receipt)).rejects.toThrow("Este espacio ya no está disponible.");
});

test("chooses an image via the injected camera source and polls until exact OCR suggestions can be reviewed", async () => {
  const f = setup(), source = jest.fn(async () => image());
  const view = await render(<ReceiptsScreen api={f.reopen()} source={source} back={jest.fn()} pollMs={30} />);
  await press("Tomar foto"); expect(source).toHaveBeenCalledWith("camera"); expect(f.send).not.toHaveBeenCalled();
  await press("Subir recibo"); await screen.findByText("Procesando recibo…"); f.ready();
  for (const text of ["Revisar datos extraídos", "Comercio: Tienda · confianza 90 %", "Total sugerido: 9007199254740993.012 · confianza 70 %"]) expect(await screen.findByText(text)).toBeTruthy();
  expect(screen.queryByText(/raw-image-fixture/)).toBeNull(); expect(f.send.mock.calls.some(([url]) => url.endsWith(`/v1/receipts/${receipt}`))).toBe(true);
  await act(async () => { await view.unmount(); });
});

// Reviewer regression (verify mwstw4vi). Append to __tests__/receipts.test.tsx.
test("stops automatic receipt checks after 30 attempts while OCR is still processing", async () => {
  const f = setup();
  jest.useFakeTimers();
  try {
    const view = await render(<ReceiptsScreen api={f.reopen()} back={jest.fn()} pollMs={2000} />);
    await fireEvent.changeText(screen.getByLabelText("Identificador del recibo"), receipt);
    await fireEvent.press(screen.getByRole("button", { name: "Consultar recibo" }));
    const calls = () => f.send.mock.calls.filter(([url]) => new URL(url).pathname === `/v1/receipts/${receipt}`).length;
    expect(calls()).toBe(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
    expect(calls()).toBe(31);
    expect(screen.getByText("El recibo sigue en proceso. Puedes actualizar su estado.")).toBeTruthy();
    await act(async () => { await jest.advanceTimersByTimeAsync(120_000); });
    expect(calls()).toBe(31);
    await view.unmount();
  } finally { jest.useRealTimers(); }
});

// Reviewer regression (verify mwtqgnix). Append to __tests__/receipts.test.tsx.
test("receipt problem response has the baseline UI and durable retry record", async () => {
  const crypto = jest.spyOn(require("expo-crypto"), "randomUUID").mockReturnValue(id(9));
  try {
    const f = setup(), normal = f.send.getMockImplementation()!, trace: unknown[] = [];
    f.send.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await normal(url, init);
      const path = new URL(url).pathname;
      const headers = new Headers(init.headers);
      trace.push([init.method, path, headers.get("X-Workspace-Id"), headers.get("Idempotency-Key"), init.redirect, init.credentials]);
      if (init.method !== "POST" || path !== "/v1/receipts") return response;
      return {
        ...response, status: 422, ok: false,
        headers: new Headers({ "Content-Type": "application/problem+json" }),
        json: async () => ({
          type: "https://savia.app/problems/receipt-dimensions-exceeded",
          code: "receipt_dimensions_exceeded",
          detail: "fixture-private-detail",
        }),
      };
    });
    const source = jest.fn(async () => image());
    await render(<ReceiptsScreen api={f.reopen()} source={source} back={jest.fn()} />);
    await press("Tomar foto");
    await press("Subir recibo");
    expect(await screen.findByRole("alert")).toHaveTextContent("El servidor no pudo aceptar la imagen.");
    expect(screen.queryByText(/fixture-private-detail|receipt-dimensions-exceeded/)).toBeNull();
    expect(f.pending()).toHaveLength(1);
    expect(JSON.parse(f.pending()[0][1])).toEqual({ key: id(9), createdAt: start, clock: "server" });
    expect(Storage.deleteItemAsync).not.toHaveBeenCalled();
    expect(trace).toEqual([
      ["GET", "/v1/me", null, null, "error", "omit"],
      ["GET", "/v1/workspaces", null, null, "error", "omit"],
      ["POST", "/v1/receipts", workspace, id(9), "error", "omit"],
    ]);
  } finally {
    crypto.mockRestore();
  }
});
