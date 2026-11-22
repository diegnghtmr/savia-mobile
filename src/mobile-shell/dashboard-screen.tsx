import { useMemo } from "react";
import { View } from "react-native";
import { subscriptionPreviewLimit, type Analytics, type ReportPeriod } from "../foundation/analytics";
import { FxFreshness, PeriodReport, ReportText } from "./period-report";

function upcomingRange(now: Date) {
  const to = new Date(now.getTime());
  to.setUTCDate(to.getUTCDate() + 30);
  return { from: now.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function DashboardScreen({ api, back, initial, now }: { api: Analytics; back: () => void; initial?: ReportPeriod; now?: Date }) {
  const load = useMemo(() => (period: ReportPeriod) => api.dashboard(period, upcomingRange(now ?? new Date())), [api, now]);
  return <PeriodReport title="Resumen financiero" load={load} back={back} initial={initial}>{({ summary, upcoming, future, subscriptions }) => <>
    <ReportText>Moneda base: {summary.currency}</ReportText><FxFreshness />
    <ReportText>Patrimonio neto: {summary.netWorth}</ReportText>
    {summary.assets !== null && <ReportText>Activos: {summary.assets}</ReportText>}
    {summary.debts !== null && <ReportText>Deudas: {summary.debts}</ReportText>}
    <ReportText>Ingresos: {summary.income}</ReportText><ReportText>Gastos netos: {summary.expenses}</ReportText>
    <ReportText>Flujo neto: {summary.netFlow}</ReportText>
    <ReportText>Utilización del presupuesto: {summary.budget ?? "No informada"}</ReportText>
    <ReportText role="header">Próximos movimientos recurrentes</ReportText>
    <ReportText>Agenda estimada: {future.from} – {future.to} (UTC)</ReportText>
    {upcoming === null ? <ReportText role="alert">No pudimos cargar los próximos movimientos.</ReportText>
      : !upcoming.length ? <ReportText>No hay movimientos recurrentes previstos.</ReportText>
      : upcoming.map((row) => <ReportText key={`${row.date}:${row.id}`}>{row.date} · {row.label}: {row.amount}</ReportText>)}
    <ReportText role="header">Suscripciones detectadas</ReportText>
    {subscriptions === null ? <ReportText role="alert">No pudimos cargar las suscripciones detectadas.</ReportText>
      : !subscriptions.items.length ? <ReportText>No hay suscripciones detectadas.</ReportText> : <>
        {subscriptions.items.map((row) => <View key={row.id} style={{ gap: 4 }}>
          <ReportText>{row.name}: {row.amount}</ReportText>{row.next && <ReportText>Próximo cargo estimado: {row.next}</ReportText>}
        </View>)}
        {subscriptions.more && <ReportText>Mostrando las primeras {subscriptionPreviewLimit} suscripciones detectadas.</ReportText>}
      </>}
  </>}</PeriodReport>;
}
