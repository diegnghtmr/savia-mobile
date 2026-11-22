import { fireEvent, render, screen } from "@testing-library/react-native";
import { createScenarios } from "../src/foundation/scenarios";
import type { ScopedRequest } from "../src/foundation/accounts";
import { ScenariosScreen } from "../src/mobile-shell/scenarios-screen";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-secure-store", () => ({}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "abca0000-0000-4000-8000-000000000005" }));
const id = (n: number) => `abca0000-0000-4000-8000-00000000000${n}`;
const [workspace, scenario, run] = [1, 3, 4].map(id);
const createdAt = "2026-11-01T00:00:00Z";
const draft = { name: "Una compra", description: "Presupuesto", assumptions: [{ type: "purchase", amountMinor: "9007199254740993012" }] };
const row = { id: scenario, createdAt, name: draft.name, description: draft.description,
  assumptions: [{ type: "purchase", value: { amountMinor: "9007199254740993012" } }] };
const values = (netWorthMinor: string) => ({ baseCurrency: "KWD", netWorthMinor, monthlyIncomeMinor: "0", monthlyExpensesMinor: "0", monthlySavingsCapacityMinor: "0" });
const list = { items: [row], pageInfo: { hasNextPage: false, nextCursor: null } };

function setup() {
  const request = jest.fn<ReturnType<ScopedRequest>, Parameters<ScopedRequest>>(async (_, path, options) => {
    if (path === "/v1/scenarios?limit=20") return list;
    if (path === "/v1/scenarios" && options?.method === "POST") return row;
    if (path === `/v1/scenarios/${scenario}/runs`) return { id: run, scenarioId: scenario, status: "completed",
      baseline: values("9007199254740993018"), projected: values("6"), difference: values("-9007199254740993012"), risks: [] };
    throw new Error("unexpected route");
  });
  return { request, api: createScenarios(request, workspace) };
}

test("lists scenario assumptions, executes only the supported comparison action and renders exact values", async () => {
  const f = setup(); await render(<ScenariosScreen api={f.api} back={jest.fn()} />);
  await fireEvent.press(await screen.findByRole("button", { name: "Una compra" }));
  expect(screen.getByText("Presupuesto")).toBeTruthy();
  expect(screen.getByText(/9007199254740993012/)).toBeTruthy();
  expect(screen.getByText("La API no permite editar escenarios guardados.")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Simular escenario" }));
  expect(await screen.findByText("Patrimonio neto: −9007199254740993,012 KWD")).toBeTruthy();
  expect(screen.getByText("Patrimonio neto: 0,006 KWD")).toBeTruthy();
  expect(f.request.mock.calls.map(([, path]) => path)).toEqual(["/v1/scenarios?limit=20", `/v1/scenarios/${scenario}/runs`]);
});

test("validates scenario fields and scoped cursors before requests and sends canonical amount strings", async () => {
  const f = setup();
  for (const input of [{ ...draft, name: " " }, { ...draft, assumptions: [{ type: "purchase", amountMinor: 10 }] }, { ...draft, assumptions: [] }]) {
    await expect(f.api.create(input)).rejects.toThrow("Revisa los datos del escenario.");
  }
  await expect(f.api.list({ cursor: ["W10", "W10"] })).rejects.toThrow("Filtros de escenarios no válidos.");
  await expect(f.api.run("../bad")).rejects.toThrow("Escenario no válido.");
  expect(f.request).not.toHaveBeenCalled();
  await expect(f.api.create(draft)).resolves.toMatchObject(row);
  expect(f.request).toHaveBeenCalledWith(workspace, "/v1/scenarios", expect.objectContaining({ method: "POST", successStatus: 201,
    body: { name: draft.name, description: draft.description, assumptions: row.assumptions }, idempotencyKey: id(5) }));
});
