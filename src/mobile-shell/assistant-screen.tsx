import { useEffect, useRef, useState } from "react";
import type { AgentAnswer } from "../foundation/agent-events";
import type { Approval, Assistant, Decision } from "../foundation/assistant";
import { InvalidDraft } from "../foundation/identity-draft";
import { TransportError } from "../foundation/transport";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

type Page<T> = { items: T[]; nextCursor: string | null };
type Conversation = Awaited<ReturnType<Assistant["create"]>>;
const conversationError = "No pudimos cargar las conversaciones.", inboxError = "No pudimos cargar las propuestas.";
const detailError = "No pudimos verificar la propuesta.";
function usePage<T extends { id: string }>(get: (cursor?: string) => Promise<Page<T>>) {
  const [page, set] = useState<Page<T>>(), seen = useRef(new Set<string>());
  async function load(cursor?: string) {
    if (!cursor) { seen.current.clear(); set(undefined); }
    const next = await get(cursor);
    if ((next.nextCursor && seen.current.has(next.nextCursor)) || (cursor && next.items.some(({ id }) => page?.items.some((row) => row.id === id)))) {
      if (page) set({ ...page, nextCursor: null });
      throw new TypeError();
    }
    if (next.nextCursor) seen.current.add(next.nextCursor);
    set({ ...next, items: cursor ? [...(page?.items ?? []), ...next.items] : next.items });
  }
  return { page, load };
}

export function AssistantScreen({ api, back }: { api: Assistant; back: () => void }) {
  const [route, setRoute] = useState<"conversations" | "approvals" | "detail">("conversations");
  const [title, setTitle] = useState(""), [message, setMessage] = useState(""), [approvalId, setApprovalId] = useState("");
  const [active, setActive] = useState<Conversation>(), [answer, setAnswer] = useState<AgentAnswer>(), [reviewed, setReviewed] = useState<Approval>();
  const conversations = usePage(api.conversations), approvals = usePage(api.approvals), write = usePendingWrite();
  const locked = write.busy || !!write.confirm;
  useEffect(() => { void write.run(() => conversations.load(), conversationError); }, [api]);
  function select(row: Conversation) { setActive(row); setAnswer(undefined); setMessage(""); }
  function showApprovals() {
    setReviewed(undefined); setRoute("approvals");
    void write.run(() => approvals.load(), inboxError);
  }
  async function inspect(id: string) {
    setReviewed(undefined);
    const row = await api.detail(id);
    setReviewed(row); setRoute("detail");
  }
  function decide(decision: Decision) {
    if (!reviewed) return;
    void write.run(async (permit) => {
      try { setReviewed(await api.decide(reviewed, decision, permit)); }
      catch (error) {
        if (!(error instanceof TransportError) || error.status !== 412) throw error;
        await inspect(reviewed.id);
        throw new InvalidDraft("La propuesta cambió. Revisa los datos actualizados.");
      }
    }, "No pudimos registrar la decisión.");
  }
  return <AuthPanel>
    <ReportText role="header">{route === "detail" ? "Revisar propuesta" : route === "approvals" ? "Propuestas pendientes" : "Asistente"}</ReportText>
    <AuthAction label="Volver al resumen" action={back} />
    {route === "conversations" ? <>
      <ReportText>El asistente no sustituye la asesoría financiera profesional.</ReportText>
      <AuthAction label="Propuestas pendientes" disabled={locked} action={showApprovals} />
      <PlanningField label="Título (opcional)" value={title} change={setTitle} busy={locked} />
      <AuthAction label="Crear conversación" disabled={locked} action={() => void write.run(async (permit) => {
        select(await api.create(title, permit)); setTitle("");
      }, "No pudimos crear la conversación.")} />
      <AuthAction label="Actualizar conversaciones" disabled={locked} action={() => void write.run(() => conversations.load(), conversationError)} />
      {conversations.page?.items.length === 0 && !active && <ReportText>No hay conversaciones.</ReportText>}
      {conversations.page?.items.map((row) => <AuthAction key={row.id} label={row.title || "Conversación sin título"} selected={row.id === active?.id} disabled={locked} action={() => select(row)} />)}
      {conversations.page?.nextCursor && <AuthAction label="Más conversaciones" disabled={locked} action={() => void write.run(() => conversations.load(conversations.page?.nextCursor ?? undefined), conversationError)} />}
      {active && <><ReportText role="header">{active.title || "Conversación sin título"}</ReportText>
        <PlanningField label="Mensaje" value={message} change={setMessage} busy={locked} />
        <AuthAction label="Enviar mensaje" disabled={locked} action={() => void write.run(async (permit) => {
          setAnswer(undefined); setAnswer(await api.send(active.id, message, permit)); setMessage("");
        }, "No pudimos enviar el mensaje.")} />
      </>}
      {answer?.text && <ReportText>{answer.text}</ReportText>}
      {answer?.needsApproval && <AuthAction label="Revisar propuesta" disabled={locked} action={() => {
        if (answer.approvalId) void write.run(() => inspect(answer.approvalId!), detailError);
        else showApprovals();
      }} />}
    </> : route === "approvals" ? <>
      <AuthAction label="Volver al asistente" disabled={locked} action={() => { write.clear(); setRoute("conversations"); }} />
      <AuthAction label="Actualizar propuestas" disabled={locked} action={showApprovals} />
      <PlanningField label="Identificador de la propuesta" value={approvalId} change={setApprovalId} busy={locked} />
      <AuthAction label="Consultar propuesta" disabled={locked} action={() => void write.run(() => inspect(approvalId), detailError)} />
      {approvals.page?.items.length === 0 && <ReportText>No hay propuestas pendientes.</ReportText>}
      {approvals.page?.items.map((row) => <AuthAction key={row.id} label={`Revisar: ${row.toolName}`} disabled={locked} action={() => void write.run(() => inspect(row.id), detailError)} />)}
      {approvals.page?.nextCursor && <AuthAction label="Más propuestas" disabled={locked} action={() => void write.run(() => approvals.load(approvals.page?.nextCursor ?? undefined), inboxError)} />}
    </> : <>
      <AuthAction label="Volver a propuestas" disabled={locked} action={showApprovals} />
      {reviewed && <>
        <ReportText>Acción: {reviewed.toolName}</ReportText><ReportText>Riesgo: {reviewed.risk}</ReportText>
        <ReportText>Estado: {reviewed.label}</ReportText><ReportText>Vence: {reviewed.expiresAt}</ReportText>
        <ReportText role="header">Datos de la propuesta</ReportText><ReportText>{reviewed.preview}</ReportText>
        {reviewed.status === "pending" && <>
          <AuthAction label="Aprobar propuesta" disabled={locked} action={() => decide("confirm")} />
          <AuthAction label="Rechazar propuesta" disabled={locked} action={() => decide("reject")} />
        </>}
      </>}
    </>}
    {write.confirm && <><AuthAction label="Confirmar reintento" disabled={write.busy} action={write.confirm} />
      <AuthAction label="Cancelar reintento" disabled={write.busy} action={write.clear} /></>}
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
  </AuthPanel>;
}
