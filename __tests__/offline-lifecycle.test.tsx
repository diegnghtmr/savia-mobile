// Reviewer regression (verify mwr70vb0). New file __tests__/offline-lifecycle.test.tsx.
import { fireEvent, render, screen } from "@testing-library/react-native";
import { fetch as nativeFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { offlineStore } from "../src/foundation/offline-db";
import Index from "../src/app/index";
import { getAuth } from "../src/foundation/auth";

jest.mock("expo-sqlite");
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("../src/foundation/auth", () => ({ getAuth: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  randomUUID: require("node:crypto").randomUUID,
  digestStringAsync: async (_: string, input: string) => require("node:crypto").createHash("sha256").update(input).digest("hex"),
  getRandomBytesAsync: async (size: number) => require("node:crypto").randomBytes(size),
}));

const expoFetch: (...args: Parameters<typeof nativeFetch>) => Promise<Pick<Awaited<ReturnType<typeof nativeFetch>>, "status" | "ok" | "headers" | "redirected" | "json">> = nativeFetch;
const uid = (n: number) => "abca0000-0000-4000-8000-00000000000" + n;
const [profile, workspace, account, receipt] = [1, 2, 3, 4].map(uid);
const source = "https://api.invalid";
const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, nextCursor: null } });
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const enter = async (name: string, value: string) => fireEvent.changeText(await screen.findByLabelText(name), value);
const ledger = "/v1/transactions";

const storage = new Map([["savia.workspace." + profile, workspace]]);
async function setup() {
  jest.clearAllMocks();
  const active = jest.spyOn(AppState, "addEventListener").mockReturnValue({ remove: jest.fn() });
  const previous = process.env.EXPO_PUBLIC_SAVIA_API_URL;
  process.env.EXPO_PUBLIC_SAVIA_API_URL = source;
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async name => storage.get(name) ?? null);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (name, value) => { storage.set(name, value); });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async name => { storage.delete(name); });
  jest.mocked(getAuth).mockReturnValue({
    readSession: async () => ({ accessToken: "fixture" }),
    localPrincipal: async () => profile,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(async () => { throw new Error("Auth sign-out temporarily failed"); }),
    refreshSession: jest.fn(),
    exchangeCode: jest.fn(),
  });
  let online = true, operations = 0;
  const accountRow = {
    id: account, name: "Caja", type: "cash", status: "active",
    currency: "COP", includeInNetWorth: true,
  };
  jest.mocked(expoFetch).mockImplementation(async (url, init) => {
    if (!online) throw new Error("offline");
    const { pathname } = new URL(String(url));
    let body: unknown = page([]), status = 200;
    if (pathname === "/v1/me") body = { id: profile };
    if (pathname === "/v1/workspaces") body = page([{ id: workspace, name: "Casa" }]);
    if (pathname === "/v1/accounts") body = page([accountRow]);
    if (pathname.endsWith("/balance")) body = {
      accountId: account, nativeBalance: { amountMinor: "120", currency: "COP" },
      asOf: "2026-11-01T00:00:00Z",
    };
    if (pathname === ledger && init?.method === "POST") {
      operations++;
      status = 201;
      body = { id: receipt };
    }
    return {
      status, ok: true, redirected: false,
      headers: new Headers({ Date: "Sun, 01 Nov 2026 00:00:00 GMT" }),
      json: async () => JSON.parse(JSON.stringify(body)),
    } as never;
  });
  await offlineStore()(db => db.execAsync("DELETE FROM cache; DELETE FROM membership; DELETE FROM outbox;"));
  const view = await render(<Index />);
  await screen.findByRole("button", { name: "Movimientos" });
  return {
    online: (yes: boolean) => { online = yes; },
    effects: () => operations,
    async close() {
      await view.unmount();
      active.mockRestore();
      if (previous === undefined) delete process.env.EXPO_PUBLIC_SAVIA_API_URL;
      else process.env.EXPO_PUBLIC_SAVIA_API_URL = previous;
    },
  };
}

async function record() {
  await press("Nuevo movimiento"); await press("Gasto"); await press("Caja (COP)");
  await enter("Importe", "1,20"); await enter("Fecha (AAAA-MM-DD, UTC)", "2026-11-01");
  await press("Crear movimiento");
  expect(await screen.findByText("Guardado sin conexión. Revisa las operaciones pendientes.")).toBeTruthy();
}

async function warmMovements() {
  await press("Movimientos"); await screen.findByText("No hay movimientos para estos filtros.");
  await press("Nuevo movimiento"); await screen.findByRole("button", { name: "Caja (COP)" });
  await press("Cancelar");
}

test("two separate offline create forms keep two identical cash expenses", async () => {
  const f = await setup();
  try {
    await warmMovements(); f.online(false);
    await record(); await record();
    expect(screen.getByRole("button", { name: "Operaciones pendientes (2)" })).toBeTruthy();
    expect(f.effects()).toBe(0);
    f.online(true);
    await press("Operaciones pendientes (2)"); await press("Sincronizar ahora");
    await screen.findByRole("button", { name: "Operaciones pendientes (0)" });
    expect(f.effects()).toBe(2);
  } finally { await f.close(); }
});

test("a failed sign-out does not discard queued work or disable the active workspace", async () => {
  const f = await setup();
  try {
    await warmMovements(); f.online(false);
    await record(); await screen.findByRole("button", { name: "Operaciones pendientes (1)" });
    await press("Cerrar sesión"); await screen.findByText("No pudimos cerrar la sesión.");
    await press("Operaciones pendientes (1)");
    expect(screen.getByText("Pendiente de sincronización")).toBeTruthy();
    f.online(true); await press("Sincronizar ahora");
    await screen.findByRole("button", { name: "Operaciones pendientes (0)" });
    expect(f.effects()).toBe(1);
  } finally { await f.close(); }
});

test("a fresh online read clears the offline banner after reconnection", async () => {
  const f = await setup();
  try {
    await press("Cuentas"); await screen.findByRole("button", { name: "Caja" });
    await press("Volver al resumen"); f.online(false);
    await press("Cuentas"); await screen.findByRole("alert", { name: /Sin conexión — datos guardados el/ });
    await press("Volver al resumen"); f.online(true);
    await press("Movimientos"); await screen.findByText("No hay movimientos para estos filtros.");
    expect(screen.queryByRole("alert", { name: /Sin conexión — datos guardados el/ })).toBeNull();
  } finally { await f.close(); }
});

test("analytics keeps the offline banner when only one report falls back and clears it on an entirely fresh reload", async () => {
  const f = await setup();
  try {
    const network = jest.mocked(expoFetch), normal = network.getMockImplementation()!;
    let cashOffline = false;
    network.mockImplementation(async (url, init) => {
      const { pathname, searchParams } = new URL(String(url));
      if (!pathname.startsWith("/v1/analytics/")) return normal(url, init);
      expect(new Headers(init?.headers).get("X-Workspace-Id")).toBe(workspace);
      const amount = { currency: "COP", amountMinor: "12" };
      const from = searchParams.get("from")!, to = searchParams.get("to")!;
      let body: unknown = { periodStart: from, periodEnd: to, baseCurrency: "COP", netWorth: amount, income: amount, expenses: amount, savingsCapacity: amount };
      if (pathname.endsWith("/cash-flow")) {
        if (cashOffline) throw new Error("Disconnected while loading categories");
        body = { series: [], categories: [{ categoryId: account, categoryName: "Hogar", amount, percentage: 100 }] };
      } else if (pathname.endsWith("/advanced")) {
        body = { metric: "monthly_savings_capacity", generatedAt: "2026-11-21T00:00:00Z", data: { series: [
          { month: from, incomeMinor: "12", expensesMinor: "0", savingsCapacityMinor: "12" },
        ] } };
      }
      return { status: 200, ok: true, headers: new Headers(), redirected: false, json: async () => body } as never;
    });
    const banner = { name: /Sin conexión — datos guardados el/ };
    await press("Analítica"); await screen.findByText("Hogar: 0,12 COP · 100 %");
    expect(screen.queryByRole("alert", banner)).toBeNull();
    cashOffline = true; await press("Aplicar período");
    await screen.findByRole("alert", banner); await screen.findByText("Hogar: 0,12 COP · 100 %");
    cashOffline = false; await press("Aplicar período");
    await screen.findByText("Hogar: 0,12 COP · 100 %"); expect(screen.queryByRole("alert", banner)).toBeNull();
  } finally { await f.close(); }
});

// Reviewer regression (verify mwrbkwrv). Append to __tests__/offline-lifecycle.test.tsx.
import { act } from "@testing-library/react-native";

test("leaving a slow fresh report cannot clear the visible mixed report's offline banner", async () => {
  const f = await setup();
  try {
    const network = jest.mocked(expoFetch), normal = network.getMockImplementation()!;
    let pauseCalendar = false, cashOffline = false;
    let reached!: () => void, resume!: () => void, sent!: () => void;
    const holding = new Promise<void>(resolve => { reached = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    const subscribed = new Promise<void>(resolve => { sent = resolve; });
    network.mockImplementation(async (url, init) => {
      const { pathname, searchParams } = new URL(String(url));
      if (!pathname.startsWith("/v1/analytics/") && pathname !== "/v1/subscriptions") return normal(url, init);
      const amount = { currency: "COP", amountMinor: "12" };
      const from = searchParams.get("from")!, to = searchParams.get("to")!;
      let body: unknown = { periodStart: from, periodEnd: to, baseCurrency: "COP", netWorth: amount, income: amount, expenses: amount, savingsCapacity: amount };
      if (pathname.endsWith("/cash-flow")) {
        if (cashOffline) throw new Error("cash flow temporarily offline");
        body = { series: [], categories: [{ categoryId: account, categoryName: "Hogar", amount, percentage: 100 }] };
      } else if (pathname.endsWith("/advanced")) {
        const metric = searchParams.get("metric");
        if (metric === "financial_calendar" && pauseCalendar) { reached(); await release; }
        body = { metric, generatedAt: "2026-11-21T00:00:00Z", data: { periodStart: from, periodEnd: to, series: [], days: [] } };
      } else if (pathname === "/v1/subscriptions") { body = page([]); sent(); }
      return { status: 200, ok: true, headers: new Headers(), redirected: false, json: async () => body } as never;
    });
    const alert = { name: /Sin conexión — datos guardados el/ };
    await press("Analítica"); await screen.findByText("Hogar: 0,12 COP · 100 %");
    await press("Volver al resumen");
    pauseCalendar = true;
    await press("Resumen financiero");
    await holding;
    await press("Volver al resumen");
    cashOffline = true;
    await press("Analítica"); await screen.findByText("Hogar: 0,12 COP · 100 %");
    await screen.findByRole("alert", alert);
    await act(async () => { resume(); await subscribed; });
    expect(screen.getByText("Hogar: 0,12 COP · 100 %")).toBeTruthy();
    expect(screen.getByRole("alert", alert)).toBeTruthy();
  } finally { await f.close(); }
});

// Reviewer regression (verify mwrd7bv6). Append to __tests__/offline-lifecycle.test.tsx.
test("review: leaving account detail prevents its late cache fallback from changing the visible list banner", async () => {
  const f = await setup();
  let unpause!: () => void;
  const pause = new Promise<void>((resolve) => { unpause = resolve; });
  try {
    const traffic = jest.mocked(expoFetch), send = traffic.getMockImplementation()!;
    let holding = false, staleBalance = false, reached!: () => void, balanceTried!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const completed = new Promise<void>((resolve) => { balanceTried = resolve; });
    traffic.mockImplementation(async (url, init) => {
      const { pathname } = new URL(String(url));
      if (pathname === `/v1/accounts/${account}`) {
        if (holding) { reached(); await pause; staleBalance = true; throw new Error("detail offline"); }
        const reply = await send(url, init);
        return { ...reply, json: async () => ({ id: account, name: "Caja", type: "cash", status: "active", currency: "COP" }) };
      }
      if (pathname.endsWith("/balance")) {
        if (staleBalance) { balanceTried(); throw new Error("balance offline"); }
        const reply = await send(url, init);
        const amount = { amountMinor: "120", currency: "COP" };
        return { ...reply, json: async () => ({ accountId: account, nativeBalance: amount, asOf: "2026-11-01T00:00:00Z",
          baseCurrencyEquivalent: { original: amount, converted: amount, rate: "1", rateDate: "2026-11-01", rateSource: "fixture" } }) };
      }
      return send(url, init);
    });
    await press("Cuentas"); await press("Caja"); await screen.findByText("Saldo confirmado: 1,20 COP");
    await press("Volver a cuentas"); holding = true;
    await press("Caja"); await waiting;
    await press("Volver a cuentas"); await screen.findByRole("button", { name: "Caja" });
    await act(async () => { unpause(); await completed; });
    expect(screen.getByRole("button", { name: "Caja" })).toBeTruthy();
    expect(screen.queryByRole("alert", { name: /Sin conexión — datos guardados el/ })).toBeNull();
  } finally { unpause(); await f.close(); }
});

// Reviewer regression (verify mwtw32mo, 9c3cee8). __tests__/offline-lifecycle.test.tsx (append).
test.each([false, true])("close-all purges tokens, cache and outbox after provider failure (expired session: %s)", async (expired) => {
  const f = await setup();
  try {
    await warmMovements(); f.online(false); await record(); f.online(true);
    await press("Volver al resumen");
    const read = () => offlineStore()(async (db) => Object.fromEntries(await Promise.all(["cache", "outbox", "membership"].map(async (table) =>
      [table, (await db.getAllAsync(`SELECT * FROM ${table} WHERE principal = ?`, profile)).length]))));
    const before = await read();
    expect(before.cache).toBeGreaterThan(0); expect(before.outbox).toBe(1); expect(before.membership).toBe(1);
    const network = jest.mocked(expoFetch), normal = network.getMockImplementation()!, paths: string[] = [];
    network.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url)); paths.push(parsed.pathname + parsed.search);
      if (parsed.pathname === `/v1/workspaces/${workspace}`) {
        const reply = await normal(url, init);
        return { ...reply, json: async () => ({ id: workspace }) };
      }
      if (!parsed.pathname.startsWith("/auth/v1/")) return normal(url, init);
      return new Response('{"code":"unexpected_failure","message":"unavailable"}',
        { status: 503, headers: { "Content-Type": "application/json" } });
    });
    const origin = "https://project.invalid", { createAuth } = jest.requireActual<typeof import("../src/foundation/auth")>("../src/foundation/auth");
    const authKey = "savia.auth." + Array.from(origin, (char) => char.charCodeAt(0).toString(16)).join("");
    storage.set(authKey, JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh", user: { id: profile },
      expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    const client = createAuth(origin, "sb_publishable_fixture");
    jest.mocked(getAuth).mockReturnValue(client);
    await press("Sesiones"); await screen.findByText("No hay sesiones activas.");
    await press("Cerrar todas las sesiones"); paths.length = 0;
    jest.useFakeTimers({ doNotFake: ["performance"] });
    if (expired) {
      const stored = JSON.parse(storage.get(authKey)!);
      storage.set(authKey, JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 1 }));
    }
    await press("Confirmar cierre");
    await act(async () => { await jest.advanceTimersByTimeAsync(32_000); });
    expect({ tokenPresent: storage.has(authKey), signedOut: !!screen.queryByText("Iniciar sesión"), ...await read() })
      .toEqual({ tokenPresent: false, signedOut: true, cache: 0, outbox: 0, membership: 0 });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path === (expired ? "/auth/v1/token?grant_type=refresh_token" : "/auth/v1/logout?scope=global"))).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos cerrar todas las sesiones.");
  } finally { jest.useRealTimers(); await f.close(); }
});
