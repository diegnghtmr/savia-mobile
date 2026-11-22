import { useEffect, useRef, useState } from "react";
import { AppState, ScrollView, Text, useColorScheme } from "react-native";
import type { Outbox } from "../foundation/outbox";
import { pendingWarning } from "../foundation/pending-expiry";
import { AuthAction } from "./auth-gate";
import { paletteFor } from "./tokens";
import { confirmPendingLabel } from "./use-pending-write";

const labelFor = (path: string) => path === "/v1/transfers" ? "transferencia" : path === "/v1/currency-exchanges" ? "cambio de moneda" : "movimiento";

export function OutboxPanel({ box }: { box: Outbox }) {
  const colors = paletteFor(useColorScheme());
  const [rows, setRows] = useState<Awaited<ReturnType<Outbox["list"]>>>([]), [view, setView] = useState(false);
  const [busy, setBusy] = useState(false), [discard, setDiscard] = useState<number>(), [error, setError] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let active = true, sequence = 0;
    const refresh = async () => {
      const attempt = ++sequence;
      try { const items = await box.list(); if (active && attempt === sequence) setRows(items); } catch { /* Storage unavailable. */ }
    };
    const run = () => void box.sync().catch(() => {});
    const unsubscribe = box.subscribe(() => void refresh());
    const app = AppState.addEventListener("change", (state) => { if (state === "active") run(); });
    const timer = setInterval(() => { if (AppState.currentState === "active") run(); }, 15_000);
    void refresh(); run();
    return () => { active = false; unsubscribe(); app.remove(); clearInterval(timer); };
  }, [box]);
  const action = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(false); setDiscard(undefined);
    try { await operation(); setRows(await box.list()); }
    catch { setError(true); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!rows.length && !view) return null;
  return <>
    <AuthAction label={`Operaciones pendientes (${rows.length})`} selected={view} action={() => { setView(!view); setDiscard(undefined); }} />
    {view && <ScrollView style={{ maxHeight: 240, backgroundColor: colors.raised }} contentContainerStyle={{ padding: 12, gap: 8 }}>
      <AuthAction label="Sincronizar ahora" disabled={busy || !rows.length} action={() => void action(() => box.sync())} />
      {busy && <Text accessibilityLiveRegion="polite" style={{ color: colors.text }}>Sincronizando…</Text>}
      {error && <Text accessibilityRole="alert" style={{ color: colors.text }}>No pudimos sincronizar las operaciones.</Text>}
      {rows.map(({ id, path, issue, queued_at }) => <TextRow key={id} title={`Operación ${id}: ${labelFor(path)} · ${new Date(queued_at).toLocaleString("es-CO")}`} color={colors.text}>
        <Text accessibilityRole={issue ? "alert" : undefined} style={{ color: colors.text }}>{issue === "expired" ? pendingWarning : issue === "failed" ? "No se pudo sincronizar. Revisa la operación."
          : issue ? `Conflicto (${issue}). Revisa la lista y los datos de la operación.` : "Pendiente de sincronización"}</Text>
        {issue === "expired" && <AuthAction label={confirmPendingLabel} disabled={busy} action={() => void action(() => box.sync(id))} />}
        {issue && (discard === id ? <AuthAction label="Confirmar descarte" disabled={busy} action={() => void action(() => box.discard(id))} /> :
          <AuthAction label={`Descartar ${labelFor(path)}`} disabled={busy} action={() => setDiscard(id)} />)}
      </TextRow>)}
    </ScrollView>}
  </>;
}

function TextRow({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return <><Text accessibilityRole="header" style={{ color }}>{title}</Text>{children}</>;
}
