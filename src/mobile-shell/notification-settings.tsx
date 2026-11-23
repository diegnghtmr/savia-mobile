import { useEffect, useState } from "react";
import { notificationChannels, type NotificationPreferences, type Preferences, type PushTokenSource, type QuietHours } from "../foundation/notification-preferences";
import { InvalidDraft } from "../foundation/identity-draft";
import { TransportError } from "../foundation/transport";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

const conflict = "Las preferencias cambiaron. Vuelve a cargarlas antes de guardar.";
const quietFields = { start: "Inicio (HH:mm)", end: "Fin (HH:mm)", timezone: "Zona horaria (IANA)" } as const;
export function NotificationSettings({ api, tokenSource, back }: { api: NotificationPreferences; tokenSource?: PushTokenSource; back: () => void }) {
  const [record, setRecord] = useState<Awaited<ReturnType<NotificationPreferences["load"]>>>(), [draft, setDraft] = useState<Preferences>();
  const [saved, setSaved] = useState(false), [registered, setRegistered] = useState(false);
  const write = usePendingWrite(conflict), push = usePendingWrite();
  const locked = write.busy || !!write.confirm;
  function load() {
    void write.run(async () => { setSaved(false); setDraft(undefined); setRecord(undefined); const next = await api.load(); setRecord(next); setDraft(next.value); },
      "No pudimos cargar las preferencias.");
  }
  useEffect(load, [api]);
  function change(next: Preferences) { setDraft(next); setSaved(false); }
  return <AuthPanel>
    <ReportText role="header">Preferencias de notificaciones</ReportText><AuthAction label="Volver a notificaciones" action={back} />
    <ReportText>Estas preferencias se aplican a todo tu perfil.</ReportText>
    <ReportText>Umbrales fijos de alertas de presupuesto: 80 % y 100 %.</ReportText>
    <AuthAction label="Volver a cargar preferencias" disabled={write.busy} action={load} />
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {saved && <ReportText>Preferencias guardadas.</ReportText>}
    {draft && record && <>
      {(Object.keys(notificationChannels) as (keyof typeof notificationChannels)[]).map((channel) => <AuthAction key={channel} label={notificationChannels[channel]}
        selected={draft.channels[channel]} disabled={locked} action={() => change({ ...draft, channels: { ...draft.channels, [channel]: !draft.channels[channel] } })} />)}
      <AuthAction label="Resumen del lunes" selected={draft.digestEnabled} disabled={locked} action={() => change({ ...draft, digestEnabled: !draft.digestEnabled })} />
      <AuthAction label={draft.quietHours ? "Desactivar horario de silencio" : "Activar horario de silencio"} selected={!!draft.quietHours} disabled={locked}
        action={() => change({ ...draft, quietHours: draft.quietHours ? null : { start: "22:00", end: "07:00", timezone: "UTC" } })} />
      {draft.quietHours && (Object.keys(quietFields) as (keyof QuietHours)[]).map((key) => <PlanningField key={key} label={quietFields[key]}
        value={draft.quietHours![key]} busy={locked} change={(value) => change({ ...draft, quietHours: { ...draft.quietHours!, [key]: value } })} />)}
      <AuthAction label="Guardar preferencias" disabled={locked || write.error === conflict} action={() => void write.run(async (approval) => {
        const next = await api.save(draft, record.etag, approval); setRecord(next); setDraft(next.value); setSaved(true);
      }, "No pudimos guardar las preferencias.")} />
      {write.confirm && <AuthAction label="Confirmar reintento de preferencias" disabled={write.busy} action={write.confirm} />}
    </>}
    <ReportText role="header">Registro push</ReportText>
    {tokenSource ? <AuthAction label="Registrar este dispositivo" disabled={push.busy || write.busy} action={() => void push.run(async () => {
      setRegistered(false);
      const registration = await tokenSource();
      if (!registration) throw new InvalidDraft("No se obtuvo permiso para registrar el dispositivo.");
      try { await api.register(registration); setRegistered(true); }
      catch (error) {
        if (error instanceof TransportError && error.status === 409) throw new InvalidDraft("El dispositivo ya está registrado en otro perfil.");
        throw error;
      }
    }, "No pudimos registrar este dispositivo.")} /> : <ReportText>Fuente de token push no disponible en esta instalación.</ReportText>}
    {push.error && <ReportText role="alert">{push.error}</ReportText>}
    {registered && <ReportText>Dispositivo registrado.</ReportText>}
  </AuthPanel>;
}
