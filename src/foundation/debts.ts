import { isDay, money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { isCursor } from "./cursor";
import { InvalidDraft } from "./identity-draft";
import { TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const debtsPath = "/v1/debts";
export const debtStatuses = { active: "Activa", paid: "Pagada", defaulted: "En mora", archived: "Archivada" } as const;
export function debtRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError();
  return input as Record<string, unknown>;
}
const currencyCode = (value: unknown): value is string => typeof value === "string" && ACTIVE_CURRENCIES.has(value);
function day(value: unknown) {
  if (typeof value !== "string" || !isDay(value)) throw new TypeError();
  return value;
}
function annualPercent(value: unknown) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw new TypeError();
  const [whole, fraction = ""] = value.split(".");
  const percent = (whole + fraction.padEnd(2, "0").slice(0, 2)).replace(/^0+(?=\d)/, "");
  const decimals = fraction.slice(2).replace(/0+$/, "");
  return `${percent}${decimals ? `,${decimals}` : ""} %`;
}
function parseDebt(input: unknown) {
  const row = debtRecord(input), { name, currency, status, rateType } = row, id = uuid(row.id);
  if (!id || typeof name !== "string" || !name.trim() || !currencyCode(currency) || typeof status !== "string" || !Object.hasOwn(debtStatuses, status) ||
    (rateType !== undefined && rateType !== "fixed" && rateType !== "variable")) throw new TypeError();
  return { id, name, currency, status: status as keyof typeof debtStatuses, rateType,
    principal: money(row.principal, currency), balance: money(row.outstandingBalance, currency), annualRate: annualPercent(row.annualRate),
    minimum: row.minimumPayment === undefined ? null : money(row.minimumPayment, currency),
    nextPaymentAt: row.nextPaymentAt == null ? null : day(row.nextPaymentAt) };
}
function parseProjection(input: unknown, id: string, currency: string) {
  const row = debtRecord(input);
  if (uuid(row.debtId) !== id || row.strategy !== "minimum_payment" || !Array.isArray(row.schedule)) throw new TypeError();
  const asOf = day(row.asOf), payoff = day(row.estimatedPayoffDate);
  let prior = asOf;
  const schedule = row.schedule.map((item: unknown) => {
    const entry = debtRecord(item), due = day(entry.dueDate);
    if (due < prior || due > payoff) throw new TypeError();
    prior = due;
    return { due, payment: money(entry.paymentAmount, currency), principal: money(entry.principalAmount, currency),
      interest: money(entry.interestAmount, currency), balance: money(entry.remainingBalance, currency) };
  });
  if (payoff < asOf) throw new TypeError();
  return { asOf, payoff, schedule, starting: money(row.startingBalance, currency),
    interest: money(row.totalInterest, currency), cost: money(row.totalCost, currency) };
}

export function createDebts(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "";
  const validCursor = (value: unknown): value is string => isCursor(value, scope, undefined, true);
  async function list(filters: unknown = {}) {
    const params = new URLSearchParams({ limit: "20" });
    try {
      const row = debtRecord(filters);
      if (!scope) throw new TypeError();
      for (const [key, value] of Object.entries(row)) {
        if (key === "limit" && typeof value === "string" && /^\d{1,3}$/.test(value) && +value >= 1 && +value <= 200) params.set(key, value);
        else if (key === "cursor" && validCursor(value)) params.set(key, value);
        else throw new TypeError();
      }
    } catch { throw new InvalidDraft("Filtros de deudas no válidos."); }
    const { items, pageInfo } = debtRecord(await request(scope, `${debtsPath}?${params}`, { successStatus: 200 }));
    const { hasNextPage, nextCursor } = debtRecord(pageInfo);
    const next = validCursor(nextCursor) ? nextCursor : null;
    if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !next || next === params.get("cursor") || !items.length : nextCursor != null)) throw new TypeError();
    const rows = items.map(parseDebt);
    if (new Set(rows.map(({ id }) => id)).size !== rows.length) throw new TypeError();
    return { items: rows, nextCursor: next };
  }
  return {
    list,
    async detail(raw: unknown) {
      const id = uuid(raw);
      if (!id || !scope) throw new InvalidDraft("Deuda no válida.");
      const cursors = new Set<string>(), ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const { items, nextCursor } = await list(cursor ? { cursor } : {});
        if ((nextCursor && cursors.has(nextCursor)) || items.some((row) => ids.has(row.id))) throw new TypeError();
        const debt = items.find((row) => row.id === id);
        if (debt) return debt;
        for (const row of items) ids.add(row.id);
        if (nextCursor) cursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      return null;
    },
    async projection(raw: unknown, currency: unknown) {
      const id = uuid(raw);
      if (!id || !scope || !currencyCode(currency)) throw new InvalidDraft("Deuda no válida.");
      // No capability endpoint: the explicit GET probes support after verified membership.
      let verified = false;
      try {
        const data = await request(scope, `${debtsPath}/${id}/projection`, { successStatus: 200,
          onMembership: async ({ active }) => { verified = active?.id === scope; } });
        return parseProjection(data, id, currency);
      } catch (error) {
        if (verified && error instanceof TransportError && error.kind === "http" && (error.status === 404 || error.status === 501)) return null;
        throw error;
      }
    },
  };
}
export type Debts = ReturnType<typeof createDebts>;
export type Debt = ReturnType<typeof parseDebt>;
