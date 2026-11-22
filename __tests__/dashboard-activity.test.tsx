import { render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createAnalytics } from "../src/foundation/analytics";
import { createTransport } from "../src/foundation/transport";
import { DashboardScreen } from "../src/mobile-shell/dashboard-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
const id = (n: number) => `abcdea00-0000-4000-8000-00000000000${n}`;
const [workspace, profile, rule, sub] = [1, 2, 3, 4].map(id);
const period = { from: "2026-11-01", to: "2026-11-21" }, now = new Date("2026-11-21T21:00:00.000Z");
const upcoming = { from: "2026-11-21", to: "2026-12-21" }, date = "2026-12-01";
const summary = "/v1/analytics/summary", calendar = "/v1/analytics/advanced", subscriptions = "/v1/subscriptions";
function setup() {
  jest.clearAllMocks(); jest.mocked(SecureStore.getItemAsync).mockResolvedValue(workspace);
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let calendarStatus = 200, membership = true, revokeAfterSummary = false, invalidCalendar = false, empty = false;
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), scope = new Headers(init.headers).get("X-Workspace-Id");
    const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
    const reply = (body: unknown, status = 200) => ({ status, ok: status === 200, headers: new Headers(), redirected: false, json: async () => body });
    if (pathname === "/v1/me") { expect(scope).toBeNull(); return reply({ id: profile }); }
    if (pathname === "/v1/workspaces") { expect(scope).toBeNull(); return reply(page(membership ? [{ id: workspace, name: "Casa" }] : [])); }
    expect(scope).toBe(workspace); expect(init.method).toBe("GET");
    if (pathname === summary) {
      if (revokeAfterSummary) membership = false;
      const amount = { amountMinor: "0", currency: "KWD" };
      return reply({ periodStart: searchParams.get("from"), periodEnd: searchParams.get("to"), baseCurrency: "KWD", netWorth: amount,
        income: amount, expenses: amount, savingsCapacity: amount });
    }
    if (pathname === calendar) {
      expect(Object.fromEntries(searchParams)).toEqual({ ...upcoming, metric: "financial_calendar" });
      return reply({ metric: "financial_calendar", generatedAt: now.toISOString(), data: { periodStart: upcoming.from, periodEnd: upcoming.to,
        days: empty ? [] : [{ date: invalidCalendar ? "2026-11-20" : date, expectedOutflowMinor: "9007199254740993012", items: [
          { kind: "recurring_rule", refId: rule, label: "Alquiler", amountMinor: "9007199254740993012" },
          { kind: "debt_payment", refId: sub, label: "Préstamo", amountMinor: "12" },
        ] }], totalExpectedOutflowMinor: "9007199254740993024", debtsWithoutScheduledAmount: 0, recurringRulesWithUnreadableTemplate: 0 } }, calendarStatus);
    }
    expect(pathname).toBe(subscriptions); expect(Object.fromEntries(searchParams)).toEqual({ limit: "5", status: "detected" });
    return reply(page(empty ? [] : [{ id: sub, payeeName: "Música", currentAmount: { currency: "JPY", amountMinor: "9007199254740993" },
      frequency: "monthly", nextExpectedAt: `${date}T01:30:00.000Z`, status: "detected" }]));
  });
  const api = createAnalytics(createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace, workspace);
  return { api, read, send, failCalendar: (status: number) => { calendarStatus = status; }, revoke: () => { revokeAfterSummary = true; },
    invalidate: () => { invalidCalendar = true; }, empty: () => { empty = true; } };
}

test("shows upcoming calendar outflows in base currency and detected subscriptions in their native currency", async () => {
  const f = setup(); await render(<DashboardScreen api={f.api} back={jest.fn()} initial={period} now={now} />);
  expect(await screen.findByText("Patrimonio neto: 0,000 KWD")).toBeTruthy();
  for (const text of ["Próximos movimientos recurrentes", "2026-12-01 · Alquiler: 9007199254740993,012 KWD", "Suscripciones detectadas",
    "Música: 9007199254740993 JPY", "Próximo cargo estimado: 2026-12-01", "Vigencia de tipos de cambio: desconocida"]) expect(screen.getByText(text)).toBeTruthy();
  expect(screen.queryByText(/Préstamo/)).toBeNull();
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([summary, calendar, subscriptions].flatMap((path) => ["/v1/me", "/v1/workspaces", path]));
});

test("invalid ranges cannot start any of the three reads and revocation between them blocks the rest", async () => {
  const f = setup();
  await expect(f.api.dashboard(period, { ...upcoming, from: [upcoming.from] })).rejects.toThrow("Revisa el período del informe.");
  await expect(f.api.dashboard({ ...period, to: "2026-02-29" }, upcoming)).rejects.toThrow("Revisa el período del informe.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(SecureStore.getItemAsync).not.toHaveBeenCalled(); expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  f.revoke(); await expect(f.api.dashboard(period, upcoming)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces", summary, "/v1/me", "/v1/workspaces"]);
});

test("a missing calendar rate or malformed calendar leaves other sections visible, not a false empty calendar", async () => {
  const f = setup(); f.failCalendar(422);
  await render(<DashboardScreen api={f.api} back={jest.fn()} initial={period} now={now} />);
  expect(await screen.findByText("No pudimos cargar los próximos movimientos.")).toBeTruthy();
  expect(screen.getByText("Patrimonio neto: 0,000 KWD")).toBeTruthy(); expect(screen.getByText("Música: 9007199254740993 JPY")).toBeTruthy();
  expect(screen.queryByText("No hay movimientos recurrentes previstos.")).toBeNull();
  const malformed = setup(); malformed.invalidate(); await expect(malformed.api.dashboard(period, upcoming)).resolves.toMatchObject({ upcoming: null });
  const empty = setup(); empty.empty(); await expect(empty.api.dashboard(period, upcoming)).resolves.toMatchObject({ upcoming: [], subscriptions: { items: [] } });
});
