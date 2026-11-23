import { useMemo, useState } from "react";
import { View } from "react-native";
import { advancedMetrics, type AdvancedMetric, type MetricTable } from "../foundation/advanced-analytics";
import { analyticsFilterLabels, cashGranularities, type Analytics, type AnalyticsFilterKey, type ReportPeriod } from "../foundation/analytics";
import { AuthAction } from "./auth-gate";
import { FxFreshness, PeriodReport, ReportText } from "./period-report";
import { PlanningField } from "./planning-field";

const sections = { breakdown: "Desglose", cash: "Flujo de caja", advanced: "Métricas avanzadas" } as const;
const defaultMetric: AdvancedMetric = "net_worth_history";

function Spending({ categories }: { categories: Awaited<ReturnType<Analytics["cashFlow"]>>["categories"] }) {
  return <>
    <ReportText role="header">Gastos por categoría</ReportText>
    {!categories.length && <ReportText>No hay gastos por categoría para este período.</ReportText>}
    {categories.map((row) => <ReportText key={row.id}>{row.name}: {row.amount} · {row.percent}</ReportText>)}
  </>;
}

function AccessibleTable({ table }: { table: MetricTable }) {
  return <View role="table" accessibilityLabel={table.title}>
    <ReportText role="header">{table.title}</ReportText>
    {!table.rows.length && <ReportText>No hay datos para este período.</ReportText>}
    {table.rows.map((cells, index) => <View key={index} role="row" accessible
      accessibilityLabel={cells.map((value, i) => `${table.headers[i]}: ${value}`).join(". ")}
      style={{ gap: 4, paddingVertical: 8 }}>
      {cells.map((value, i) => <View key={table.headers[i]} role="cell">
        <ReportText>{table.headers[i]}</ReportText><ReportText>{value}</ReportText>
      </View>)}
    </View>)}
  </View>;
}

export function AnalyticsScreen({ api, back, initial }: { api: Analytics; back: () => void; initial?: ReportPeriod }) {
  const [section, setSection] = useState<keyof typeof sections>("breakdown");
  const [granularity, setGranularity] = useState<keyof typeof cashGranularities>("month"), [metric, setMetric] = useState(defaultMetric);
  const [filters, setFilters] = useState<Partial<Record<AnalyticsFilterKey | "presentationCurrency", string>>>({});
  const firstCash = useMemo(() => (period: ReportPeriod) => api.cashFlow(period), [api]);
  const firstAdvanced = useMemo(() => (period: ReportPeriod) => api.advanced(period, defaultMetric), [api]);
  const nav = (Object.keys(sections) as (keyof typeof sections)[]).map((key) =>
    <AuthAction key={key} label={sections[key]} selected={key === section} disabled={key === section} action={() => {
      setFilters({}); setGranularity("month"); setMetric(defaultMetric); setSection(key);
    }} />);
  const field = (key: keyof typeof filters, label: string, busy: boolean) => <PlanningField key={key} label={label} busy={busy}
    value={filters[key] ?? ""} change={(value) => setFilters((current) => ({ ...current, [key]: value }))} />;
  const toolbar = (busy: boolean) => <>{nav}
    {section === "cash" ? <>
      <ReportText>Agrupar por</ReportText>
      {(Object.keys(cashGranularities) as (keyof typeof cashGranularities)[]).map((key) => <AuthAction key={key}
        label={cashGranularities[key]} selected={key === granularity} disabled={busy} action={() => setGranularity(key)} />)}
    </> : <>
      <ReportText>Métrica</ReportText>
      {(Object.keys(advancedMetrics) as AdvancedMetric[]).map((key) => <AuthAction key={key}
        label={advancedMetrics[key]} selected={key === metric} disabled={busy} action={() => setMetric(key)} />)}
    </>}
    {field("presentationCurrency", "Moneda de presentación", busy)}
    {(Object.keys(analyticsFilterLabels) as AnalyticsFilterKey[]).map((key) => field(key, `${analyticsFilterLabels[key]} (IDs separados por comas)`, busy))}
  </>;
  const props = { title: "Analítica", back, initial };
  if (section === "cash") return <PeriodReport key="cash" {...props} load={firstCash} toolbar={toolbar}
    submit={(period) => api.cashFlow(period, { granularity, ...filters })}>{({ series, categories, fxRatesUsed }) => <>
    <ReportText role="header">Flujo de caja</ReportText>
    <FxFreshness rates={fxRatesUsed} />
    {!series.length && <ReportText>No hay flujo de caja para este período.</ReportText>}
    {series.map(({ period, net, cumulative }) => <ReportText key={period}>
      {`${period} · Flujo neto: ${net}${cumulative === null ? "" : ` · Acumulado: ${cumulative}`}`}
    </ReportText>)}
    <Spending categories={categories} />
  </>}</PeriodReport>;
  if (section === "advanced") return <PeriodReport key="advanced" {...props} load={firstAdvanced} toolbar={toolbar}
    submit={(period) => api.advanced(period, metric, filters)}>{(result) => <>
    <ReportText>Moneda del informe: {result.currency}</ReportText>
    <ReportText>Generado: {result.generatedAt}</ReportText>
    <FxFreshness rates={result.fxRatesUsed} />
    {result.explanation && <ReportText>{result.explanation}</ReportText>}
    {result.assumptions.length > 0 && <ReportText role="header">Supuestos</ReportText>}
    {result.assumptions.map((item, index) => <ReportText key={index}>{item}</ReportText>)}
    {result.missingData.length > 0 && <ReportText role="header">Datos no disponibles</ReportText>}
    {result.missingData.map((item, index) => <ReportText key={index}>{item}</ReportText>)}
    {result.tables.map((table) => <AccessibleTable key={table.title} table={table} />)}
  </>}</PeriodReport>;
  return <PeriodReport key="breakdown" {...props} load={api.breakdown} toolbar={nav}>{({ summary, categories, months, cashRates, monthlyRates }) => <>
    <ReportText>Moneda base: {summary.currency}</ReportText>
    <FxFreshness rates={summary.fxRatesUsed} fallback={!cashRates && !monthlyRates} />
    <ReportText role="header">Ingresos frente a gastos</ReportText>
    <ReportText>Ingresos del período: {summary.income}</ReportText><ReportText>Gastos netos del período: {summary.expenses}</ReportText>
    <Spending categories={categories} />
    <FxFreshness rates={cashRates} label="Tipos de cambio del gasto por categoría" fallback={false} />
    <ReportText role="header">Ingresos y gastos por mes</ReportText>
    <FxFreshness rates={monthlyRates} label="Tipos de cambio del desglose mensual" fallback={false} />
    {!months.length && <ReportText>No hay datos mensuales para este período.</ReportText>}
    {months.map((row) => <View key={row.month} style={{ gap: 4 }}>
      <ReportText role="header">{row.month}</ReportText><ReportText>Ingresos: {row.income}</ReportText>
      <ReportText>Gastos netos: {row.expenses}</ReportText><ReportText>Flujo neto: {row.net}</ReportText>
    </View>)}
  </>}</PeriodReport>;
}
