import { useEffect, useState } from "react";
import { View } from "react-native";
import type { RecurringRules } from "../foundation/recurring-rules";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { usePendingWrite } from "./use-pending-write";

export function RecurringRulesScreen({ api, back }: { api: RecurringRules; back: () => void }) {
  const [page, setPage] = useState<Awaited<ReturnType<RecurringRules["list"]>>>();
  const { busy, error, run } = usePendingWrite();
  const load = (cursor?: string) => void run(async () => {
    if (!cursor) setPage(undefined);
    try { setPage(await api.list(cursor)); }
    catch (error) { setPage(undefined); throw error; }
  }, "No pudimos cargar las reglas recurrentes.");
  useEffect(() => load(), [api]);
  return <AuthPanel>
    <ReportText role="header">Reglas recurrentes</ReportText>
    <AuthAction label="Volver al resumen" action={back} />
    <AuthAction label="Actualizar reglas" disabled={busy} action={() => load()} />
    {error && <ReportText role="alert">{error}</ReportText>}
    {busy && !page && <ReportText>Cargando reglas…</ReportText>}
    {page && !page.items.length && <ReportText>No hay reglas recurrentes.</ReportText>}
    {page?.items.map((row) => <View key={row.id}>
      <ReportText role="header">{row.name}</ReportText><ReportText>{row.active ? "Activa" : "Inactiva"}</ReportText>
      <ReportText>{row.frequency} · {row.behavior}</ReportText><ReportText>Próxima ocurrencia (UTC): {row.next}</ReportText>
    </View>)}
    {page?.next && <AuthAction label="Cargar más reglas" disabled={busy} action={() => load(page.next!)} />}
  </AuthPanel>;
}
