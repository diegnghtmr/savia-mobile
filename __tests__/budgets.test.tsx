import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createBudgets } from "../src/foundation/budgets";
import { createTransactions } from "../src/foundation/transactions";
import { createTransport } from "../src/foundation/transport";
import { BudgetsScreen } from "../src/mobile-shell/budgets-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `abdef000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, first, second, category] = [1, 2, 3, 4, 5].map(id);
const from = "2026-01-01", to = "2026-02-01", date = "2026-01-02T00:00:00.000001Z";
const cursor = (f: string | null = from, t: string | null = to, owner = workspace) => Buffer.from(JSON.stringify([owner, date, first, JSON.stringify([f, t])])).toString("base64url");
const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: nextCursor !== null, nextCursor } });
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (name: string, text: string) => fireEvent.changeText(await screen.findByLabelText(name), text);
const secure = jest.mocked(SecureStore);

function setup(currency = "COP") {
  jest.clearAllMocks();
  secure.getItemAsync.mockResolvedValue(workspace);
  const session = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let member = true, invalid: string | undefined;
  const amount = (amountMinor: string) => ({ amountMinor, currency });
  const row = { id: first.toUpperCase(), name: "Hogar", method: "envelope", periodStart: from, periodEnd: to, currency, version: 3,
    allocations: [{ categoryId: category.toUpperCase(), planned: amount("9007199254740993012"), actual: amount("-4503599627370496506"),
      available: amount("13510798882111489518"), rolloverPolicy: "surplus" },
    { categoryId: id(9), planned: amount("0"), actual: amount("15"), available: amount("-15"), rolloverPolicy: "none" }] };
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown) => ({ status: 200, ok: true, redirected: false, headers: new Headers({ ETag: '"3"' }), json: async () => body });
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(page(member ? [{ id: workspace, name: "Casa" }] : []));
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    if (pathname === "/v1/categories") return reply(page([{ id: category, name: "Mercado" }]));
    if (pathname === `/v1/budgets/${first}`) return reply(row);
    if (pathname !== "/v1/budgets") throw new Error("unexpected route");
    if (invalid !== undefined) return reply(page([row], invalid));
    if (searchParams.has("cursor")) return reply(page([{ ...row, id: second, name: "Siguiente" }]));
    return reply(page([row], searchParams.has("from") ? cursor() : null));
  });
  const request = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read: session } }).requestInWorkspace;
  const api = createBudgets(request, workspace, () => createTransactions(request, workspace).options("categories"));
  return { api, send, session, revoke: () => { member = false; }, next: (value: string) => { invalid = value; } };
}

test("rejects repeated or malformed filters, limits, IDs and cursor bindings before session or storage", async () => {
  const { api, session, send } = setup();
  for (const input of [{ from: [from] }, { from: "2026-02-29" }, { to, from: "2026-02-02" }, { from: undefined }, { limit: 1 }, { limit: ["1", "2"] },
    { limit: "0" }, { limit: "201" }, { limit: "1e2" }, { limit: " 1" }, { cursor: "W10" }, { from, to, cursor: cursor(from, to, profile) },
    { from, to, cursor: cursor(null, null) }, { from, cursor: [cursor()] }, { status: "draft" }, new URLSearchParams(`from=${from}&from=${to}`)]) {
    await expect(api.list(input)).rejects.toThrow("Filtros de presupuestos no válidos.");
  }
  for (const value of ["bad", [first], ` ${first}`]) await expect(api.detail(value)).rejects.toThrow("Presupuesto no válido.");
  expect(session).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
});

test("filters by period and follows a cursor bound to that period and workspace", async () => {
  const { api, send, revoke } = setup();
  await render(<BudgetsScreen api={api} back={jest.fn()} />);
  await screen.findByRole("button", { name: "Hogar" });
  await enter("Desde (AAAA-MM-DD)", from); await enter("Hasta (AAAA-MM-DD)", to); await enter("Resultados por página (1–200)", "200");
  await press("Filtrar presupuestos"); await press("Cargar más");
  expect(await screen.findByRole("button", { name: "Siguiente" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hogar" })).toBeTruthy();
  const calls = send.mock.calls.map(([url, init]) => [url.replace("https://api.invalid", ""), new Headers(init.headers).get("X-Workspace-Id")]);
  expect(calls.slice(-6)).toEqual([["/v1/me", null], ["/v1/workspaces", null], [`/v1/budgets?limit=200&from=${from}&to=${to}`, workspace],
    ["/v1/me", null], ["/v1/workspaces", null], [`/v1/budgets?limit=200&from=${from}&to=${to}&cursor=${cursor()}`, workspace]]);
  send.mockClear(); revoke(); await expect(api.list({ limit: "1" })).rejects.toThrow("Este espacio ya no está disponible.");
  expect(send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
});

test("will not follow a wrong-workspace or repeated server cursor", async () => {
  const { api, next, send } = setup();
  next(cursor(null, null, profile));
  await render(<BudgetsScreen api={api} back={jest.fn()} />);
  expect(await screen.findByText("No pudimos cargar los presupuestos.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  next(cursor()); send.mockClear();
  await expect(api.list({ from, to, cursor: cursor() })).rejects.toThrow();
  expect(send.mock.calls.filter(([url]) => new URL(url).pathname === "/v1/budgets")).toHaveLength(1);
});

test.each([
  ["JPY", "9007199254740993012", "−4503599627370496506", "13510798882111489518"],
  ["COP", "90071992547409930,12", "−45035996273704965,06", "135107988821114895,18"],
  ["KWD", "9007199254740993,012", "−4503599627370496,506", "13510798882111489,518"],
])("shows %s amounts and percentage without floating-point rounding", async (currency, planned, actual, available) => {
  const { api, send } = setup(currency);
  await render(<BudgetsScreen api={api} back={jest.fn()} />); await press("Hogar");
  expect(await screen.findByText("Mercado")).toBeTruthy();
  for (const text of [`Planeado: ${planned} ${currency}`, `Ejecutado: ${actual} ${currency}`, `Disponible: ${available} ${currency}`,
    "Utilizado: −50,00 %", "Utilizado: No aplica", "Arrastre: Arrastrar sobrante"]) expect(screen.getByText(text)).toBeTruthy();
  expect(send.mock.calls.map(([url]) => new URL(url).pathname).slice(-6)).toEqual([
    "/v1/me", "/v1/workspaces", `/v1/budgets/${first}`, "/v1/me", "/v1/workspaces", "/v1/categories",
  ]);
});
