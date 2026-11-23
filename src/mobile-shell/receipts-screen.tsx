import { useEffect, useRef, useState } from "react";
import { receiptFields, receiptInProgress, receiptStatuses, validateReceiptImage, type ImageOrigin, type Receipt, type ReceiptImage, type ReceiptImageSource, type Receipts } from "../foundation/receipts";
import type { ReceiptConfirmations } from "../foundation/receipt-confirmations";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReceiptConfirmForm } from "./receipt-confirm-form";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

const readError = "No pudimos consultar el recibo. Actualiza el estado para volver a intentar.";
export function ReceiptsScreen({ api, source, confirmations, back, pollMs = 2000 }: { api: Receipts; source?: ReceiptImageSource; confirmations?: ReceiptConfirmations; back: () => void; pollMs?: number }) {
  const [image, setImage] = useState<ReceiptImage>(), [receipt, setReceipt] = useState<Receipt>(), [id, setId] = useState("");
  const [pollError, setPollError] = useState(""), generation = useRef(0);
  const write = usePendingWrite();
  const open = (next: Receipt) => { setReceipt(next); setId(next.id); };
  const pendingId = receipt && receiptInProgress(receipt.status) ? receipt.id : null;
  useEffect(() => {
    if (!pendingId) return;
    const ticket = generation.current;
    let current = true, attempts = 0, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api.detail(pendingId);
        if (!current || ticket !== generation.current) return;
        open(next);
        if (receiptInProgress(next.status)) {
          if (++attempts < 30) timer = setTimeout(() => void refresh(), pollMs);
          else setPollError("El recibo sigue en proceso. Puedes actualizar su estado.");
        }
      } catch { if (current && ticket === generation.current) setPollError(readError); }
    }
    timer = setTimeout(() => void refresh(), pollMs);
    return () => { current = false; clearTimeout(timer); };
  }, [api, pendingId, pollMs]);
  function reset() { ++generation.current; setPollError(""); setReceipt(undefined); }
  const consult = (raw: string) => void write.run(async () => { reset(); open(await api.detail(raw)); }, readError);
  const pick = (origin: ImageOrigin) => void write.run(async () => {
    const selected = await source?.(origin);
    if (selected) setImage(validateReceiptImage(selected));
  }, "No pudimos abrir el selector de imágenes.");
  return <AuthPanel>
    <ReportText role="header">Recibos</ReportText><AuthAction label="Volver al resumen" action={back} />
    {source ? <><AuthAction label="Tomar foto" disabled={write.busy} action={() => pick("camera")} />
      <AuthAction label="Elegir de la galería" disabled={write.busy} action={() => pick("gallery")} /></>
      : <ReportText>Cámara y galería no disponibles en esta instalación.</ReportText>}
    {image && <><ReportText>{image.name}</ReportText><AuthAction label="Subir recibo" disabled={write.busy || !!write.confirm} action={() => void write.run(async (approval) => {
      reset(); open(await api.upload(image, approval)); setImage(undefined);
    }, "No pudimos subir el recibo.")} />{write.confirm && <AuthAction label="Confirmar reintento de subida" disabled={write.busy} action={write.confirm} />}</>}
    <PlanningField label="Identificador del recibo" value={id} change={setId} busy={write.busy} />
    <AuthAction label="Consultar recibo" disabled={write.busy} action={() => consult(id)} />
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {pollError && <ReportText role="alert">{pollError}</ReportText>}
    {receipt && <><ReportText role="header">{receiptStatuses[receipt.status]}</ReportText>
      <ReportText>Identificador: {receipt.id}</ReportText>
      {(Object.keys(receiptFields) as (keyof typeof receiptFields)[]).map((key) => <ReportText key={key}>{receiptFields[key]}: {receipt[key]
        ? `${receipt[key].value} · confianza ${receipt[key].confidence} %` : "No informado"}</ReportText>)}
      {receipt.transactionId && <ReportText>Movimiento vinculado: {receipt.transactionId}</ReportText>}
      <AuthAction label="Actualizar estado" disabled={write.busy} action={() => consult(receipt.id)} />
      {confirmations && receipt.status === "awaiting_review" && <ReceiptConfirmForm key={receipt.id} receipt={receipt} writes={confirmations}
        done={(transactionId) => setReceipt((current) => current?.id === receipt.id ? { ...current, status: "confirmed", transactionId } : current)} />}
    </>}
  </AuthPanel>;
}
