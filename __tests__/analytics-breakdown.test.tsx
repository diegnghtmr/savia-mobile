import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createAnalytics } from "../src/foundation/analytics";
import { createTransport } from "../src/foundation/transport";
import { AnalyticsScreen } from "../src/mobile-shell/analytics-screen";
import { DashboardScreen } from "../src/mobile-shell/dashboard-screen";

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
    if (pathname === "/v1/subscriptions") return reply({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } });
    if (pathname === cash) return reply({ series: [{ period: "2026-10-01", value: amount("-6"), secondaryValue: amount("-6") }],
      categories: empty ? [] : [{ categoryId: category, categoryName: "Vivienda", amount: amount("9007199254740993012", mixed ? "USD" : "KWD"), percentage: 100.01 }] });
    expect(pathname).toBe(monthly);
    const metric = searchParams.get("metric"), generatedAt = "2026-11-21T00:00:00Z";
    const envelope = { metric, generatedAt, currency: "KWD", assumptions: ["Conversión a fecha de valoración"], missingData: ["Sin valoración cambiaria inicial"] };
    if (metric === "financial_calendar") return reply({ ...envelope, data: { periodStart: from, periodEnd: to, days: [] } });
    if (metric === "net_worth_history") return reply({ ...envelope, fxRatesUsed: [
      { baseCurrency: "USD", quoteCurrency: "KWD", rate: "0.307000", rateDate: "2026-11-01", source: "manual", freshness: "fresh" },
    ], data: { series: [{ date: "2026-11-01", assets: amount("7500"), debts: amount("2500"), netWorth: amount("5000"), fxValuationChange: null }] } });
    if (metric === "spending_heatmap") return reply({ ...envelope, data: { cells: [{ weekday: invalid ? 8 : 7, dayOfMonth: 1, amount: amount("-1000"), count: 2 }] } });
    expect(metric).toBe("monthly_savings_capacity");
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

test.each([["Trimestre", "quarter"], ["Año", "year"]])("loads %s cash flow with all contract filters and reports actual rates", async (label, granularity) => {
  const f = setup();
  const normal = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) => {
    const response = await normal(url, init);
    if (!new URL(url).searchParams.has("granularity")) return response;
    const amount = { currency: "EUR", amountMinor: "-120" };
    return { ...response, json: async () => ({ categories: [], series: [{ period: "2026-01-01", value: amount, secondaryValue: amount }],
      fxRatesUsed: [{ baseCurrency: "USD", quoteCurrency: "EUR", rate: "0.93", rateDate: "2026-10-15", source: "frankfurter", freshness: "stale" }] }) };
  });
  await render(<AnalyticsScreen api={f.api} back={jest.fn()} initial={period} />);
  await screen.findByText(/Vivienda:/); await fireEvent.press(screen.getByRole("button", { name: "Flujo de caja" }));
  await screen.findByText("2026-01-01 · Flujo neto: −1,20 EUR · Acumulado: −1,20 EUR");
  await fireEvent.press(screen.getByRole("button", { name: label }));
  await fireEvent.changeText(screen.getByLabelText("Moneda de presentación"), "eur");
  const labels = ["Cuentas", "Categorías", "Etiquetas", "Contrapartes", "Miembros"];
  for (let i = 0; i < labels.length; i++) {
    await fireEvent.changeText(screen.getByLabelText(`${labels[i]} (IDs separados por comas)`), i === 0 ? `${id(4)}, ${id(5)}` : id(i + 5));
  }
  f.send.mockClear(); await fireEvent.press(screen.getByRole("button", { name: "Aplicar período" }));
  await screen.findByText("USD → EUR · 0.93 · 2026-10-15 · frankfurter · Desactualizada");
  const query = new URL(f.send.mock.calls.find(([url]) => new URL(url).pathname === cash)![0]).searchParams;
  expect([...query]).toEqual([["from", period.from], ["to", period.to], ["granularity", granularity], ["presentationCurrency", "EUR"],
    ["accountIds", id(4)], ["accountIds", id(5)], ["categoryIds", id(6)], ["tagIds", id(7)], ["payeeIds", id(8)], ["memberIds", id(9)]]);
  expect(screen.queryByText("Vigencia de tipos de cambio: desconocida")).toBeNull();
});

test("cash flow rejects duplicate filters before session and maps verified missing routes without masking authorization", async () => {
  const f = setup(), normal = f.send.getMockImplementation()!; let status = 404;
  f.send.mockImplementation(async (url, init) => {
    const response = await normal(url, init); return new URL(url).pathname === cash ? { ...response, status, ok: false } : response;
  });
  await expect(f.api.cashFlow(period, { granularity: "year", accountIds: `${id(4)},${id(4)}` })).rejects.toThrow("Revisa los filtros de analítica.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  for (const failure of [404, 501, 403]) {
    status = failure;
    const result = f.api.cashFlow(period, { granularity: "quarter" });
    if (failure === 403) await expect(result).rejects.toMatchObject({ status: 403 });
    else await expect(result).rejects.toThrow("Esta función no está disponible en este servidor.");
  }
});

test("advanced reports expose typed table rows, disclosures, and the rates applied to valuations", async () => {
  const f = setup(); await render(<AnalyticsScreen api={f.api} back={jest.fn()} initial={period} />);
  await screen.findByText(/Vivienda:/); await fireEvent.press(screen.getByRole("button", { name: "Métricas avanzadas" }));
  expect(await screen.findByRole("row", { name: "Fecha: 2026-11-01. Activos: 7,500 KWD. Deudas: 2,500 KWD. Patrimonio neto: 5,000 KWD. Variación cambiaria: No disponible" })).toBeTruthy();
  for (const text of ["2026-11-01", "7,500 KWD", "2,500 KWD", "5,000 KWD", "No disponible", "Conversión a fecha de valoración",
    "Sin valoración cambiaria inicial", "USD → KWD · 0.307000 · 2026-11-01 · manual · Vigente"]) expect(screen.getByText(text)).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Mapa de calor de gastos" }));
  await fireEvent.changeText(screen.getByLabelText("Cuentas (IDs separados por comas)"), id(4));
  await fireEvent.press(screen.getByRole("button", { name: "Aplicar período" }));
  expect(await screen.findByRole("row", { name: "Día de la semana: Domingo. Día del mes: 1. Gasto neto: −1,000 KWD. Movimientos: 2" })).toBeTruthy();
  expect(screen.getByText("Domingo")).toBeTruthy(); expect(screen.getByText("−1,000 KWD")).toBeTruthy();
  const query = new URL(f.send.mock.calls.at(-1)![0]).searchParams;
  expect([...query]).toEqual([["from", period.from], ["to", period.to], ["metric", "spending_heatmap"], ["accountIds", id(4)]]);
  f.invalid(); await expect(f.api.advanced(period, "spending_heatmap")).rejects.toThrow(TypeError);
  f.send.mockClear(); f.read.mockClear();
  await expect(f.api.advanced(period, "unsupported")).rejects.toThrow("Selecciona una métrica válida.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

test("the dashboard summary displays the server's valuation freshness rather than inferring it from today's date", async () => {
  const f = setup(), normal = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    return new URL(url).pathname === totals ? { ...result, json: async () => Object.assign({}, await result.json(), { fxRatesUsed: [
      { baseCurrency: "USD", quoteCurrency: "KWD", rate: "0.307000", rateDate: "2026-11-01", source: "frankfurter", freshness: "fresh" },
    ] }) } : result;
  });
  await render(<DashboardScreen api={f.api} back={jest.fn()} initial={period} now={new Date("2026-12-01T00:00:00Z")} />);
  await screen.findByText("USD → KWD · 0.307000 · 2026-11-01 · frankfurter · Vigente");
  expect(screen.queryByText("Vigencia de tipos de cambio: desconocida")).toBeNull();
});

test("keeps category absence distinct from a malformed amount or foreign currency", async () => {
  const f = setup(); f.empty(); await render(<AnalyticsScreen api={f.api} back={jest.fn()} initial={period} />);
  expect(await screen.findByText("No hay gastos por categoría para este período.")).toBeTruthy();
  const foreign = setup(); foreign.mixed(); await expect(foreign.api.breakdown(period)).rejects.toThrow();
  const malformed = setup(); malformed.invalid(); await expect(malformed.api.breakdown(period)).rejects.toThrow();
});

// Reviewer regression (verify mwtv01w4). __tests__/analytics-breakdown.test.tsx (append).
test("dashboard shows the applied FX rates from the upcoming calendar response", async () => {
  const f = setup(), normal = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (url, init) => {
    const response = await normal(url, init), { searchParams } = new URL(url);
    if (searchParams.get("metric") !== "financial_calendar") return response;
    return { ...response, json: async () => ({ ...(await response.json() as object), fxRatesUsed: [
      { baseCurrency: "USD", quoteCurrency: "KWD", rate: "0.307000", rateDate: "2026-11-01", source: "manual", freshness: "unknown" },
    ], data: { periodStart: searchParams.get("from"), periodEnd: searchParams.get("to"), totalExpectedInflowMinor: "0", totalExpectedOutflowMinor: "3070",
      debtsWithoutScheduledAmount: 0, recurringRulesWithUnreadableTemplate: 0, days: [{ date: "2026-11-02", expectedInflowMinor: "0", expectedOutflowMinor: "3070",
        items: [{ kind: "recurring_rule", refId: id(4), label: "Cuota", state: "scheduled", direction: "outflow", amountMinor: "3070" }] }] } }) };
  });
  await render(<DashboardScreen api={f.api} back={jest.fn()} initial={period} now={new Date("2026-11-01T00:00:00Z")} />);
  await screen.findByText(/Cuota: 3,070 KWD/);
  expect(screen.getByText("USD → KWD · 0.307000 · 2026-11-01 · manual · Desconocida")).toBeTruthy();
});

test("all 12 authority metrics produce nonempty, typed result tables", () => {
  const { advancedMetrics, parseAdvancedMetric } = require("../src/foundation/advanced-analytics") as typeof import("../src/foundation/advanced-analytics");
  const day = "2026-10-01", range = { periodStart: day, periodEnd: day }, month = { month: day };
  const zero = { currency: "KWD", amountMinor: "0" }, item = { subscriptionId: id(4), payeeName: "Ejemplo", currentAmount: zero };
  const flow = { expectedInflowMinor: "12", expectedOutflowMinor: "0" };
  const fixtures = {
    net_worth_history: [{ series: [{ date: day, assets: zero, debts: zero, netWorth: zero, fxValuationChange: null }] }, "No disponible"],
    spending_heatmap: [{ cells: [{ weekday: 1, dayOfMonth: 1, amount: zero, count: 0 }] }, "Lunes"],
    recurring_vs_variable: [{ ...range, committedMinor: "12", variableMinor: "0", totalExpensesMinor: "12", committedPercent: null,
      consideredSubscriptionCount: 1, unclassifiedSubscriptionCount: 0 }, "0,012 KWD"],
    financial_calendar: [{ ...range, totalExpectedInflowMinor: "12", totalExpectedOutflowMinor: "0", debtsWithoutScheduledAmount: 0,
      recurringRulesWithUnreadableTemplate: 0, days: [{ date: day, ...flow, items: [{ kind: "reminder", refId: id(4), label: "Aviso", state: "scheduled", direction: "none", amountMinor: null }] }] }, "Aviso (previsto, sin importe)"],
    weekday_heatmap: [{ series: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, transactionCount: 0, totalMinor: "0" })) }, "Domingo"],
    balance_projection: [{ openingBalanceMinor: "0", basisMonths: 0, meanMonthlyIncomeMinor: "0", meanMonthlyExpensesMinor: "0",
      months: [{ ...month, ...flow, projectedBalanceMinor: "12" }] }, "0,012 KWD"],
    quarterly_average_comparison: [{ series: [{ quarter: "2026-Q4", monthsCounted: 1, averageMonthlyIncomeMinor: "12", averageMonthlyExpensesMinor: "0",
      averageMonthlySavingsCapacityMinor: "12", savingsCapacityDeltaPercentVsPreviousQuarter: null }] }, "2026-Q4"],
    subscription_price_increases: [{ items: [{ ...item, previousAmount: zero, increasePercent: 25 }], consideredCount: 1,
      decreasedOrUnchangedCount: 0, excludedForCurrencyMismatch: 0, excludedForZeroPrevious: 0 }, "25 %"],
    income_stability: [{ monthsCounted: 0, meanMonthlyIncomeMinor: "0", minMonthlyIncomeMinor: "0", maxMonthlyIncomeMinor: "0", medianMonthlyIncomeMinor: "0",
      coefficientOfVariationPercent: null, trendPercent: null, regularityPercent: null, sourceConcentration: [{ payeeId: null, amount: zero, sharePercent: 0 }] }, "Sin identificar"],
    monthly_savings_capacity: [{ series: [{ ...month, incomeMinor: "12", expensesMinor: "0", savingsCapacityMinor: "12", recurringIncomeMinor: "0",
      essentialExpensesMinor: "0", discretionaryExpensesMinor: "0", obligationsMinor: "0", currentSavingsMinor: "0" }] }, "0,012 KWD"],
    debt_cost_evolution: [{ totalInterestMinor: "12", totalFeeMinor: "0", totalCostMinor: "12", debtOutlook: [{ debtId: id(5), estimatedFutureCost: null,
      estimatedRemainingMonths: null }], series: [{ ...month, principalPaidMinor: "0", paymentsMinor: "12", interestMinor: "12", feeMinor: "0", totalCostMinor: "12" }] }, "No disponible"],
    subscription_annual_cost: [{ items: [{ ...item, frequency: "monthly", annualCost: null }], totalAnnualCost: zero }, "No disponible"],
  } as const;
  expect(Object.keys(advancedMetrics).sort()).toEqual(Object.keys(fixtures).sort());
  for (const metric of Object.keys(fixtures) as (keyof typeof fixtures)[]) {
    const [data, expected] = fixtures[metric];
    const result = parseAdvancedMetric({ metric, generatedAt: `${day}T00:00:00Z`, currency: "KWD", assumptions: [], missingData: [], data }, metric);
    expect(result.tables.flatMap(({ rows }) => rows.flat())).toContain(expected);
    for (const table of result.tables) expect(table.rows.every((row) => row.length === table.headers.length)).toBe(true);
  }
});
