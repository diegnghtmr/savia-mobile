import { useRef, useState } from "react";
import { InvalidDraft } from "../foundation/identity-draft";
import { OutboxQueued, PendingSubmissionExpired } from "../foundation/pending-expiry";
import { TransportError } from "../foundation/transport";

export const confirmPendingLabel = "Registrar de todos modos";

export function usePendingWrite(conflictMessage?: string, onQueued?: () => void) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [confirm, setConfirm] = useState<() => void>();
  const clear = () => { setError(""); setConfirm(undefined); };
  async function run(operation: (confirmation?: PendingSubmissionExpired) => Promise<void>,
    fallback = "No pudimos guardar el movimiento. Vuelve a intentarlo.", confirmation?: PendingSubmissionExpired) {
    if (lock.current) return;
    lock.current = true; setBusy(true); clear();
    try { await operation(confirmation); }
    catch (failure) {
      if (failure instanceof PendingSubmissionExpired) {
        setError(failure.message);
        setConfirm(() => () => void run(operation, fallback, failure));
      } else if (failure instanceof OutboxQueued) {
        onQueued?.(); setError(failure.message);
      } else setError(failure instanceof InvalidDraft ? failure.message
        : conflictMessage && failure instanceof TransportError && failure.kind === "http" && failure.status === 412 ? conflictMessage : fallback);
    } finally { lock.current = false; setBusy(false); }
  }
  return { run, busy, error, confirm, clear };
}
