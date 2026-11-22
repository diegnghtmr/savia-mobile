import { isDay, isETag, money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { isCursor } from "./cursor";
import { InvalidDraft } from "./identity-draft";
import { percentOf } from "./planning-money";
import { uuid } from "./workspace-context";

export const methods = { cash_flow: "Flujo de caja", zero_based: "Base cero", envelope: "Sobres", hybrid: "Híbrido" } as const;
export const rollover = { none: "Sin arrastre", surplus: "Arrastrar sobrante", deficit: "Arrastrar déficit", both: "Arrastrar ambos",
  to_savings: "Transferir a ahorro", to_fund: "Transferir a un fondo", to_category: "Transferir a otra categoría" } as const;
export const budgetsPath = "/v1/budgets";
export type BudgetFilters = Partial<Record<"from" | "to" | "limit", string>>;
export const member = <T extends object>(values: T, key: unknown): key is keyof T => typeof key === "string" && Object.hasOwn(values, key);
export const day = (value: unknown): value is string => typeof value === "string" && isDay(value);
export function budgetRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  return value as Record<string, unknown>;
}

function queryFor(input: unknown, workspace: string) {
  try {
    const values = budgetRecord(input), params = new URLSearchParams({ limit: "20" });
    if (!workspace || Object.keys(values).some((key) => !["from", "to", "limit", "cursor"].includes(key))) throw new TypeError();
    const { from, to, cursor, limit } = values;
    if ((Object.hasOwn(values, "from") && !day(from)) || (Object.hasOwn(values, "to") && !day(to)) || (day(from) && day(to) && from > to)) throw new TypeError();
    if (Object.hasOwn(values, "limit")) {
      if (typeof limit !== "string" || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) throw new TypeError();
      params.set("limit", limit);
    }
    const binding = JSON.stringify([from ?? null, to ?? null]);
    if (typeof from === "string") params.set("from", from);
    if (typeof to === "string") params.set("to", to);
    if (Object.hasOwn(values, "cursor")) {
      if (!isCursor(cursor, workspace, binding)) throw new TypeError();
      params.set("cursor", cursor);
    }
    return { params, cursor, binding };
  } catch { throw new InvalidDraft("Filtros de presupuestos no válidos."); }
}

export function parseBudget(input: unknown) {
  const { id: raw, name, method, periodStart, periodEnd, currency, allocations, version } = budgetRecord(input), id = uuid(raw);
  if (!id || typeof name !== "string" || !name.trim() || !member(methods, method) || !day(periodStart) || !day(periodEnd) || periodStart >= periodEnd ||
    typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency) || !Array.isArray(allocations) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new TypeError();
  const lines = allocations.map((entry: unknown) => {
    const { categoryId: raw, planned, actual, available, rolloverPolicy: policy, rolloverTargetId } = budgetRecord(entry);
    const categoryId = uuid(raw), target = uuid(rolloverTargetId);
    if (!categoryId || !member(rollover, policy) || (rolloverTargetId != null && !target)) throw new TypeError();
    const amounts = [planned, actual, available].map((amount) => money(amount, currency));
    const used = percentOf(BigInt(budgetRecord(actual).amountMinor as string), BigInt(budgetRecord(planned).amountMinor as string));
    return { categoryId, planned: amounts[0], actual: amounts[1], available: amounts[2], used, policy, target };
  });
  if (new Set(lines.map(({ categoryId }) => categoryId)).size !== lines.length) throw new TypeError();
  return { id, name, method, periodStart, periodEnd, currency, version, allocations: lines };
}

export function createBudgets(request: ScopedRequest, workspace: string, categories: () => Promise<Map<string, string>>) {
  return {
    categories,
    async list(filters: unknown = {}) {
      const id = uuid(workspace) ?? "", { params, cursor, binding } = queryFor(filters, id);
      const { items, pageInfo } = budgetRecord(await request(id, `${budgetsPath}?${params}`, { successStatus: 200 }));
      const { hasNextPage, nextCursor } = budgetRecord(pageInfo);
      const next = isCursor(nextCursor, id, binding) ? nextCursor : null;
      if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !next || next === cursor || !items.length : nextCursor != null)) throw new TypeError();
      const rows = items.map(parseBudget);
      if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new TypeError();
      return { items: rows, nextCursor: next };
    },
    async detail(raw: unknown) {
      const id = uuid(raw), scope = uuid(workspace);
      if (!id || !scope) throw new InvalidDraft("Presupuesto no válido.");
      const { body, etag } = budgetRecord(await request(scope, `${budgetsPath}/${id}`, { successStatus: 200, includeETag: true }));
      const budget = parseBudget(body);
      if (budget.id !== id) throw new TypeError();
      const names = budget.allocations.length ? await categories() : new Map<string, string>();
      return { ...budget, names, etag: isETag(etag) && etag === `"${budget.version}"` ? etag : null };
    },
  };
}
export type Budgets = ReturnType<typeof createBudgets>;
export type BudgetDetail = Awaited<ReturnType<Budgets["detail"]>>;
