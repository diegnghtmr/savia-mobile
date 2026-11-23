import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { Inbox } from "../foundation/notification-inbox";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { usePendingWrite } from "./use-pending-write";

type Page = Awaited<ReturnType<Inbox["list"]>>;
const empty: Page = { items: [], nextCursor: null };
const loadError = "No pudimos cargar las notificaciones.";
export function NotificationInbox({ api, back, preferences }: { api: Inbox; back: () => void; preferences?: () => void }) {
  const [page, setPage] = useState(empty), [unread, setUnread] = useState(false), [loaded, setLoaded] = useState(false);
  const cursors = useRef(new Set<string>()), write = usePendingWrite();
  async function load(only = unread, cursor?: string) {
    if (!cursor) { setLoaded(false); setPage(empty); cursors.current.clear(); }
    const next = await api.list({ unreadOnly: only, ...(cursor ? { cursor } : {}) });
    if ((next.nextCursor && cursors.current.has(next.nextCursor)) || (cursor && next.items.some((row) => page.items.some(({ id }) => id === row.id)))) {
      setPage((old) => ({ ...old, nextCursor: null })); throw new TypeError();
    }
    if (next.nextCursor) cursors.current.add(next.nextCursor);
    setPage({ items: cursor ? [...page.items, ...next.items] : next.items, nextCursor: next.nextCursor }); setLoaded(true);
  }
  useEffect(() => { void write.run(() => load(false), loadError); }, [api]);
  return <AuthPanel>
    <ReportText role="header">Notificaciones</ReportText><AuthAction label="Volver al resumen" action={back} />
    {preferences && <AuthAction label="Preferencias de notificaciones" action={preferences} />}
    <ReportText>Esta bandeja pertenece a tu perfil y reúne avisos de tus espacios.</ReportText>
    <AuthAction label="Solo no leídas" selected={unread} disabled={write.busy || !!write.confirm} action={() => {
      setUnread(!unread); void write.run(() => load(!unread), loadError);
    }} />
    <AuthAction label="Actualizar notificaciones" disabled={write.busy} action={() => void write.run(() => load(), loadError)} />
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {write.confirm && <AuthAction label="Confirmar reintento de lectura" disabled={write.busy} action={write.confirm} />}
    {write.busy && !loaded && <ReportText>Cargando notificaciones…</ReportText>}
    {loaded && !page.items.length && <ReportText>No hay notificaciones.</ReportText>}
    {page.items.map((item) => <View key={item.id}>
      <ReportText role="header">{item.title}</ReportText>{item.body && <ReportText>{item.body}</ReportText>}
      <ReportText>{item.createdAt.slice(0, 10)}</ReportText><ReportText>{item.read ? "Leída" : "No leída"}</ReportText>
      {!item.read && <AuthAction label={`Marcar como leída: ${item.title}`} disabled={write.busy || !!write.confirm} action={() => void write.run(async (approval) => {
        await api.mark(item.id, approval);
        setPage((old) => ({ ...old, items: unread ? old.items.filter(({ id }) => id !== item.id) : old.items.map((row) => row.id === item.id ? { ...row, read: true } : row) }));
      }, "No pudimos marcar la notificación.")} />}
    </View>)}
    {page.nextCursor && <AuthAction label="Cargar más" disabled={write.busy || !!write.confirm} action={() => void write.run(() => load(unread, page.nextCursor ?? undefined), loadError)} />}
  </AuthPanel>;
}
