import { useEffect, useState } from "react";
import { View } from "react-native";
import type { Sessions } from "../foundation/sessions";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { usePendingWrite } from "./use-pending-write";

export function SessionsScreen({ api, back, signOutAll }: { api: Sessions; back: () => void; signOutAll: () => Promise<void> }) {
  const [page, setPage] = useState<Awaited<ReturnType<Sessions["list"]>>>();
  const [closing, setClosing] = useState<"others" | "all">(), [closed, setClosed] = useState(false);
  const { busy, error, run, clear } = usePendingWrite();
  const load = (cursor?: string) => void run(async () => {
    try { setPage(await api.list(cursor)); }
    catch (error) { setPage(undefined); throw error; }
  }, "No pudimos cargar las sesiones.");
  useEffect(() => load(), [api]);
  const close = () => void run(async () => {
    if (closing === "all") { await signOutAll(); return; }
    if (closing !== "others") return;
    await api.closeOthers(); setClosing(undefined); setClosed(true); setPage(undefined);
    setPage(await api.list());
  }, closing === "all" ? "No pudimos cerrar todas las sesiones." : "No pudimos confirmar el estado de las demás sesiones.");
  return <AuthPanel>
    <ReportText role="header">Sesiones</ReportText>
    <AuthAction label="Volver al resumen" disabled={busy} action={back} />
    {error && <ReportText role="alert">{error}</ReportText>}
    {closed && <ReportText>Se cerraron las demás sesiones.</ReportText>}
    {page?.items.map(({ id, current, createdAt, lastActiveAt, userAgent }) => <View key={id}>
      <ReportText role="header">{current ? "Sesión actual" : "Otra sesión"}</ReportText>
      {userAgent && <ReportText>{userAgent}</ReportText>}
      <ReportText>Inicio (UTC): {createdAt}</ReportText><ReportText>Última actividad (UTC): {lastActiveAt}</ReportText>
    </View>)}
    {page && !page.items.length && <ReportText>No hay sesiones activas.</ReportText>}
    {closing ? <>
      <ReportText>{closing === "all" ? "Se cerrará esta sesión y todas las demás." : "La sesión actual seguirá abierta."}</ReportText>
      <AuthAction label="Confirmar cierre" action={close} disabled={busy} />
      <AuthAction label="Cancelar" action={() => { setClosing(undefined); clear(); }} disabled={busy} />
    </> : <>
      <AuthAction label="Actualizar sesiones" action={() => load()} disabled={busy} />
      {page?.next && <AuthAction label="Cargar más sesiones" action={() => load(page.next!)} disabled={busy} />}
      {page && <AuthAction label="Cerrar las demás sesiones" action={() => { setClosing("others"); clear(); setClosed(false); }} disabled={busy} />}
      <AuthAction label="Cerrar todas las sesiones" action={() => { setClosing("all"); clear(); setClosed(false); }} disabled={busy} />
    </>}
  </AuthPanel>;
}
