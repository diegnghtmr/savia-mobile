import { isDay, money, type ScopedRequest } from "./accounts";
import { advancedMetrics, parseAdvancedMetric } from "./advanced-analytics";
import { ACTIVE_CURRENCIES } from "./currencies";
import { isCursor } from "./cursor";
import { parseFxRatesUsed } from "./fx-rates";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
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

export const cashGranularities = { day: "Día", week: "Semana", month: "Mes", quarter: "Trimestre", year: "Año" } as const;
export const analyticsFilterLabels = { accountIds: "Cuentas", categoryIds: "Categorías", tagIds: "Etiquetas", payeeIds: "Contrapartes", memberIds: "Miembros" } as const;
export type AnalyticsFilterKey = keyof typeof analyticsFilterLabels;
const unavailable = "Esta función no está disponible en este servidor.";
function analyticsFilters(query: URLSearchParams, input: Record<string, unknown>, extra?: string) {
  if (Object.keys(input).some((key) => key !== extra && key !== "presentationCurrency" && !Object.hasOwn(analyticsFilterLabels, key))) throw new TypeError();
  const currency = input.presentationCurrency;
  if (currency !== undefined && typeof currency !== "string") throw new TypeError();
  const normalized = currency?.trim().toUpperCase();
  if (normalized) {
    if (!ACTIVE_CURRENCIES.has(normalized)) throw new TypeError();
    query.set("presentationCurrency", normalized);
  }
  for (const field of Object.keys(analyticsFilterLabels)) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new TypeError();
    if (!value.trim()) continue;
    const seen = new Set<string>();
    for (const part of value.split(",")) {
      const id = uuid(part.trim().toLowerCase());
      if (!id || seen.has(id)) throw new TypeError();
      seen.add(id); query.append(field, id);
    }
  }
  return normalized || undefined;
}

function categories(input: unknown, currency?: string) {
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
function cashSeries(input: unknown, currency?: string) {
  if (!Array.isArray(input)) throw new TypeError();
  const seen = new Set<string>();
  return input.map((item: unknown) => {
    const { period, value, secondaryValue } = reportRecord(item);
    if (typeof period !== "string" || !period.trim() || seen.has(period)) throw new TypeError();
    seen.add(period);
    const expected = currency ?? reportRecord(value).currency;
    if (typeof expected !== "string") throw new TypeError();
    return { period, net: money(value, expected), cumulative: secondaryValue === undefined ? null : money(secondaryValue, expected) };
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
  async function summaryFor(request: ScopedRequest, scope: string, period: ReportPeriod, presentationCurrency?: string) {
    const query = new URLSearchParams({ ...period, ...(presentationCurrency && { presentationCurrency }) });
    const row = reportRecord(await request(scope, `${reportsPath}/summary?${query}`, { successStatus: 200 }));
    const currency = row.baseCurrency;
    if (row.periodStart !== period.from || row.periodEnd !== period.to || typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency)) throw new TypeError();
    const amount = (key: string) => money(row[key], currency);
    return { period, currency, netWorth: amount("netWorth"), income: amount("income"), expenses: amount("expenses"), netFlow: amount("savingsCapacity"),
      assets: row.assets === undefined ? null : amount("assets"), debts: row.debts === undefined ? null : amount("debts"),
      budget: row.budgetUtilizationPercent === undefined ? null : reportPercent(row.budgetUtilizationPercent), fxRatesUsed: parseFxRatesUsed(row.fxRatesUsed) };
  }
  return {
    async summary(input: unknown) { const period = reportPeriod(input); return summaryFor(request, target(), period); },
    async dashboard(input: unknown, next: unknown, presentationCurrency?: string) {
      const period = reportPeriod(input), future = reportPeriod(next), scope = target();
      if (presentationCurrency !== undefined && !ACTIVE_CURRENCIES.has(presentationCurrency)) throw new InvalidDraft("Revisa la moneda de presentación.");
      return batch(async (get) => {
        const summary = await summaryFor(get, scope, period, presentationCurrency), metric = "financial_calendar";
        const calendar = await optionalSection(async () => {
          const raw = reportRecord(await get(scope, `${reportsPath}/advanced?${new URLSearchParams({ ...future, metric, ...(presentationCurrency && { presentationCurrency }) })}`, { successStatus: 200 }));
          return { upcoming: scheduledRecurring(advancedData(raw, metric), future, summary.currency), rates: parseFxRatesUsed(raw.fxRatesUsed) };
        });
        const subscriptions = await optionalSection(async () => subscriptionPreview(
          await get(scope, `/v1/subscriptions?limit=${subscriptionPreviewLimit}&status=detected`, { successStatus: 200 }), scope));
        return { summary, future, upcoming: calendar?.upcoming ?? null, calendarRates: calendar?.rates, subscriptions };
      });
    },
    async breakdown(input: unknown) {
      const period = reportPeriod(input), scope = target();
      return batch(async (get) => {
        const summary = await summaryFor(get, scope, period);
        const metric = "monthly_savings_capacity";
        const cash = await get(scope, `${reportsPath}/cash-flow?${new URLSearchParams(period)}`, { successStatus: 200 });
        const monthly = await get(scope, `${reportsPath}/advanced?${new URLSearchParams({ ...period, metric })}`, { successStatus: 200 });
        return { summary, categories: categories(cash, summary.currency), months: monthlySeries(advancedData(monthly, metric), period, summary.currency),
          cashRates: parseFxRatesUsed(reportRecord(cash).fxRatesUsed), monthlyRates: parseFxRatesUsed(reportRecord(monthly).fxRatesUsed) };
      });
    },
    async cashFlow(input: unknown, filters: unknown = {}) {
      const period = reportPeriod(input), query = new URLSearchParams(period);
      let currency: string | undefined;
      try {
        const draft = reportRecord(filters), granularity = draft.granularity === undefined ? "month" : draft.granularity;
        if (typeof granularity !== "string" || !Object.hasOwn(cashGranularities, granularity)) throw new TypeError();
        query.set("granularity", granularity);
        currency = analyticsFilters(query, draft, "granularity");
      } catch { throw new InvalidDraft("Revisa los filtros de analítica."); }
      const call = onlineCapability(request, target());
      const row = reportRecord(await call(`${reportsPath}/cash-flow?${query}`, { successStatus: 200, onlineOnly: true }, unavailable));
      return { series: cashSeries(row.series, currency), categories: categories(row, currency), fxRatesUsed: parseFxRatesUsed(row.fxRatesUsed) };
    },
    async advanced(input: unknown, metric: unknown, filters: unknown = {}) {
      const period = reportPeriod(input);
      const valid = (key: unknown): key is keyof typeof advancedMetrics => typeof key === "string" && Object.hasOwn(advancedMetrics, key);
      if (!valid(metric)) throw new InvalidDraft("Selecciona una métrica válida.");
      const query = new URLSearchParams({ ...period, metric });
      let currency: string | undefined;
      try { currency = analyticsFilters(query, reportRecord(filters)); }
      catch { throw new InvalidDraft("Revisa los filtros de analítica."); }
      const call = onlineCapability(request, target());
      const result = parseAdvancedMetric(await call(`${reportsPath}/advanced?${query}`, { successStatus: 200, onlineOnly: true }, unavailable), metric);
      if (currency && result.currency !== currency) throw new TypeError("Unexpected analytics currency");
      return result;
    },
  };
}
export type Analytics = ReturnType<typeof createAnalytics>;
