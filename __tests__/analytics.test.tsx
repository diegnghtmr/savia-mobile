import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createAnalytics } from "../src/foundation/analytics";
import { createTransport } from "../src/foundation/transport";
import { DashboardScreen } from "../src/mobile-shell/dashboard-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
const [workspace, profile] = [1, 2].map((n) => `a11ca000-0000-4000-8000-00000000000${n}`);
const period = { from: "2026-11-01", to: "2026-11-21" }, summaryPath = "/v1/analytics/summary";
function setup(currency = "KWD") {
  jest.clearAllMocks(); jest.mocked(SecureStore.getItemAsync).mockResolvedValue(workspace);
  const amount = (amountMinor: string, code = currency) => ({ currency: code, amountMinor });
  let revoked = false, badCurrency = false, badPeriod = false;
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), scope = new Headers(init.headers).get("X-Workspace-Id");
    const reply = (body: unknown) => ({ status: 200, ok: true, headers: new Headers(), redirected: false, json: async () => body });
    expect(init.method).toBe("GET");
    if (pathname === "/v1/me") { expect(scope).toBeNull(); return reply({ id: profile }); }
    if (pathname === "/v1/workspaces") { expect(scope).toBeNull(); return reply({ items: revoked ? [] : [{ id: workspace, name: "Casa" }], pageInfo: { hasNextPage: false } }); }
    expect(scope).toBe(workspace);
    const from = searchParams.get("from"), to = searchParams.get("to");
    if (pathname === "/v1/analytics/advanced") return reply({ metric: "financial_calendar", generatedAt: "2026-11-21T00:00:00Z", data: { periodStart: from, periodEnd: to, days: [] } });
    if (pathname === "/v1/subscriptions") return reply({ items: [], pageInfo: { hasNextPage: false } });
    expect(pathname).toBe(summaryPath);
    return reply({ periodStart: badPeriod ? "2025-11-01" : from, periodEnd: to, baseCurrency: currency,
      netWorth: amount("9007199254740993012", badCurrency ? "USD" : currency), assets: amount("9100000000000000000"), debts: amount("92800745259006988"),
      income: amount("12343"), expenses: amount("-12"), savingsCapacity: amount("12355"), ...(from === period.from ? { budgetUtilizationPercent: 0 } : {}) });
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  return { api: createAnalytics(requestInWorkspace, workspace), read, send, revoke: () => { revoked = true; },
    mismatch: () => { badCurrency = true; }, wrongPeriod: () => { badPeriod = true; }, calls: () => send.mock.calls.map(([url]) => url.replace("https://api.invalid", "")) };
}

const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);

test("rejects malformed or repeated period inputs before session, network or storage", async () => {
  const f = setup();
  for (const filters of [undefined, null, [period], {}, { from: period.from }, { ...period, from: "2026-02-29" }, { ...period, from: "2026-11-22" },
    { ...period, from: [period.from] }, { ...period, to: "2026-11-21T00:00:00Z" }, { ...period, to: ` ${period.to}` }, { ...period, presentationCurrency: "USD" },
    new URLSearchParams(`from=${period.from}&from=${period.from}&to=${period.to}`)]) {
    await expect(f.api.summary(filters)).rejects.toThrow("Revisa el período del informe.");
  }
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  expect(SecureStore.getItemAsync).not.toHaveBeenCalled(); expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

test("verifies membership before the summary, accepts a one-day leap-day period and rejects mismatched response scope", async () => {
  const f = setup();
  await expect(f.api.summary({ from: "2024-02-29", to: "2024-02-29" })).resolves.toMatchObject({ currency: "KWD", budget: null });
  expect(f.calls()).toEqual(["/v1/me", "/v1/workspaces", `${summaryPath}?from=2024-02-29&to=2024-02-29`]);
  f.mismatch(); await expect(f.api.summary(period)).rejects.toThrow();
  const g = setup(); g.wrongPeriod(); await expect(g.api.summary(period)).rejects.toThrow();
  g.send.mockClear(); g.revoke(); await expect(g.api.summary(period)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(g.calls()).toEqual(["/v1/me", "/v1/workspaces"]);
});

test.each([["KWD", "9007199254740993,012", "0,012", "12,355"], ["JPY", "9007199254740993012", "12", "12355"], ["COP", "90071992547409930,12", "0,12", "123,55"]])(
  "shows exact %s net worth, signed expenses, cash flow, budget and truthful FX freshness",
  async (currency, worth, expense, flow) => {
    const f = setup(currency);
    await render(<DashboardScreen api={f.api} back={jest.fn()} initial={period} />);
    expect(await screen.findByText(`Patrimonio neto: ${worth} ${currency}`)).toBeTruthy();
    expect(screen.getByText(`Gastos netos: −${expense} ${currency}`)).toBeTruthy();
    expect(screen.getByText(`Flujo neto: ${flow} ${currency}`)).toBeTruthy();
    expect(screen.getByText("Utilización del presupuesto: 0 %")).toBeTruthy();
    expect(screen.getByText("Vigencia de tipos de cambio: desconocida")).toBeTruthy();
    const before = f.calls();
    await enter("Hasta (AAAA-MM-DD)", "2026-10-31"); await press("Aplicar período");
    expect(await screen.findByText("Revisa el período del informe.")).toBeTruthy(); expect(f.calls()).toEqual(before);
    await enter("Desde (AAAA-MM-DD)", "2026-10-01"); await press("Aplicar período");
    expect(await screen.findByText("Utilización del presupuesto: No informada")).toBeTruthy();
    expect(f.calls().slice(before.length, before.length + 3)).toEqual(["/v1/me", "/v1/workspaces", `${summaryPath}?from=2026-10-01&to=2026-10-31`]);
  },
);
