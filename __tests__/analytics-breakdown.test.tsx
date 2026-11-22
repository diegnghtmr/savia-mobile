import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createAnalytics } from "../src/foundation/analytics";
import { createTransport } from "../src/foundation/transport";
import { AnalyticsScreen } from "../src/mobile-shell/analytics-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, category] = [1, 2, 3].map(id);
const period = { from: "2026-10-22", to: "2026-11-21" };
const root = "/v1/analytics", totals = `${root}/summary`, cash = `${root}/cash-flow`, monthly = `${root}/advanced`;
function setup() {
  jest.clearAllMocks(); jest.mocked(SecureStore.getItemAsync).mockResolvedValue(workspace);
  const amount = (amountMinor: string, currency = "KWD") => ({ currency, amountMinor });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let membership = true, mixed = false, invalid = false, empty = false;
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), scope = new Headers(init.headers).get("X-Workspace-Id");
    const reply = (body: unknown) => ({ status: 200, ok: true, headers: new Headers(), redirected: false, json: async () => body });
    if (pathname === "/v1/me") { expect(scope).toBeNull(); return reply({ id: profile }); }
    if (pathname === "/v1/workspaces") { expect(scope).toBeNull(); return reply({ items: membership ? [{ id: workspace, name: "Casa" }] : [], pageInfo: { hasNextPage: false } }); }
    expect(scope).toBe(workspace); expect(init.method).toBe("GET");
    const from = searchParams.get("from"), to = searchParams.get("to"), zero = amount("0");
    if (pathname === totals) return reply({ periodStart: from, periodEnd: to, baseCurrency: "KWD", netWorth: zero,
      income: amount("9007199254740993018"), expenses: amount("9007199254740993000"), savingsCapacity: amount("18") });
    if (pathname === cash) return reply({ series: [{ period: "2026-10-01", value: amount("-6"), secondaryValue: amount("-6") }],
      categories: empty ? [] : [{ categoryId: category, categoryName: "Vivienda", amount: amount("9007199254740993012", mixed ? "USD" : "KWD"), percentage: 100.01 }] });
    expect(pathname).toBe(monthly); expect(searchParams.get("metric")).toBe("monthly_savings_capacity");
    return reply({ metric: "monthly_savings_capacity", generatedAt: "2026-11-21T00:00:00.000Z", data: { series: [
      { month: "2026-10-01", incomeMinor: "9007199254740993006", expensesMinor: "9007199254740993012", savingsCapacityMinor: "-6" },
      { month: "2026-11-01", incomeMinor: "12", expensesMinor: invalid ? 0 : "-12", savingsCapacityMinor: "24" },
    ] } });
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  return { api: createAnalytics(requestInWorkspace, workspace), send, read, mixed: () => { mixed = true; }, invalid: () => { invalid = true; },
    empty: () => { empty = true; }, revoke: () => { membership = false; } };
}

test("shows exact category spending and monthly income vs net expenses, not cash-flow net masquerading as expense", async () => {
  const f = setup(); await render(<AnalyticsScreen api={f.api} back={jest.fn()} initial={period} />);
  expect(await screen.findByText("Vivienda: 9007199254740993,012 KWD · 100,01 %")).toBeTruthy();
  for (const text of ["Ingresos del período: 9007199254740993,018 KWD", "Gastos netos del período: 9007199254740993,000 KWD", "2026-10", "2026-11",
    "Ingresos: 9007199254740993,006 KWD", "Gastos netos: 9007199254740993,012 KWD", "Flujo neto: −0,006 KWD", "Gastos netos: −0,012 KWD",
    "Moneda base: KWD", "Vigencia de tipos de cambio: desconocida"]) expect(screen.getByText(text)).toBeTruthy();
  const calls = f.send.mock.calls.map(([url]) => url.replace("https://api.invalid", ""));
  for (const path of [totals, cash, monthly]) {
    const at = calls.findIndex((url) => url.startsWith(`${path}?`));
    expect(at).toBeGreaterThan(1);
    expect(calls[at]).toContain("from=2026-10-22&to=2026-11-21");
  }
  expect(calls.filter((url) => url === "/v1/me")).toHaveLength(3);
  expect(calls.filter((url) => url === "/v1/workspaces")).toHaveLength(3);
  f.send.mockClear();
  await fireEvent.changeText(screen.getByLabelText("Desde (AAAA-MM-DD)"), "2026-11-22");
  await fireEvent.press(screen.getByRole("button", { name: "Aplicar período" }));
  expect(await screen.findByText("Revisa el período del informe.")).toBeTruthy(); expect(f.send).not.toHaveBeenCalled();
});

test("refuses repeated or invalid periods before session/storage and does not dispatch after revocation", async () => {
  const f = setup();
  for (const bad of [{ ...period, to: [period.to] }, { ...period, granularity: "day" }, { from: "2026-02-29", to: period.to }, new URLSearchParams("from=2026-10-01&from=2026-10-01")]) {
    await expect(f.api.breakdown(bad)).rejects.toThrow("Revisa el período del informe.");
  }
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(SecureStore.getItemAsync).not.toHaveBeenCalled(); expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  f.revoke(); await expect(f.api.breakdown(period)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
});

test("keeps category absence distinct from a malformed amount or foreign currency", async () => {
  const f = setup(); f.empty(); await render(<AnalyticsScreen api={f.api} back={jest.fn()} initial={period} />);
  expect(await screen.findByText("No hay gastos por categoría para este período.")).toBeTruthy();
  const foreign = setup(); foreign.mixed(); await expect(foreign.api.breakdown(period)).rejects.toThrow();
  const malformed = setup(); malformed.invalid(); await expect(malformed.api.breakdown(period)).rejects.toThrow();
});
