import { isDay, money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { isCursor } from "./cursor";
import { InvalidDraft } from "./identity-draft";
import { isOfflineFailure, TransportError } from "./transport";
import { uuid } from "./workspace-context";

export type ReportPeriod = { from: string; to: string };
export const reportsPath = "/v1/analytics";
export function reportRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError();
  return input as Record<string, unknown>;
}
export function reportPeriod(input: unknown): ReportPeriod {
  try {
    const row = reportRecord(input), { from, to } = row;
    if (Object.keys(row).some((key) => key !== "from" && key !== "to") || typeof from !== "string" || typeof to !== "string" ||
      !isDay(from) || !isDay(to) || from > to) throw new TypeError();
    return { from, to };
  } catch { throw new InvalidDraft("Revisa el período del informe."); }
}
export function reportPercent(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError();
  return `${value.toLocaleString("es", { useGrouping: false, maximumFractionDigits: 2 })} %`;
}

function categories(input: unknown, currency: string) {
  const row = reportRecord(input);
  if (!Array.isArray(row.series) || !Array.isArray(row.categories)) throw new TypeError();
  const seen = new Set<string>();
  return row.categories.map((item: unknown) => {
    const { categoryId, categoryName, amount, percentage } = reportRecord(item), id = uuid(categoryId);
    if (!id || seen.has(id) || typeof categoryName !== "string" || !categoryName.trim()) throw new TypeError();
    seen.add(id);
    return { id, name: categoryName, amount: money(amount, currency), percent: reportPercent(percentage) };
  });
}
function monthlySeries(input: Record<string, unknown>, period: ReportPeriod, currency: string) {
  if (!Array.isArray(input.series)) throw new TypeError();
  let previous = "";
  const firstMonth = `${period.from.slice(0, 7)}-01`, lastMonth = `${period.to.slice(0, 7)}-01`;
  return input.series.map((item: unknown) => {
    const { month, incomeMinor, expensesMinor, savingsCapacityMinor } = reportRecord(item);
    if (typeof month !== "string" || !isDay(month) || !month.endsWith("-01") || month < firstMonth || month > lastMonth || month <= previous) throw new TypeError();
    previous = month;
    return { month: month.slice(0, 7), income: money({ amountMinor: incomeMinor, currency }), expenses: money({ amountMinor: expensesMinor, currency }),
      net: money({ amountMinor: savingsCapacityMinor, currency }) };
  });
}
export function advancedData(input: unknown, metric: string) {
  const row = reportRecord(input);
  if (row.metric !== metric || typeof row.generatedAt !== "string" || !Number.isFinite(Date.parse(row.generatedAt))) throw new TypeError();
  return reportRecord(row.data);
}

export const subscriptionPreviewLimit = 5;
function subscriptionPreview(input: unknown, scope: string) {
  const { items, pageInfo } = reportRecord(input), { hasNextPage, nextCursor } = reportRecord(pageInfo);
  if (!Array.isArray(items) || items.length > subscriptionPreviewLimit || typeof hasNextPage !== "boolean" ||
    (hasNextPage ? !isCursor(nextCursor, scope, "detected") || !items.length : nextCursor != null)) throw new TypeError();
  const seen = new Set<string>();
  return { more: hasNextPage, items: items.map((item: unknown) => {
    const { id: raw, status, payeeName, currentAmount, nextExpectedAt } = reportRecord(item), id = uuid(raw);
    if (!id || seen.has(id) || status !== "detected" || typeof payeeName !== "string" || !payeeName.trim()) throw new TypeError();
    const instant = typeof nextExpectedAt === "string" ? Date.parse(nextExpectedAt) : NaN;
    if (nextExpectedAt != null && !Number.isFinite(instant)) throw new TypeError();
    seen.add(id);
    return { id, name: payeeName, amount: money(currentAmount), next: nextExpectedAt == null ? null : new Date(instant).toISOString().slice(0, 10) };
  }) };
}
function scheduledRecurring(data: Record<string, unknown>, period: ReportPeriod, currency: string) {
  if (data.periodStart !== period.from || data.periodEnd !== period.to || !Array.isArray(data.days)) throw new TypeError();
  let previous = "";
  return data.days.flatMap((day: unknown) => {
    const { date, items } = reportRecord(day);
    if (typeof date !== "string" || !isDay(date) || date <= previous || date < period.from || date > period.to || !Array.isArray(items)) throw new TypeError();
    previous = date;
    const seen = new Set<string>();
    return items.flatMap((item: unknown) => {
      const { kind, refId, label, amountMinor } = reportRecord(item);
      if (kind !== "recurring_rule") return [];
      const id = uuid(refId);
      if (!id || seen.has(id) || typeof label !== "string" || !label.trim() || typeof amountMinor !== "string" || !/^\d+$/.test(amountMinor)) throw new TypeError();
      seen.add(id);
      return [{ id, date, label, amount: money({ amountMinor, currency }) }];
    });
  });
}
async function optionalSection<T>(operation: () => Promise<T>) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof TypeError || isOfflineFailure(error) ||
      (error instanceof TransportError && error.kind === "http" && [422, 501, 503].includes(error.status ?? 0))) return null;
    throw error;
  }
}

type ReportBatch = <T>(read: (request: ScopedRequest) => Promise<T>) => Promise<T>;
export function createAnalytics(request: ScopedRequest, workspace: string, batch: ReportBatch = (read) => read(request)) {
  function target() {
    const scope = uuid(workspace);
    if (!scope) throw new InvalidDraft("Espacio no válido.");
    return scope;
  }
  async function summaryFor(request: ScopedRequest, scope: string, period: ReportPeriod) {
    const row = reportRecord(await request(scope, `${reportsPath}/summary?${new URLSearchParams(period)}`, { successStatus: 200 }));
    const currency = row.baseCurrency;
    if (row.periodStart !== period.from || row.periodEnd !== period.to || typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency)) throw new TypeError();
    const amount = (key: string) => money(row[key], currency);
    return { period, currency, netWorth: amount("netWorth"), income: amount("income"), expenses: amount("expenses"), netFlow: amount("savingsCapacity"),
      assets: row.assets === undefined ? null : amount("assets"), debts: row.debts === undefined ? null : amount("debts"),
      budget: row.budgetUtilizationPercent === undefined ? null : reportPercent(row.budgetUtilizationPercent) };
  }
  return {
    async summary(input: unknown) { const period = reportPeriod(input); return summaryFor(request, target(), period); },
    async dashboard(input: unknown, next: unknown) {
      const period = reportPeriod(input), future = reportPeriod(next), scope = target();
      return batch(async (get) => {
        const summary = await summaryFor(get, scope, period), metric = "financial_calendar";
        const upcoming = await optionalSection(async () => {
          const raw = await get(scope, `${reportsPath}/advanced?${new URLSearchParams({ ...future, metric })}`, { successStatus: 200 });
          return scheduledRecurring(advancedData(raw, metric), future, summary.currency);
        });
        const subscriptions = await optionalSection(async () => subscriptionPreview(
          await get(scope, `/v1/subscriptions?limit=${subscriptionPreviewLimit}&status=detected`, { successStatus: 200 }), scope));
        return { summary, future, upcoming, subscriptions };
      });
    },
    async breakdown(input: unknown) {
      const period = reportPeriod(input), scope = target();
      return batch(async (get) => {
        const summary = await summaryFor(get, scope, period);
        const metric = "monthly_savings_capacity";
        const cash = await get(scope, `${reportsPath}/cash-flow?${new URLSearchParams(period)}`, { successStatus: 200 });
        const monthly = await get(scope, `${reportsPath}/advanced?${new URLSearchParams({ ...period, metric })}`, { successStatus: 200 });
        return { summary, categories: categories(cash, summary.currency), months: monthlySeries(advancedData(monthly, metric), period, summary.currency) };
      });
    },
  };
}
export type Analytics = ReturnType<typeof createAnalytics>;
