import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { createForecasts } from "../src/foundation/forecasts";
import { createTransport } from "../src/foundation/transport";
import { ForecastsScreen } from "../src/mobile-shell/forecasts-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "abca0000-0000-4000-8000-000000000005" }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn() }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, profile, job, forecast] = [1, 2, 3, 4].map(id);
const date = "2026-11-01", time = `${date}T00:00:00Z`;
function setup() {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(workspace);
  const read = jest.fn().mockResolvedValue({ accessToken: "fixture" });
  let completed = false, allowed = true;
  const send = jest.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => ({ status, ok: true, headers: new Headers(), redirected: false, json: async () => body });
    if (path === "/v1/me") return reply({ id: profile });
    if (path === "/v1/workspaces") return reply({ items: allowed ? [{ id: workspace, name: "Casa" }] : [], pageInfo: { hasNextPage: false } });
    expect(headers.get("X-Workspace-Id")).toBe(workspace);
    const receipt = { id: job, type: "balance_forecast", status: completed ? "completed" : "queued", createdAt: time, resultResourceId: completed ? forecast : null };
    if (path === "/v1/forecasts/balance") {
      expect(init.method).toBe("POST"); expect(init.body).toBe('{"horizonDays":90}'); expect(headers.get("Idempotency-Key")).toBe(id(5));
      return reply(receipt, 202);
    }
    if (path === `/v1/jobs/${job}`) return reply(receipt);
    expect(path).toBe(`/v1/forecasts/${forecast}`);
    const amount = (amountMinor: string) => ({ amountMinor, currency: "KWD" });
    return reply({ id: forecast, status: "completed", generatedAt: time, confidence: "medium", assumptions: ["Histórico mensual"],
      series: [{ date, expected: amount("9007199254740993012"), lowerBound: amount("-1234"), upperBound: amount("9007199254740993013") }] });
  });
  const { requestInWorkspace } = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  return { api: createForecasts(requestInWorkspace, workspace), send, read, complete: () => { completed = true; }, revoke: () => { allowed = false; } };
}

test("requests a forecast, refreshes its job, and shows dated exact bounds and assumptions", async () => {
  const f = setup(); await render(<ForecastsScreen api={f.api} back={jest.fn()} />);
  await fireEvent.press(screen.getByRole("button", { name: "Calcular pronóstico" }));
  expect(await screen.findByText("Pronóstico en cola")).toBeTruthy(); f.complete();
  await fireEvent.press(screen.getByRole("button", { name: "Actualizar pronóstico" }));
  for (const text of [date, "Esperado: 9007199254740993,012 KWD", "Límite inferior: −1,234 KWD", "Límite superior: 9007199254740993,013 KWD", "Confianza: media", "Histórico mensual"]) expect(await screen.findByText(text)).toBeTruthy();
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces", "/v1/forecasts/balance",
    "/v1/me", "/v1/workspaces", `/v1/jobs/${job}`, "/v1/me", "/v1/workspaces", `/v1/forecasts/${forecast}`]);
});

test("rejects invalid horizon or identifiers without a session, and stops scoped reads after revocation", async () => {
  const f = setup();
  for (const input of ["0", "731", "1e2", ["90", "90"], 90]) await expect(f.api.start(input)).rejects.toThrow("Revisa el horizonte del pronóstico.");
  await expect(f.api.detail("bad")).rejects.toThrow("Pronóstico no válido.");
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  f.revoke(); await expect(f.api.detail(forecast)).rejects.toThrow("Este espacio ya no está disponible.");
  expect(f.send.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/me", "/v1/workspaces"]);
});
