import { useEffect, useState } from "react";
import { View } from "react-native";
import { dashboardCards, dashboardConflict, dashboardPeriods, type DashboardCardId, type DashboardPreferences, type DashboardPreferencesApi } from "../foundation/dashboard-preferences";
import { InvalidDraft } from "../foundation/identity-draft";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

type Preset = keyof typeof dashboardPeriods;
export function DashboardPreferencesScreen({ api, back }: { api: DashboardPreferencesApi; back: () => void }) {
  const [current, setCurrent] = useState<Awaited<ReturnType<DashboardPreferencesApi["edit"]>>>();
  const [cards, setCards] = useState<DashboardPreferences["cards"]>([]), [preset, setPreset] = useState<Preset>("this_month");
  const [currency, setCurrency] = useState(""), [from, setFrom] = useState(""), [to, setTo] = useState(""), [saved, setSaved] = useState(false);
  const { run, busy, error, confirm, clear } = usePendingWrite();
  const show = (data: Awaited<ReturnType<DashboardPreferencesApi["edit"]>>) => {
    const { cards, period, presentationCurrency } = data.body;
    setCurrent(data); setCards(cards); setPreset(period.preset); setCurrency(presentationCurrency);
    setFrom(period.preset === "custom" ? period.from : ""); setTo(period.preset === "custom" ? period.to : "");
  };
  const load = () => void run(async () => { setCurrent(undefined); show(await api.edit()); }, "No pudimos cargar las preferencias en línea.");
  useEffect(() => load(), [api]);
  const edit = (operation: () => void) => { setSaved(false); clear(); operation(); };
  const move = (index: number, delta: number) => edit(() => setCards((old) => {
    const next = [...old]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next;
  }));
  const save = () => void run(async (confirmation) => {
    if (!current) return;
    try {
      show(await api.save(current, { cards, period: preset === "custom" ? { preset, from, to } : { preset }, presentationCurrency: currency }, confirmation));
      setSaved(true);
    } catch (error) {
      if (!dashboardConflict(error)) throw error;
      setCurrent(undefined); show(await api.edit());
      throw new InvalidDraft("Las preferencias cambiaron. Revisa los datos actualizados.");
    }
  }, "No pudimos guardar las preferencias.");
  return <AuthPanel>
    <ReportText role="header">Personalizar resumen</ReportText><AuthAction label="Volver al informe" action={back} disabled={busy} />
    {error && <ReportText role="alert">{error}</ReportText>}{saved && <ReportText>Preferencias guardadas.</ReportText>}
    {!current ? <AuthAction label="Actualizar preferencias" action={load} disabled={busy} /> : <>
      {cards.map(({ id, visible }, index) => <View key={id}>
        <ReportText>{dashboardCards[id]}</ReportText>
        <AuthAction label={`${visible ? "Ocultar" : "Mostrar"}: ${dashboardCards[id]}`} disabled={busy} action={() => edit(() =>
          setCards((old) => old.map((card) => card.id === id ? { id, visible: !visible } : card)))} />
        <AuthAction label={`Subir: ${dashboardCards[id]}`} disabled={busy || index === 0} action={() => move(index, -1)} />
        <AuthAction label={`Bajar: ${dashboardCards[id]}`} disabled={busy || index === cards.length - 1} action={() => move(index, 1)} />
      </View>)}
      {(Object.keys(dashboardCards) as DashboardCardId[]).filter((id) => !cards.some((card) => card.id === id)).map((id) =>
        <AuthAction key={id} label={`Añadir: ${dashboardCards[id]}`} disabled={busy} action={() => edit(() => setCards((old) => [...old, { id, visible: true }]))} />)}
      {Object.entries(dashboardPeriods).map(([key, label]) => <AuthAction key={key} label={label} selected={key === preset} disabled={busy}
        action={() => edit(() => setPreset(key as Preset))} />)}
      {preset === "custom" && <>
        <PlanningField label="Desde (AAAA-MM-DD)" value={from} busy={busy} change={(value) => edit(() => setFrom(value))} />
        <PlanningField label="Hasta (AAAA-MM-DD)" value={to} busy={busy} change={(value) => edit(() => setTo(value))} />
      </>}
      <PlanningField label="Moneda de presentación" value={currency} busy={busy} change={(value) => edit(() => setCurrency(value))} />
      <AuthAction label="Guardar preferencias" action={save} disabled={busy || saved || !!confirm} />
      {confirm && <AuthAction label="Confirmar reintento" disabled={busy} action={confirm} />}
    </>}
  </AuthPanel>;
}
