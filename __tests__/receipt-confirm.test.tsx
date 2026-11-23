import * as Storage from "expo-secure-store";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { createReceiptConfirmations } from "../src/foundation/receipt-confirmations";
import { createReceipts } from "../src/foundation/receipts";
import { createTransport } from "../src/foundation/transport";
import { ReceiptsScreen } from "../src/mobile-shell/receipts-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, receipt, account, transaction] = [1, 2, 3, 4, 5].map(id);
const date = "2026-11-01", createdAt = `${date}T00:00:00.000Z`, start = Date.parse(createdAt);
const draft = { accountId: account, date, amount: "9007199254740993,012", description: "Tienda" };
function setup() {
  jest.clearAllMocks();
  const state = new Map([[`savia.workspace.${profile}`, workspace]]), pending = () => [...state].filter(([key]) => key.startsWith("savia.ledger."));
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => state.get(key) ?? null);
  jest.mocked(Storage.setItemAsync).mockImplementation(async (key, value) => { state.set(key, value); });
  jest.mocked(Storage.deleteItemAsync).mockImplementation(async (key) => { state.delete(key); });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let lost = false, committed = false, offline = false, now = start;
  const logs: { key: string; body: unknown }[] = [];
  const saved = { id: transaction, receiptId: receipt, type: "expense", status: "confirmed", accountId: account, occurredAt: createdAt,
    amount: { amountMinor: "9007199254740993012", currency: "KWD" }, description: "Tienda", categoryId: null, payeeId: null, tagIds: [] };
  const send = jest.fn(async (url: string, init: RequestInit) => {
    if (offline) throw new Error("offline");
    const path = new URL(url).pathname, headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 300, redirected: false, headers: new Headers({ Date: new Date(now).toUTCString() }), json: async () => body });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply({ items: [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (path === `/v1/transactions/${transaction}`) return reply(saved);
    if (path === `/v1/receipts/${receipt}`) return reply({ id: receipt, status: committed ? "confirmed" : "awaiting_review", processingLocation: "savia",
      fileName: "recibo.png", createdAt, transactionId: committed ? transaction : null, date: { value: date, confidence: 0.8 },
      total: { value: "9007199254740993.012", confidence: 0.9 }, currency: { value: "KWD", confidence: 0.9 }, merchant: { value: "Tienda", confidence: 0.9 } });
    expect(path).toBe(`/v1/receipts/${receipt}/confirm`);
    const key = headers.get("Idempotency-Key")!;
    logs.push({ key, body: JSON.parse(String(init.body)) }); expect(JSON.parse(pending()[0][1]).key).toBe(key);
    if (committed) return reply(null, 409);
    committed = true;
    if (lost) { offline = true; throw new Error("lost reply"); }
    return reply(saved, 201);
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  const api = createReceipts(requestInWorkspace, workspace);
  const reopen = () => createReceiptConfirmations(requestInWorkspace, workspace, api.detail, async () => [{ id: account, currency: "KWD", name: "Caja" }]);
  return { reopen, api, logs, pending, read, send, lose: () => { lost = true; }, restore: () => { offline = false; now += 1000; } };
}

test("validates confirmation before I/O and reconciles a claimed receipt after a lost reply without creating another movement", async () => {
  const f = setup(), writes = f.reopen(); await writes.loadAccounts();
  for (const bad of [{ amount: "0" }, { amount: "1,0001" }, { date: "2026-02-29" }, { accountId: [account] }]) {
    await expect(writes.confirm(receipt, { ...draft, ...bad }, true)).rejects.toThrow("Revisa los datos del movimiento.");
  }
  await expect(writes.confirm(receipt, draft, false)).rejects.toThrow("Revisa los datos del movimiento.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.pending()).toEqual([]);
  f.lose(); await expect(writes.confirm(receipt, draft, true)).rejects.toThrow(/Necesitas conexión/);
  expect(f.pending()).toHaveLength(1);
  const reopened = f.reopen(); await reopened.loadAccounts(); f.restore();
  await expect(reopened.confirm(receipt, draft, true)).resolves.toBe(transaction);
  expect(f.logs).toEqual([f.logs[0], f.logs[0]]);
  expect(f.logs[0].body).toEqual({ transaction: { accountId: account, status: "confirmed", type: "expense", occurredAt: createdAt,
    amount: { currency: "KWD", amountMinor: "9007199254740993012" }, description: "Tienda", categoryId: null, payeeId: null, tagIds: [] } });
  expect(f.pending()).toEqual([]);
});

test("reviews and edits OCR suggestions before linking the receipt to a newly created expense", async () => {
  const f = setup(); await render(<ReceiptsScreen api={f.api} confirmations={f.reopen()} back={jest.fn()} />);
  await fireEvent.changeText(screen.getByLabelText("Identificador del recibo"), receipt);
  const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
  await press("Consultar recibo"); await press("Preparar movimiento"); await press("Caja (KWD)");
  expect(screen.getByLabelText("Importe del gasto").props.value).toBe("9007199254740993.012");
  expect(f.logs).toEqual([]);
  await press("Confirmar y crear gasto");
  expect(await screen.findByText(`Movimiento vinculado: ${transaction}`)).toBeTruthy();
  expect(f.logs).toHaveLength(1);
});
