import { isDay, money } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { fundRecord as record } from "./funds";
import { parseFxRatesUsed } from "./fx-rates";

export const advancedMetrics = {
  net_worth_history: "Historial de patrimonio neto", spending_heatmap: "Mapa de calor de gastos",
  recurring_vs_variable: "Gastos recurrentes y variables", financial_calendar: "Calendario financiero",
  weekday_heatmap: "Actividad por día de la semana", balance_projection: "Proyección de saldo",
  quarterly_average_comparison: "Comparación de promedios trimestrales", subscription_price_increases: "Aumentos de suscripciones",
  income_stability: "Estabilidad de ingresos", monthly_savings_capacity: "Capacidad de ahorro mensual",
  debt_cost_evolution: "Evolución del costo de deuda", subscription_annual_cost: "Costo anual de suscripciones",
} as const;
export type AdvancedMetric = keyof typeof advancedMetrics;
const weekdays = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const absent = "No disponible";
const invalid = (): never => { throw new TypeError("Invalid advanced analytics"); };
const text = (value: unknown) => typeof value === "string" ? value : invalid();
const date = (value: unknown) => typeof value === "string" && isDay(value) ? value : invalid();
const quarter = (value: unknown) => typeof value === "string" && /^\d{4}-Q[1-4]$/.test(value) ? value : invalid();
const whole = (min = 0, max = Number.MAX_SAFE_INTEGER) => (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? String(value) : invalid();
const weekday = (value: unknown) => weekdays[Number(whole(1, 7)(value)) - 1];
const percent = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? `${value.toLocaleString("es", { useGrouping: false, maximumFractionDigits: 2 })} %` : invalid();
const nullable = (format: Format): Format => (value) => value === null ? absent : format(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text) : invalid();
type Format = (value: unknown) => string;
type Column = readonly [field: string, label: string, format: Format];
export type MetricTable = { title: string; headers: string[]; rows: string[][] };

function metricTables(metric: AdvancedMetric, data: Record<string, unknown>, currency: string): MetricTable[] {
  const title = advancedMetrics[metric], count = whole(), minor: Format = (amountMinor) => money({ amountMinor, currency });
  const table = (items: unknown, columns: readonly Column[], name: string = title): MetricTable => {
    if (!Array.isArray(items)) return invalid();
    return { title: name, headers: columns.map(([, label]) => label), rows: items.map((item) => {
      const row = record(item); return columns.map(([field, , format]) => format(row[field]));
    }) };
  };
  const details = (columns: readonly Column[], name = "Totales"): MetricTable => ({ title: name,
    headers: ["Indicador", "Valor"], rows: columns.map(([field, label, format]) => [label, format(data[field])]) });
  const month = ["month", "Mes", date] as const;
  const payee = ["payeeName", "Contraparte", text] as const;
  switch (metric) {
    case "net_worth_history": {
      const result = table(data.series, [["date", "Fecha", date], ["assets", "Activos", money], ["debts", "Deudas", money],
        ["netWorth", "Patrimonio neto", money], ["fxValuationChange", "Variación cambiaria", nullable(money)]]);
      if (result.rows.some((row, i) => i > 0 && row[0] <= result.rows[i - 1][0])) return invalid();
      return [result];
    }
    case "spending_heatmap": {
      const result = table(data.cells, [["weekday", "Día de la semana", weekday], ["dayOfMonth", "Día del mes", whole(1, 31)],
        ["amount", "Gasto neto", money], ["count", "Movimientos", count]]);
      if (new Set(result.rows.map(([day, number]) => `${day}:${number}`)).size !== result.rows.length) return invalid();
      return [result];
    }
    case "recurring_vs_variable": return [details([["committedMinor", "Recurrentes", minor], ["variableMinor", "Variables", minor],
      ["totalExpensesMinor", "Gastos totales", minor], ["committedPercent", "Porcentaje recurrente", nullable(percent)],
      ["consideredSubscriptionCount", "Suscripciones consideradas", count], ["unclassifiedSubscriptionCount", "Suscripciones sin clasificar", count]], title)];
    case "financial_calendar": return [table(data.days, [["date", "Fecha", date], ["expectedInflowMinor", "Ingresos previstos", minor],
      ["expectedOutflowMinor", "Gastos previstos", minor], ["items", "Movimientos y recordatorios", (items) => {
        if (!Array.isArray(items)) return invalid();
        return items.map((item) => {
          const { label, state, direction, amountMinor } = record(item);
          if ((state !== "actual" && state !== "scheduled") || (direction !== "inflow" && direction !== "outflow" && direction !== "none")) return invalid();
          const flow = direction === "inflow" ? "entrada" : direction === "outflow" ? "salida" : "sin importe";
          return `${text(label)} (${state === "actual" ? "registrado" : "previsto"}, ${flow})${amountMinor === null ? "" : `: ${minor(amountMinor)}`}`;
        }).join("; ") || "Ninguno";
      }]]), details([["totalExpectedInflowMinor", "Total de ingresos previstos", minor], ["totalExpectedOutflowMinor", "Total de gastos previstos", minor],
      ["debtsWithoutScheduledAmount", "Deudas sin importe programado", count], ["recurringRulesWithUnreadableTemplate", "Reglas con plantilla no disponible", count]])];
    case "weekday_heatmap": {
      const result = table(data.series, [["weekday", "Día de la semana", weekday], ["totalMinor", "Importe", minor], ["transactionCount", "Movimientos", count]]);
      if (result.rows.length !== 7 || result.rows.some(([day], i) => day !== weekdays[i])) return invalid();
      return [result];
    }
    case "balance_projection": return [table(data.months, [month, ["expectedInflowMinor", "Ingresos previstos", minor],
      ["expectedOutflowMinor", "Gastos previstos", minor], ["projectedBalanceMinor", "Saldo previsto", minor]]),
      details([["openingBalanceMinor", "Saldo inicial", minor], ["basisMonths", "Meses de referencia", count],
        ["meanMonthlyIncomeMinor", "Ingreso mensual promedio", minor], ["meanMonthlyExpensesMinor", "Gasto mensual promedio", minor]], "Base de la proyección")];
    case "quarterly_average_comparison": return [table(data.series, [["quarter", "Trimestre", quarter], ["monthsCounted", "Meses", whole(1, 3)],
      ["averageMonthlyIncomeMinor", "Ingreso promedio", minor], ["averageMonthlyExpensesMinor", "Gasto promedio", minor],
      ["averageMonthlySavingsCapacityMinor", "Ahorro promedio", minor], ["savingsCapacityDeltaPercentVsPreviousQuarter", "Variación frente al trimestre anterior", nullable(percent)]])];
    case "subscription_price_increases": return [table(data.items, [payee, ["previousAmount", "Importe anterior", money], ["currentAmount", "Importe actual", money],
      ["increasePercent", "Aumento", percent]]), details([["consideredCount", "Consideradas", count], ["decreasedOrUnchangedCount", "Sin aumento", count],
      ["excludedForCurrencyMismatch", "Excluidas por monedas distintas", count], ["excludedForZeroPrevious", "Excluidas por precio anterior cero", count]])];
    case "income_stability": return [details([["monthsCounted", "Meses", count], ["meanMonthlyIncomeMinor", "Ingreso promedio", minor],
      ["minMonthlyIncomeMinor", "Ingreso mínimo", minor], ["maxMonthlyIncomeMinor", "Ingreso máximo", minor], ["medianMonthlyIncomeMinor", "Mediana", minor],
      ["coefficientOfVariationPercent", "Coeficiente de variación", nullable(percent)], ["trendPercent", "Tendencia", nullable(percent)],
      ["regularityPercent", "Regularidad", nullable(percent)]], title), table(data.sourceConcentration,
      [["payeeId", "Fuente (ID)", (value) => value === null ? "Sin identificar" : text(value)], ["amount", "Ingreso", money], ["sharePercent", "Participación", percent]], "Concentración por fuente")];
    case "monthly_savings_capacity": return [table(data.series, [month, ["incomeMinor", "Ingresos", minor], ["expensesMinor", "Gastos", minor],
      ["savingsCapacityMinor", "Capacidad de ahorro", minor], ["recurringIncomeMinor", "Ingresos recurrentes", minor],
      ["essentialExpensesMinor", "Gastos esenciales", minor], ["discretionaryExpensesMinor", "Gastos discrecionales", minor],
      ["obligationsMinor", "Obligaciones", minor], ["currentSavingsMinor", "Ahorro actual", minor]])];
    case "debt_cost_evolution": return [table(data.series, [month, ["principalPaidMinor", "Capital pagado", minor], ["paymentsMinor", "Pagos", minor],
      ["interestMinor", "Intereses", minor], ["feeMinor", "Comisiones", minor], ["totalCostMinor", "Costo total", minor]]),
      details([["totalInterestMinor", "Intereses", minor], ["totalFeeMinor", "Comisiones", minor], ["totalCostMinor", "Costo total", minor]]),
      table(data.debtOutlook, [["debtId", "Deuda (ID)", text], ["estimatedFutureCost", "Costo previsto", nullable(money)],
        ["estimatedRemainingMonths", "Meses restantes", nullable(count)]], "Perspectiva por deuda")];
    case "subscription_annual_cost": return [table(data.items, [payee, ["frequency", "Frecuencia", text], ["currentAmount", "Importe actual", money],
      ["annualCost", "Costo anual", nullable(money)]]), details([["totalAnnualCost", "Costo anual total", money]])];
  }
}

export function parseAdvancedMetric(input: unknown, metric: AdvancedMetric) {
  const { metric: actual, generatedAt, currency, assumptions, missingData, fxRatesUsed, data, explanation } = record(input);
  if (actual !== metric || typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt)) ||
    typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency)) return invalid();
  return { metric, generatedAt, currency, assumptions: strings(assumptions), missingData: strings(missingData),
    fxRatesUsed: parseFxRatesUsed(fxRatesUsed), explanation: explanation == null ? null : text(explanation), tables: metricTables(metric, record(data), currency) };
}
