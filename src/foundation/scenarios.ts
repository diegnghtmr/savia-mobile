import { randomUUID } from "expo-crypto";
import { money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { uuid } from "./workspace-context";

const path = "/v1/scenarios";
export const assumptionNames = { income_change: "Cambio de ingresos", expense_change: "Cambio de gastos", purchase: "Compra", new_debt: "Nueva deuda",
  extra_debt_payment: "Pago adicional de deuda", cancel_subscription: "Cancelar suscripción", exchange_rate_change: "Cambio de tipo de cambio",
  savings_contribution: "Aporte de ahorro", income_gap: "Período sin ingresos" } as const;
const amount = "Importe en unidades menores de la moneda base";
export const assumptionFields = { income_change: { amountMinor: amount, percent: "Porcentaje de cambio (alternativo)" },
  expense_change: { amountMinor: amount, percent: "Porcentaje de cambio (alternativo)" }, purchase: { amountMinor: amount },
  new_debt: { principalMinor: "Capital en unidades menores", monthlyPaymentMinor: "Cuota mensual en unidades menores" }, extra_debt_payment: { amountMinor: amount },
  cancel_subscription: { monthlyAmountMinor: "Importe mensual en unidades menores" }, savings_contribution: { monthlyAmountMinor: "Aporte mensual en unidades menores" },
  income_gap: { months: "Meses sin ingresos" }, exchange_rate_change: { fromCurrency: "Moneda de origen", toCurrency: "Moneda de destino", rate: "Tipo de cambio" } } as const;
export type AssumptionType = keyof typeof assumptionNames;
function assumptionType(raw: unknown): AssumptionType {
  if (typeof raw !== "string" || !Object.hasOwn(assumptionNames, raw)) throw new TypeError();
  return raw as AssumptionType;
}
function scenario(input: unknown) {
  const { id: raw, name, description, assumptions, createdAt } = fundRecord(input), id = uuid(raw);
  if (!id || typeof name !== "string" || !name.trim() || (description != null && typeof description !== "string") ||
    !Array.isArray(assumptions) || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new TypeError();
  return { id, name, description, createdAt, assumptions: assumptions.map((raw) => {
    const { type, value } = fundRecord(raw);
    return { type: assumptionType(type), value: fundRecord(value) };
  }) };
}
function assumption(input: unknown) {
  const raw = fundRecord(input), type = assumptionType(raw.type), fields = Object.keys(assumptionFields[type]);
  if (Object.keys(raw).some((key) => key !== "type" && !fields.includes(key))) throw new TypeError();
  const value = Object.fromEntries(fields.flatMap<[string, string | number]>((key) => {
    const field = raw[key];
    if ((type === "income_change" || type === "expense_change") && (field === undefined || field === "")) return [];
    if (typeof field !== "string" || field.length > 64) throw new TypeError();
    if (key === "months" && /^[1-9]\d{0,3}$/.test(field)) return [[key, Number(field)]];
    if (key === "percent" && /^-?\d{1,9}(?:[.,]\d{1,2})?$/.test(field)) return [[key, Number(field.replace(",", "."))]];
    if (key === "rate" && /^\d+(?:\.\d+)?$/.test(field) && /[1-9]/.test(field)) return [[key, field]];
    if (key.endsWith("Currency") && ACTIVE_CURRENCIES.has(field)) return [[key, field]];
    if (key.endsWith("Minor") && /^-?\d{1,19}$/.test(field)) {
      const integer = BigInt(field), negativeAllowed = type === "income_change" || type === "expense_change";
      if (integer <= 9223372036854775807n && (negativeAllowed ? integer >= -9223372036854775808n : integer > 0n)) return [[key, String(integer)]];
    }
    throw new TypeError();
  }));
  if ((fields.includes("percent") && Object.keys(value).length !== 1) || (type === "exchange_rate_change" && value.fromCurrency === value.toCurrency)) throw new TypeError();
  return { type, value };
}
function createBody(input: unknown) {
  const body = fundRecord(input), { name, description, assumptions } = body;
  if (Object.keys(body).some((key) => !["name", "description", "assumptions"].includes(key)) || typeof name !== "string" ||
    !name.trim() || [...name.trim()].length > 120 || (description != null && (typeof description !== "string" || [...description].length > 1000)) ||
    !Array.isArray(assumptions) || !assumptions.length) throw new TypeError();
  return { name: name.trim(), ...(description == null || description === "" ? {} : { description }), assumptions: assumptions.map(assumption) };
}
export const scenarioMetrics = { monthlyIncomeMinor: "Ingresos mensuales", monthlyExpensesMinor: "Gastos mensuales",
  monthlySavingsCapacityMinor: "Capacidad de ahorro mensual", netWorthMinor: "Patrimonio neto" } as const;
function comparison(raw: unknown, expected: string) {
  const { id, status, scenarioId, baseline, projected, difference, risks = [] } = fundRecord(raw);
  if (!uuid(id) || uuid(scenarioId) !== expected || (status !== "completed" && status !== "failed") ||
    !Array.isArray(risks) || !risks.every((risk): risk is string => typeof risk === "string")) throw new TypeError();
  const currency = fundRecord(baseline).baseCurrency;
  const figures = [baseline, projected, difference].map((value) => {
    const row = fundRecord(value);
    if (row.baseCurrency !== currency) throw new TypeError();
    return Object.entries(scenarioMetrics).map(([key, label]) => ({ label, value: money({ amountMinor: row[key], currency }) }));
  });
  return { status, figures, risks };
}
export function createScenarios(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", keys = new Map<string, string>();
  async function submit<T>(url: string, status: number, parse: (value: unknown) => T, body?: ReturnType<typeof createBody>) {
    const command = JSON.stringify([url, body]), key = keys.get(command) ?? randomUUID();
    keys.set(command, key);
    const result = parse(await request(scope, url, { method: "POST", body, idempotencyKey: key, successStatus: status }));
    keys.delete(command);
    return result;
  }
  return {
    async list(input: unknown = {}) {
      let cursor: string | undefined;
      try {
        const filters = fundRecord(input);
        if (!scope || Object.keys(filters).some((key) => key !== "cursor")) throw new TypeError();
        if (Object.hasOwn(filters, "cursor")) {
          if (!isCursor(filters.cursor, scope, undefined, true)) throw new TypeError();
          cursor = filters.cursor;
        }
      } catch { throw new InvalidDraft("Filtros de escenarios no válidos."); }
      const params = new URLSearchParams({ limit: "20" }); if (cursor) params.set("cursor", cursor);
      const { items, pageInfo } = fundRecord(await request(scope, `${path}?${params}`, { successStatus: 200 }));
      const { hasNextPage, nextCursor } = fundRecord(pageInfo), next = isCursor(nextCursor, scope, undefined, true) ? nextCursor : null;
      if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !next || next === cursor || !items.length : nextCursor != null)) throw new TypeError();
      const rows = items.map(scenario);
      if (new Set(rows.map(({ id }) => id)).size !== rows.length) throw new TypeError();
      return { items: rows, nextCursor: next };
    },
    async create(raw: unknown) {
      let body;
      try { if (!scope) throw new TypeError(); body = createBody(raw); } catch { throw new InvalidDraft("Revisa los datos del escenario."); }
      return submit(path, 201, scenario, body);
    },
    async run(raw: unknown) {
      const id = uuid(raw);
      if (!scope || !id) throw new InvalidDraft("Escenario no válido.");
      return submit(`${path}/${id}/runs`, 200, (value) => comparison(value, id));
    },
  };
}
export type Scenarios = ReturnType<typeof createScenarios>;
export type Scenario = ReturnType<typeof scenario>;
