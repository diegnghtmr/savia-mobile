import { View } from "react-native";
import type { Analytics, ReportPeriod } from "../foundation/analytics";
import { FxFreshness, PeriodReport, ReportText } from "./period-report";

export function AnalyticsScreen({ api, back, initial }: { api: Analytics; back: () => void; initial?: ReportPeriod }) {
  return <PeriodReport title="Analítica" load={api.breakdown} back={back} initial={initial}>{({ summary, categories, months }) => <>
    <ReportText>Moneda base: {summary.currency}</ReportText><FxFreshness />
    <ReportText role="header">Ingresos frente a gastos</ReportText>
    <ReportText>Ingresos del período: {summary.income}</ReportText><ReportText>Gastos netos del período: {summary.expenses}</ReportText>
    <ReportText role="header">Gastos por categoría</ReportText>
    {!categories.length && <ReportText>No hay gastos por categoría para este período.</ReportText>}
    {categories.map((row) => <ReportText key={row.id}>{row.name}: {row.amount} · {row.percent}</ReportText>)}
    <ReportText role="header">Ingresos y gastos por mes</ReportText>
    {!months.length && <ReportText>No hay datos mensuales para este período.</ReportText>}
    {months.map((row) => <View key={row.month} style={{ gap: 4 }}>
      <ReportText role="header">{row.month}</ReportText><ReportText>Ingresos: {row.income}</ReportText>
      <ReportText>Gastos netos: {row.expenses}</ReportText><ReportText>Flujo neto: {row.net}</ReportText>
    </View>)}
  </>}</PeriodReport>;
}
