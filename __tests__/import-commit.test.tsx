import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Storage from "expo-secure-store";
import { createImports } from "../src/foundation/imports";
import { createImportCommits } from "../src/foundation/import-commits";
import { createTransport } from "../src/foundation/transport";
import { ImportsScreen } from "../src/mobile-shell/imports-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, text: string) => require("node:crypto").createHash("sha256").update(text).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, account, importId, commitId] = [1, 2, 3, 4, 5].map(id);
const start = Date.UTC(2026, 10, 1), hour = 3_600_000;
const job = { id: importId, status: "awaiting_mapping" as const, fileName: "extracto.csv", sourceColumns: ["fecha", "importe", "descripcion"], counts: [] };
const mapping = { fecha: "date", importe: "amount", descripcion: "description" };
const draft = { accountId: account, columnMapping: mapping, debitSign: "negative", dateFormat: "YYYY-MM-DD", skipDuplicateCandidates: true };
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));

function setup() {
  jest.clearAllMocks();
  const storage = new Map([[`savia.workspace.${profile}`, workspace]]), pending = () => [...storage].filter(([key]) => key.startsWith("savia.ledger."));
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { storage.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { storage.delete(key); });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let now = start, lost = false, corrupt = false;
  const effects = new Set<string>(), posts: { key: string; body: unknown; journal: string | undefined }[] = [];
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers), createdAt = new Date(start).toISOString();
    const reply = (body: unknown, status = 200) => ({ status, ok: true, headers: new Headers({ Date: new Date(now).toUTCString() }), redirected: false, json: async () => body });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply({ items: [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (path === `/v1/import-jobs/${importId}`) return reply({ ...job, createdAt, validRows: 2 });
    expect(path).toBe(`/v1/import-jobs/${importId}/commit`); expect(init.method).toBe("POST");
    const key = headers.get("Idempotency-Key")!;
    effects.add(key); posts.push({ key, body: JSON.parse(String(init.body)), journal: pending()[0]?.[1] });
    if (lost) { lost = false; throw new Error("reply lost"); }
    return reply({ id: commitId, type: "import_commit", status: "completed", resultResourceId: corrupt ? account : importId, createdAt }, 202);
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  const choices = jest.fn(async () => [{ id: account, name: "Caja", currency: "COP" }]);
  const reopen = () => createImportCommits(requestInWorkspace, workspace, choices);
  return { read, send, posts, pending, effects, reopen, choices, api: createImports(requestInWorkspace, workspace),
    lose: () => { lost = true; }, badReceipt: (value: boolean) => { corrupt = value; }, advance: (ms: number) => { now += ms; } };
}

test("validates confirmation, account and column mapping before session, then persists and replays a lost commit exactly after reopen", async () => {
  const f = setup(), first = f.reopen(); await first.loadAccounts();
  for (const [input, confirmed] of [[draft, false], [{ ...draft, accountId: profile }, true], [{ ...draft, columnMapping: { ...mapping, wrong: "amount" } }, true],
    [{ ...draft, debitSign: "separate_column" }, true], [{ ...draft, columnMapping: { ...mapping, descripcion: ["description"] } }, true]] as const) {
    await expect(first.commit(job, input, confirmed)).rejects.toThrow("Revisa los datos de la importación.");
  }
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.pending()).toEqual([]); expect(f.effects.size).toBe(0);
  f.lose(); await expect(first.commit(job, draft, true)).rejects.toThrow(/Necesitas conexión/);
  expect(f.posts[0].body).toEqual(draft); expect(JSON.parse(f.posts[0].journal!)).toEqual({ key: f.posts[0].key, clock: "server", createdAt: start });
  expect(f.pending()).toHaveLength(1);
  const reopened = f.reopen(); await reopened.loadAccounts(); f.advance(23 * hour - 1000);
  f.badReceipt(true); await expect(reopened.commit(job, draft, true)).rejects.toThrow(); expect(f.pending()).toHaveLength(1);
  f.badReceipt(false); await expect(reopened.commit(job, { ...draft, columnMapping: { descripcion: "description", importe: "amount", fecha: "date" } }, true)).resolves.toBe(commitId);
  expect(f.posts).toEqual([f.posts[0], f.posts[0], f.posts[0]]); expect(f.pending()).toEqual([]); expect(f.effects.size).toBe(1);
});

test("requires fresh server time or explicit expiry confirmation without silently changing the key", async () => {
  const f = setup(), writer = f.reopen(); await writer.loadAccounts();
  f.lose(); await expect(writer.commit(job, draft, true)).rejects.toThrow();
  f.advance(23 * hour);
  const expiry = await writer.commit(job, draft, true).catch((error) => error);
  expect(expiry.message).toMatch(/^Puede que este movimiento/); expect(f.posts).toHaveLength(1); expect(f.pending()).toHaveLength(1);
  await expect(writer.commit(job, { ...draft, skipDuplicateCandidates: false }, true, expiry)).rejects.toThrow("Pending submission changed");
  expect(f.posts).toHaveLength(1);
});

test("reviews destination and mapping before explicitly committing an analyzed import", async () => {
  const f = setup(); await render(<ImportsScreen api={f.api} commits={f.reopen()} back={jest.fn()} />);
  await fireEvent.changeText(screen.getByLabelText("Identificador de la importación"), importId);
  await press("Consultar importación"); await press("Preparar importación");
  await press("Cuenta: Caja (COP)"); await press("Revisar importación");
  expect(await screen.findByText("Confirma la importación a Caja (COP)." )).toBeTruthy(); expect(f.posts).toHaveLength(0);
  expect(screen.getByText("Omitir posibles duplicados: sí")).toBeTruthy();
  await press("Confirmar importación");
  expect(await screen.findByText("Importación completada")).toBeTruthy();
  expect(f.posts).toHaveLength(1); expect(f.posts[0].body).toEqual(draft); expect(f.pending()).toEqual([]);
});
