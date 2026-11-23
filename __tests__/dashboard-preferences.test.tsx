import { fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as send } from "expo/fetch";
import * as Storage from "expo-secure-store";
import Index from "../src/app/index";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-sqlite");
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, getRandomBytesAsync: async (n: number) => require("node:crypto").randomBytes(n),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: async (_: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex") }));
jest.mock("../src/foundation/config", () => ({ readApiOrigin: () => "https://api.invalid" }));
const mockRead = jest.fn();
jest.mock("../src/foundation/auth", () => ({ getAuth: () => ({ readSession: mockRead, localPrincipal: async () => "dashboard-preferences-fixture" }) }));

const [profile, space] = [1, 2].map((n) => `fade0000-0000-4000-8000-00000000030${n}`);
const path = "/v1/me/dashboard-preferences", stamp = "2026-11-25T00:00:00Z";
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);
function setup({ stale = 0, missing = 0 } = {}) {
  jest.clearAllMocks(); mockRead.mockResolvedValue({ accessToken: "fixture" });
  jest.mocked(Storage.getItemAsync).mockImplementation(async (key) => key === `savia.workspace.${profile}` ? space : key === "savia.offline.key.v1" ? "a".repeat(64) : null);
  const requests: { body: unknown; key: string | null; match: string | null }[] = [], queries: string[] = [];
  let reads = 0, down = false;
  let effective = { cards: [{ id: "net_worth", visible: true }, { id: "income", visible: true }, { id: "expenses", visible: true }],
    period: { preset: "custom", from: "2026-10-01", to: "2026-10-31" }, presentationCurrency: "USD", version: 1 };
  jest.mocked(send).mockImplementation((async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200, tag?: string) => ({ status, ok: status < 300, redirected: false,
      headers: new Headers({ Date: new Date(stamp).toUTCString(), ...(tag && { ETag: tag }) }), json: async () => body });
    const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
    if (down) throw new Error("offline");
    if (pathname === "/v1/me") return reply({ id: profile });
    if (pathname === "/v1/workspaces") return reply(page([{ id: space, name: "Casa" }]));
    expect(headers.get("X-Workspace-Id")).toBe(space);
    if (pathname === path) {
      if (missing) return reply({}, missing);
      if (init.method === "GET") { reads++; return reply(effective, 200, `"prefs-${effective.version}"`); }
      expect(init.method).toBe("PUT");
      const body = JSON.parse(String(init.body)); requests.push({ body, key: headers.get("Idempotency-Key"), match: headers.get("If-Match") });
      if (stale) { effective = { ...effective, presentationCurrency: "EUR", version: 2 }; return reply({}, stale); }
      effective = { ...body, version: effective.version + 1 }; return reply(effective, 200, `"prefs-${effective.version}"`);
    }
    const from = searchParams.get("from"), to = searchParams.get("to");
    if (pathname.endsWith("/summary")) {
      queries.push(searchParams.toString()); const currency = searchParams.get("presentationCurrency") ?? "USD", amount = { amountMinor: "100", currency };
      return reply({ periodStart: from, periodEnd: to, baseCurrency: currency, netWorth: amount, income: amount, expenses: amount, savingsCapacity: amount });
    }
    if (pathname.endsWith("/advanced")) return reply({ metric: "financial_calendar", generatedAt: stamp, data: { periodStart: from, periodEnd: to, days: [] } });
    expect(pathname).toBe("/v1/subscriptions"); return reply(page([]));
  }) as typeof send);
  return { requests, queries, reads: () => reads, disconnect: () => { down = true; } };
}
async function dashboard() { const view = await render(<Index />); await press("Resumen financiero"); return view; }

test("reorders and hides display cards, validates a custom period before session, and saves currency and period with conditional idempotency", async () => {
  const f = setup(); await dashboard(); await screen.findByText("Patrimonio neto: 1,00 USD");
  expect(f.queries[0]).toBe("from=2026-10-01&to=2026-10-31&presentationCurrency=USD");
  await press("Personalizar resumen"); await press("Subir: Ingresos"); await press("Ocultar: Gastos netos");
  await enter("Moneda de presentación", "eur"); await enter("Desde (AAAA-MM-DD)", "2026-02-29"); mockRead.mockClear();
  await press("Guardar preferencias"); await screen.findByText("Revisa las preferencias del resumen.");
  expect(mockRead).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  await enter("Desde (AAAA-MM-DD)", "2026-10-02"); await press("Guardar preferencias"); await screen.findByText("Preferencias guardadas.");
  expect(f.requests).toEqual([{ match: '"prefs-1"', key: expect.any(String), body: { cards: [{ id: "income", visible: true }, { id: "net_worth", visible: true }, { id: "expenses", visible: false }],
    period: { preset: "custom", from: "2026-10-02", to: "2026-10-31" }, presentationCurrency: "EUR" } }]);
  await press("Volver al informe"); await screen.findByText("Ingresos: 1,00 EUR");
  expect(screen.queryByText("Gastos netos: 1,00 EUR")).toBeNull();
  expect(screen.getAllByText(/^(Ingresos|Patrimonio neto): 1,00 EUR$/).map((node) => node.props.children.join?.("") ?? node.props.children))
    .toEqual(["Ingresos: 1,00 EUR", "Patrimonio neto: 1,00 EUR"]);
});

test.each([409, 412])("a preference conflict (%s) replaces the draft without resubmitting", async (stale) => {
  const f = setup({ stale }); await dashboard(); await press("Personalizar resumen"); await enter("Moneda de presentación", "COP");
  await press("Guardar preferencias"); await screen.findByText("Las preferencias cambiaron. Revisa los datos actualizados.");
  expect((await screen.findByLabelText("Moneda de presentación")).props.value).toBe("EUR");
  expect(f.requests).toHaveLength(1); expect(f.reads()).toBe(3);
});

test("offline dashboard uses cached preferences only for display", async () => {
  const f = setup(), first = await dashboard(); await screen.findByText("Moneda base: USD"); await first.unmount();
  f.disconnect(); await dashboard(); await screen.findByText("Patrimonio neto: 1,00 USD");
  await press("Personalizar resumen"); await screen.findByText("No pudimos cargar las preferencias en línea.");
  expect(screen.queryByRole("button", { name: "Guardar preferencias" })).toBeNull(); expect(f.requests).toEqual([]);
});

test.each([404, 501])("unavailable preferences route (%s) leaves the normal dashboard usable", async (missing) => {
  const f = setup({ missing }); await dashboard(); await screen.findByText("Patrimonio neto: 1,00 USD");
  await press("Personalizar resumen"); await screen.findByText("Esta función no está disponible en este servidor.");
  expect(screen.queryByRole("button", { name: "Guardar preferencias" })).toBeNull(); expect(f.requests).toEqual([]);
});

test("a saved month still starts on the first UTC day of the current month", async () => {
  jest.useFakeTimers({ now: new Date("2026-11-01T00:00:00Z"), doNotFake: ["performance"] });
  try {
    const f = setup(), normal = jest.mocked(send).getMockImplementation()!;
    jest.mocked(send).mockImplementation(async (...args) => {
      const response = await normal(...args);
      if (new URL(String(args[0])).pathname !== path) return response;
      const body = await response.json() as object;
      return Object.assign(response, { json: async () => ({ ...body, period: { preset: "this_month" } }) });
    });
    await dashboard(); await screen.findByText("Patrimonio neto: 1,00 USD");
    expect(screen.getByText(/No pudimos verificar la zona horaria.*UTC/)).toBeTruthy();
    expect(f.queries).toEqual(["from=2026-11-01&to=2026-11-01&presentationCurrency=USD"]);
  } finally { jest.useRealTimers(); }
});

// Reviewer regression (verify mwtv01w4). __tests__/dashboard-preferences.test.tsx (append).
test.each([["this_quarter", "2026-10-01"], ["this_year", "2026-01-01"]])("honors a saved %s in UTC when workspace time zone is unavailable", async (preset, from) => {
  jest.useFakeTimers({ now: new Date("2026-11-25T12:00:00Z"), doNotFake: ["performance"] });
  try {
    const f = setup(), normal = jest.mocked(send).getMockImplementation()!;
    jest.mocked(send).mockImplementation(async (...args) => {
      const response = await normal(...args);
      if (new URL(String(args[0])).pathname !== path) return response;
      const body = await response.json() as object;
      return Object.assign(response, { json: async () => ({ ...body, period: { preset } }) });
    });
    await dashboard(); await screen.findByText("Patrimonio neto: 1,00 USD");
    expect(screen.getByText(/No pudimos verificar la zona horaria.*UTC/)).toBeTruthy();
    expect(f.queries[0]).toBe(`from=${from}&to=2026-11-25&presentationCurrency=USD`);
  } finally { jest.useRealTimers(); }
});
