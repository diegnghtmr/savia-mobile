import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { subscriptionPreviewLimit, type Analytics, type ReportPeriod } from "../foundation/analytics";
import { dashboardCards, type DashboardCardId, type DashboardPreferences, type DashboardPreferencesApi } from "../foundation/dashboard-preferences";
import { InvalidDraft } from "../foundation/identity-draft";
import { AuthAction, AuthPanel } from "./auth-gate";
import { DashboardPreferencesScreen } from "./dashboard-preferences-screen";
import { FxFreshness, PeriodReport, ReportText } from "./period-report";

function upcomingRange(now: Date) {
  const to = new Date(now.getTime());
  to.setUTCDate(to.getUTCDate() + 30);
  return { from: now.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function savedRange(period: DashboardPreferences["period"], now: Date): ReportPeriod {
  if (period.preset === "custom") return { from: period.from, to: period.to };
  const to = now.toISOString().slice(0, 10), year = to.slice(0, 4);
  const month = period.preset === "this_year" ? "01" : period.preset === "this_quarter"
    ? String(1 + 3 * Math.floor(now.getUTCMonth() / 3)).padStart(2, "0") : to.slice(5, 7);
  return { from: `${year}-${month}-01`, to };
}

type Links = Partial<Record<"account_balances" | "alerts" | "reconciliation_status", () => void>>;
const defaults: DashboardCardId[] = ["net_worth", "assets", "debts", "income", "expenses", "savings_capacity", "budget_utilization", "upcoming_operations"];
export function DashboardScreen({ api, back, initial, now, preferences, links }: { api: Analytics; back: () => void; initial?: ReportPeriod;
  now?: Date; preferences?: DashboardPreferencesApi; links?: Links }) {
  const [customizing, customize] = useState(false), [display, setDisplay] = useState<DashboardPreferences | null>();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!preferences || customizing) return;
    let current = true;
    void preferences.display().then((result) => { if (current) { setDisplay(result); setNotice(""); } }, (error) => {
      if (current) { setDisplay(null); setNotice(error instanceof InvalidDraft ? error.message : "No pudimos cargar las preferencias del resumen."); }
    });
    return () => { current = false; };
  }, [preferences, customizing]);
  const currency = display?.presentationCurrency;
  const load = useMemo(() => (period: ReportPeriod) => api.dashboard(period, upcomingRange(now ?? new Date()), currency), [api, now, currency]);
  if (preferences && customizing) return <DashboardPreferencesScreen api={preferences} back={() => { setDisplay(undefined); customize(false); }} />;
  if (preferences && display === undefined) return <AuthPanel><ReportText role="header">Resumen financiero</ReportText>
    <AuthAction label="Volver al resumen" action={back} /><ReportText>Cargando preferencias…</ReportText></AuthPanel>;
  const period = display?.period;
  const range = period ? savedRange(period, now ?? new Date()) : initial;
  const toolbar = preferences && <><AuthAction label="Personalizar resumen" action={() => customize(true)} />
    {notice && <ReportText>{notice}</ReportText>}
    {period && period.preset !== "custom" && <ReportText>No pudimos verificar la zona horaria del espacio para el período guardado. Se muestra el período en UTC.</ReportText>}
  </>;
  return <PeriodReport title="Resumen financiero" load={load} back={back} initial={range} toolbar={toolbar}>{({ summary, upcoming, future, calendarRates, subscriptions }) => {
    const visible = display?.cards.filter(({ visible }) => visible).map(({ id }) => id) ?? defaults;
    const values = { net_worth: summary.netWorth, assets: summary.assets, debts: summary.debts, income: summary.income,
      expenses: summary.expenses, savings_capacity: summary.netFlow, budget_utilization: summary.budget ?? "No informada" };
    const upcomingCard = <>
    <ReportText role="header">Próximos movimientos recurrentes</ReportText>
    <ReportText>Agenda estimada: {future.from} – {future.to} (UTC)</ReportText>
    <FxFreshness rates={calendarRates} label="Tipos de cambio de la agenda" fallback={false} />
    {upcoming === null ? <ReportText role="alert">No pudimos cargar los próximos movimientos.</ReportText>
      : !upcoming.length ? <ReportText>No hay movimientos recurrentes previstos.</ReportText>
      : upcoming.map((row) => <ReportText key={`${row.date}:${row.id}`}>{row.date} · {row.label}: {row.amount}</ReportText>)}
    </>;
    return <>
    <ReportText>Moneda base: {summary.currency}</ReportText>
    <FxFreshness rates={summary.fxRatesUsed} fallback={!(calendarRates && visible.includes("upcoming_operations"))} />
    {!visible.length && <ReportText>No hay tarjetas visibles.</ReportText>}
    {visible.map((id) => {
      if (id === "upcoming_operations") return <View key={id}>{upcomingCard}</View>;
      if (id === "account_balances" || id === "alerts" || id === "reconciliation_status") {
        const action = links?.[id];
        return action ? <AuthAction key={id} label={dashboardCards[id]} action={action} /> : null;
      }
      const value = values[id];
      return value !== null || display ? <ReportText key={id}>{dashboardCards[id]}: {value ?? "No disponible"}</ReportText> : null;
    })}
    <ReportText role="header">Suscripciones detectadas</ReportText>
    {subscriptions === null ? <ReportText role="alert">No pudimos cargar las suscripciones detectadas.</ReportText>
      : !subscriptions.items.length ? <ReportText>No hay suscripciones detectadas.</ReportText> : <>
        {subscriptions.items.map((row) => <View key={row.id} style={{ gap: 4 }}>
          <ReportText>{row.name}: {row.amount}</ReportText>{row.next && <ReportText>Próximo cargo estimado: {row.next}</ReportText>}
        </View>)}
        {subscriptions.more && <ReportText>Mostrando las primeras {subscriptionPreviewLimit} suscripciones detectadas.</ReportText>}
      </>}
    </>;
  }}</PeriodReport>;
}
