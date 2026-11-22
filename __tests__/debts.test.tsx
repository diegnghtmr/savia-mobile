import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createDebts } from "../src/foundation/debts";
import { createTransport } from "../src/foundation/transport";
import { DebtsScreen } from "../src/mobile-shell/debts-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
const id = (n: number) => `deadbeef-0000-4000-8000-00000000000${n}`;
const [workspace, profile, first, second] = [1, 2, 3, 4].map(id);
const path = "/v1/debts", projection = `${path}/${first}/projection`;
const cursor = (scope = workspace) => Buffer.from(JSON.stringify([scope, "2026-11-21T00:00:00.000001Z", first])).toString("base64url");
const secure = jest.mocked(SecureStore);
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));

function setup(currency = "KWD") {
  jest.clearAllMocks(); secure.getItemAsync.mockResolvedValue(workspace);
  const amount = (amountMinor: string) => ({ amountMinor, currency });
  const row = { id: first.toUpperCase(), name: "Préstamo", currency, principal: amount("9123456789012345678"), outstandingBalance: amount("9007199254740993012"),
    annualRate: "0.045000000000000017", minimumPayment: amount("12342"), rateType: "fixed", status: "active", nextPaymentAt: "2026-12-01" };
  const data = { debtId: first, strategy: "minimum_payment", asOf: "2026-11-21", startingBalance: row.outstandingBalance,
    totalInterest: amount("100"), totalCost: amount("9007199254740993112"), estimatedPayoffDate: "2027-01-01",
    schedule: [{ dueDate: "2027-01-01", paymentAmount: amount("9007199254740993112"), principalAmount: row.outstandingBalance, interestAmount: amount("100"), remainingBalance: amount("0") }] };
  const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: nextCursor !== null, nextCursor } });
  const reply = (body: unknown, status = 200) => ({ status, ok: status === 200, headers: new Headers(), redirected: false, json: async () => JSON.parse(JSON.stringify(body)) });
  let member = true, response = 200, identity = 200, next = cursor(), repeat = false, projectionBody: unknown = data;
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), scope = new Headers(init.headers).get("X-Workspace-Id");
    expect(init.method).toBe("GET");
    if (pathname === "/v1/me") { expect(scope).toBeNull(); return reply({ id: profile }, identity); }
    if (pathname === "/v1/workspaces") { expect(scope).toBeNull(); return reply(page(member ? [{ id: workspace, name: "Casa" }] : [])); }
    expect(scope).toBe(workspace);
    if (pathname === projection) return reply(projectionBody, response);
    expect(pathname).toBe(path);
    return reply(searchParams.has("cursor") ? page([{ ...row, id: second, name: "Crédito", minimumPayment: undefined, nextPaymentAt: null, status: "paid", outstandingBalance: amount("0") }], repeat ? next : null) : page([row], next));
  });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  const api = createDebts(createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace, workspace);
  const calls = () => send.mock.calls.map(([url]) => url.replace("https://api.invalid", ""));
  return { api, read, send, calls, revoke: () => { member = false; }, project: (status: number) => { response = status; }, badIdentity: () => { identity = 404; },
    invalid: () => { next = cursor(profile); }, repeat: () => { repeat = true; }, badProjection: () => { projectionBody = { ...data, debtId: second }; } };
}

test("rejects invalid or repeated list and detail inputs before session or storage", async () => {
  const { api, send, read } = setup();
  for (const filters of [{ limit: "0" }, { limit: "201" }, { limit: 10 }, { limit: ["1", "2"] }, { limit: undefined }, { limit: " 20" },
    { cursor: "W10" }, { cursor: cursor(profile) }, { cursor: [cursor()] }, { status: "active" }, new URLSearchParams("limit=1&limit=2")]) {
    await expect(api.list(filters)).rejects.toThrow("Filtros de deudas no válidos.");
  }
  for (const raw of ["x", [first], ` ${first}`]) {
    await expect(api.detail(raw)).rejects.toThrow("Deuda no válida.");
    await expect(api.projection(raw, "KWD")).rejects.toThrow("Deuda no válida.");
  }
  await expect(api.projection(first, ["KWD"])).rejects.toThrow("Deuda no válida.");
  expect(send).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
});

test("uses verified list pagination for detail and rejects malformed or repeated returned cursors", async () => {
  const f = setup();
  await expect(f.api.detail(second.toUpperCase())).resolves.toMatchObject({ id: second, balance: "0,000 KWD", minimum: null, status: "paid" });
  expect(f.calls()).toEqual(["/v1/me", "/v1/workspaces", `${path}?limit=20`, "/v1/me", "/v1/workspaces", `${path}?limit=20&cursor=${cursor()}`]);
  f.send.mockClear(); f.repeat(); await expect(f.api.detail(second)).rejects.toThrow(); expect(f.calls()).toHaveLength(6);
  f.invalid(); await render(<DebtsScreen api={f.api} back={jest.fn()} />);
  expect(await screen.findByText("No pudimos cargar las deudas.")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  f.send.mockClear(); f.revoke(); await expect(f.api.projection(first, "KWD")).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.calls()).toEqual(["/v1/me", "/v1/workspaces"]);
});

test.each([404, 501])("shows no projection after an explicit availability check returns %i without breaking debt detail", async (status) => {
  const f = setup(); f.project(status);
  await render(<DebtsScreen api={f.api} back={jest.fn()} />);
  await screen.findByRole("button", { name: "Préstamo" });
  const figures = ["Saldo pendiente: 9007199254740993,012 KWD", "Pago mínimo: 12,342 KWD", "Tasa anual: 4,5000000000000017 %", "Estado: Activa"];
  for (const text of figures) expect(screen.getByText(text)).toBeTruthy();
  await press("Cargar más"); await screen.findByRole("button", { name: "Crédito" });
  expect(screen.getByText("Pago mínimo: No informado")).toBeTruthy();
  await press("Préstamo"); await screen.findByRole("header", { name: "Préstamo" });
  expect(f.calls()).not.toContain(projection);
  f.send.mockClear(); await press("Ver proyección");
  expect(await screen.findByText("Proyección no disponible")).toBeTruthy();
  for (const text of figures) expect(screen.getByText(text)).toBeTruthy();
  expect(f.calls()).toEqual(["/v1/me", "/v1/workspaces", projection]);
});

test("renders exact projection totals and schedule and does not hide unrelated failures as unsupported", async () => {
  const f = setup("JPY"); await render(<DebtsScreen api={f.api} back={jest.fn()} />);
  await press("Préstamo"); await press("Ver proyección");
  expect(await screen.findByText("Costo total: 9007199254740993112 JPY")).toBeTruthy();
  expect(screen.getByText("Interés total: 100 JPY")).toBeTruthy();
  expect(screen.getByText("Fecha estimada de liquidación: 2027-01-01")).toBeTruthy();
  expect(screen.getByText("2027-01-01 · Pago: 9007199254740993112 JPY")).toBeTruthy();
  f.badProjection(); await expect(f.api.projection(first, "JPY")).rejects.toThrow();
  f.project(403); await expect(f.api.projection(first, "JPY")).rejects.toMatchObject({ status: 403 });
  f.badIdentity(); await expect(f.api.projection(first, "JPY")).rejects.toMatchObject({ status: 404 });
});
