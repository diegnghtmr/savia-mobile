import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createFunds } from "../src/foundation/funds";
import { createTransport } from "../src/foundation/transport";
import { FundsScreen } from "../src/mobile-shell/funds-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const id = (n: number) => `a8bc0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, first, second, absent] = [1, 2, 3, 4, 5].map(id);
const stamp = "2026-11-01T00:00:00.000001Z", path = "/v1/funds";
const cursor = (scope = workspace) => Buffer.from(JSON.stringify([scope, stamp, first])).toString("base64url");
const page = (items: unknown[], nextCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: nextCursor !== null, nextCursor } });
const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const secure = jest.mocked(SecureStore);

function setup(currency = "KWD") {
  jest.clearAllMocks(); secure.getItemAsync.mockResolvedValue(workspace);
  let revoked = false, invalid: string | undefined, repeat = false;
  const amount = (amountMinor: string) => ({ amountMinor, currency });
  const row = { id: first.toUpperCase(), name: "Viaje", currency, status: "active", targetDate: "2026-12-01", targetAmount: amount("9007199254740993012"),
    currentAmount: amount("4503599627370496506"), recommendedMonthlyContribution: amount("37") };
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url), scope = new Headers(init.headers).get("X-Workspace-Id");
    const reply = (body: unknown) => ({ status: 200, ok: true, redirected: false, headers: new Headers(), json: async () => body });
    if (pathname === "/v1/me") { expect(scope).toBeNull(); return reply({ id: profile }); }
    if (pathname === "/v1/workspaces") { expect(scope).toBeNull(); return reply(page(revoked ? [] : [{ id: workspace, name: "Casa" }])); }
    expect(scope).toBe(workspace); expect(pathname).toBe(path); expect(init.method).toBe("GET");
    if (invalid !== undefined) return reply(page([row], invalid));
    if (searchParams.has("cursor")) return reply(page([{ ...row, id: second, name: "Reparaciones", status: "completed", currentAmount: amount("9007199254740993013") }], repeat ? cursor() : null));
    return reply(page([row], cursor()));
  });
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  const api = createFunds(createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } }).requestInWorkspace, workspace);
  return { api, send, read, revoke: () => { revoked = true; }, invalidate: (value: string) => { invalid = value; }, repeat: () => { repeat = true; } };
}

test("rejects invalid limits, IDs and noncanonical or wrong-workspace cursors before session or storage", async () => {
  const { api, send, read } = setup(), valid = cursor();
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = valid.slice(0, -1) + chars[chars.indexOf(valid.at(-1)!) + 1];
  expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(valid, "base64url"));
  for (const filters of [{ limit: "0" }, { limit: "201" }, { limit: 1 }, { limit: ["1", "2"] }, { limit: "1e2" }, { limit: undefined },
    { limit: " 1" }, { cursor: "W10" }, { cursor: alias }, { cursor: cursor(profile) }, { cursor: [valid] }, { status: "active" }, new URLSearchParams("limit=1&limit=2")]) {
    await expect(api.list(filters)).rejects.toThrow("Filtros de fondos no válidos.");
  }
  for (const value of ["a", [first], ` ${first}`]) await expect(api.detail(value)).rejects.toThrow("Fondo no válido.");
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(secure.getItemAsync).not.toHaveBeenCalled(); expect(secure.setItemAsync).not.toHaveBeenCalled();
});

test("finds a detail through verified list pages only and checks membership before every page", async () => {
  const { api, send, revoke } = setup();
  await expect(api.detail(second.toUpperCase())).resolves.toMatchObject({ id: second, name: "Reparaciones", remaining: "0,000 KWD", progress: "100,00 %" });
  expect(send.mock.calls.map(([url]) => url.replace("https://api.invalid", ""))).toEqual([
    "/v1/me", "/v1/workspaces", `${path}?limit=20`, "/v1/me", "/v1/workspaces", `${path}?limit=20&cursor=${cursor()}`,
  ]);
  await expect(api.detail(absent)).resolves.toBeNull();
  send.mockClear(); revoke();
  await expect(api.list({ limit: "200" })).rejects.toThrow("Este espacio ya no está disponible.");
  expect(send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
});

test("a malformed cursor never enables another list request and a repeated cursor aborts a detail search", async () => {
  const f = setup(); f.invalidate(cursor(profile));
  await render(<FundsScreen api={f.api} back={jest.fn()} />);
  expect(await screen.findByText("No pudimos cargar los fondos.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  const other = setup(); other.repeat();
  await expect(other.api.detail(second)).rejects.toThrow();
  expect(other.send.mock.calls.filter(([url]) => new URL(url).pathname === path)).toHaveLength(2);
});

test.each([
  ["JPY", "9007199254740993012", "4503599627370496506"], ["COP", "90071992547409930,12", "45035996273704965,06"],
  ["KWD", "9007199254740993,012", "4503599627370496,506"],
])("shows exact %s target, savings, remaining and progress on the list and in detail", async (currency, target, saved) => {
  const { api } = setup(currency);
  await render(<FundsScreen api={api} back={jest.fn()} />);
  await screen.findByRole("button", { name: "Viaje" });
  const amounts = [`Meta: ${target} ${currency}`, `Ahorrado: ${saved} ${currency}`, `Falta: ${saved} ${currency}`, "Progreso: 50,00 %"];
  for (const text of amounts) expect(screen.getByText(text)).toBeTruthy();
  await press("Cargar más"); expect(await screen.findByRole("button", { name: "Reparaciones" })).toBeTruthy();
  await press("Viaje"); await screen.findByRole("header", { name: "Viaje" });
  for (const text of amounts) expect(screen.getByText(text)).toBeTruthy();
  expect(screen.getByText("Fecha objetivo: 2026-12-01")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Editar|Retirar/ })).toBeNull();
});
