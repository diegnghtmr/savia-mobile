import { useEffect, useState } from "react";
import { View } from "react-native";
import { InvalidDraft } from "../foundation/identity-draft";
import type { SubscriptionCandidate, Subscriptions } from "../foundation/subscriptions";
import { TransportError } from "../foundation/transport";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { usePendingWrite } from "./use-pending-write";

export function SubscriptionsScreen({ api, back }: { api: Subscriptions; back: () => void }) {
  const [page, setPage] = useState<Awaited<ReturnType<Subscriptions["list"]>>>(), [notice, setNotice] = useState("");
  const [row, select] = useState<SubscriptionCandidate>(), [action, choose] = useState<"confirm" | "discard">();
  const pending = usePendingWrite();
  async function load(cursor?: string) {
    if (!cursor) { select(undefined); choose(undefined); setPage(undefined); setNotice(""); }
    setPage(await api.list(cursor));
  }
  const reload = () => void pending.run(() => load(), "No pudimos cargar las suscripciones detectadas.");
  useEffect(reload, [api]);
  const close = () => { select(undefined); choose(undefined); pending.clear(); };
  const decided = () => void pending.run(async (confirmation) => {
    if (!row || !action) return;
    try {
      setPage(await api.decide(action, row, confirmation));
      close(); setNotice(action === "confirm" ? "Suscripción confirmada." : "Suscripción descartada.");
    } catch (error) {
      if (!(error instanceof TransportError) || (error.status !== 409 && error.status !== 412)) throw error;
      await load();
      throw new InvalidDraft("La suscripción cambió. Revisa los datos actualizados.");
    }
  }, "No pudimos actualizar la suscripción.");

  return <AuthPanel>
    <ReportText role="header">Suscripciones detectadas</ReportText>
    <AuthAction label="Volver al resumen" disabled={pending.busy} action={back} />
    {pending.error && <ReportText role="alert">{pending.error}</ReportText>}
    {notice && <ReportText>{notice}</ReportText>}
    {row ? <>
      <ReportText role="header">{row.name}</ReportText><ReportText>{row.amount} · {row.frequency}</ReportText>
      <AuthAction label="Volver a suscripciones" disabled={pending.busy} action={close} />
      {!action ? <>
        <AuthAction label="Confirmar suscripción" disabled={pending.busy} action={() => choose("confirm")} />
        <AuthAction label="Descartar suscripción" disabled={pending.busy} action={() => choose("discard")} />
      </> : <>
        <ReportText>{action === "confirm" ? "Se creará una regla de recordatorio; no se registrará ningún movimiento." : "La suscripción se descartará sin crear una regla."}</ReportText>
        <AuthAction label={action === "confirm" ? "Sí, confirmar" : "Sí, descartar"} disabled={pending.busy || !!pending.confirm} action={decided} />
        {pending.confirm && <AuthAction label="Confirmar reintento" disabled={pending.busy} action={pending.confirm} />}
      </>}
    </> : <>
      <AuthAction label="Actualizar suscripciones" disabled={pending.busy} action={reload} />
      {pending.busy && !page && <ReportText>Cargando suscripciones…</ReportText>}
      {page && !page.items.length && <ReportText>No hay suscripciones detectadas.</ReportText>}
      {page?.items.map((candidate) => <View key={candidate.id}>
        <ReportText>{candidate.name}</ReportText><ReportText>{candidate.amount} · {candidate.frequency}</ReportText>
        {candidate.nextDate && <ReportText>Próximo cobro: {candidate.nextDate}</ReportText>}
        {page.canDecide && candidate.etag && <AuthAction label={`Revisar: ${candidate.name}`} disabled={pending.busy}
          action={() => { pending.clear(); setNotice(""); select(candidate); }} />}
      </View>)}
      {page?.next && <AuthAction label="Cargar más suscripciones" disabled={pending.busy}
        action={() => void pending.run(() => load(page.next!), "No pudimos cargar las suscripciones detectadas.")} />}
    </>}
  </AuthPanel>;
}
