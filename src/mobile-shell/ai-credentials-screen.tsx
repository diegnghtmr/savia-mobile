import { useEffect, useState } from "react";
import type { AICredentials, Credential } from "../foundation/ai-credentials";
import { InvalidDraft } from "../foundation/identity-draft";
import { TransportError } from "../foundation/transport";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { PrivateField } from "./private-field";
import { usePendingWrite } from "./use-pending-write";

type Catalogue = Awaited<ReturnType<AICredentials["load"]>>;
const label = (row: Credential) => row.alias || row.providerId;
const loadError = "No pudimos cargar las credenciales de IA.", saveError = "No pudimos guardar la credencial.";
export function AICredentialsScreen({ api, back }: { api: AICredentials; back: () => void }) {
  const [data, setData] = useState<Catalogue>(), [choice, setChoice] = useState<Catalogue["choices"][number]>();
  const [owner, setOwner] = useState<"user" | "workspace">("user"), [alias, setAlias] = useState(""), [secret, setSecret] = useState(""), [metadata, setMetadata] = useState("");
  const [edit, setEdit] = useState<Credential>(), [editAlias, setEditAlias] = useState(""), [replacement, setReplacement] = useState(""), [active, setActive] = useState(true);
  const [remove, setRemove] = useState<Credential>(), [model, setModel] = useState(""), [modelKey, setModelKey] = useState<Credential>(), [notice, setNotice] = useState("");
  const write = usePendingWrite(), locked = write.busy || !!write.confirm;
  function closeEdit() { setEdit(undefined); setReplacement(""); setEditAlias(""); }
  async function refresh() {
    setData(undefined); setChoice(undefined); setModelKey(undefined); closeEdit(); setRemove(undefined); setNotice("");
    setSecret(""); setMetadata(""); setData(await api.load());
  }
  useEffect(() => { void write.run(refresh, loadError); }, [api]);
  function putRows(rows: Credential[]) {
    setData((old) => old && { ...old, rows });
    setModelKey((old) => rows.find((row) => old?.id === row.id && row.status === "active"));
  }
  return <AuthPanel>
    <ReportText role="header">Credenciales de IA</ReportText>
    <AuthAction label="Volver al resumen" action={back} disabled={write.busy} />
    <AuthAction label="Actualizar credenciales" disabled={locked} action={() => void write.run(refresh, loadError)} />
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {notice && <ReportText>{notice}</ReportText>}
    {data && <>
      <ReportText role="header">Agregar credencial</ReportText>
      {!data.choices.length && <ReportText>No hay proveedores disponibles para registrar credenciales.</ReportText>}
      {data.choices.map((item) => <AuthAction key={`${item.providerId}:${item.credentialType}`} label={`${item.name} · ${item.credentialType}`}
        action={() => { if (choice !== item) { setSecret(""); setMetadata(""); } setChoice(item); }} selected={item === choice} disabled={locked} />)}
      {choice && <>
        <AuthAction label="Personal" selected={owner === "user"} disabled={locked} action={() => setOwner("user")} />
        <AuthAction label="Del espacio" selected={owner === "workspace"} disabled={locked} action={() => setOwner("workspace")} />
        <PlanningField label="Alias (opcional)" value={alias} change={setAlias} busy={locked} />
        <PrivateField label="Secreto del proveedor" value={secret} change={setSecret} busy={locked} />
        <PrivateField label="Metadatos JSON (opcional)" value={metadata} change={setMetadata} busy={locked} />
        <AuthAction label="Agregar credencial" disabled={locked} action={() => void write.run(async (permit) => {
          setNotice(""); putRows(await api.add(choice, owner, secret, alias, metadata, permit)); setSecret(""); setMetadata(""); setAlias(""); setNotice("Credencial guardada.");
        }, saveError)} />
      </>}
      <ReportText role="header">Credenciales guardadas</ReportText>
      {!data.rows.length && <ReportText>No hay credenciales guardadas.</ReportText>}
      {data.rows.map((row) => <ReportText key={row.id}>{label(row)} · {row.mask}</ReportText>)}
      {data.rows.map((row) => <ReportText key={`state:${row.id}`}>{label(row)}: {row.ownerType === "user" ? "Personal" : "Del espacio"} · {row.status === "active" ? "Activa" : "Desactivada"}</ReportText>)}
      {data.rows.map((row) => <AuthAction key={`edit:${row.id}`} label={`Editar credencial: ${label(row)}`} disabled={locked || !row.tag} action={() => {
        setNotice(""); write.clear(); setEdit(row); setEditAlias(row.alias ?? ""); setActive(row.status === "active"); setReplacement(""); setRemove(undefined);
      }} />)}
      {data.rows.some((row) => !row.tag) && <ReportText>La edición requiere una versión de la credencial.</ReportText>}
      {edit && <>
        <PlanningField label="Nuevo alias (opcional)" value={editAlias} change={setEditAlias} busy={locked} />
        <PrivateField label="Nuevo secreto (opcional)" value={replacement} change={setReplacement} busy={locked} />
        <AuthAction label="Credencial activa" selected={active} disabled={locked} action={() => setActive(!active)} />
        <AuthAction label="Cancelar edición" disabled={locked} action={() => { closeEdit(); write.clear(); }} />
        <AuthAction label="Guardar cambios de credencial" disabled={locked} action={() => void write.run(async (permit) => {
          try { putRows(await api.edit(edit, editAlias, active ? "active" : "disabled", replacement, permit)); }
          catch (error) {
            if (!(error instanceof TransportError) || error.kind !== "http" || error.status !== 412) throw error;
            await refresh(); throw new InvalidDraft("La credencial cambió. Revisa los datos actualizados.");
          }
          closeEdit(); setNotice("Credencial guardada.");
        }, saveError)} />
      </>}
      {data.rows.map((row) => <AuthAction key={`revoke:${row.id}`} label={`Revocar credencial: ${label(row)}`} disabled={locked} action={() => {
        setRemove(row); closeEdit(); setNotice(""); write.clear();
      }} />)}
      {remove && <><ReportText>¿Revocar {label(remove)}?</ReportText>
        <AuthAction label="Cancelar revocación" disabled={locked} action={() => { setRemove(undefined); write.clear(); }} />
        <AuthAction label="Confirmar revocación" disabled={locked} action={() => void write.run(async (permit) => {
          putRows(await api.remove(remove, permit)); setRemove(undefined); setNotice("Credencial revocada.");
        }, "No pudimos revocar la credencial.")} />
      </>}
      <ReportText role="header">Modelo predeterminado del espacio</ReportText>
      <PlanningField label="Modelo (proveedor:modelo)" value={model} change={setModel} busy={locked} />
      <AuthAction label="Sin credencial específica" action={() => setModelKey(undefined)} selected={!modelKey} disabled={locked} />
      {data.rows.filter((row) => row.ownerType === "workspace" && row.status === "active").map((row) => <AuthAction key={row.id}
        label={`Usar credencial: ${label(row)}`} action={() => setModelKey(row)} selected={modelKey === row} disabled={locked} />)}
      <AuthAction label="Guardar modelo predeterminado" disabled={locked} action={() => void write.run(async (permit) => {
        setNotice(""); await api.setDefault(model, modelKey, permit); setNotice("Modelo predeterminado guardado.");
      }, "No pudimos guardar el modelo predeterminado.")} />
    </>}
    {write.confirm && <><AuthAction label="Confirmar reintento" disabled={write.busy} action={write.confirm} />
      <AuthAction label="Cancelar reintento" disabled={write.busy} action={write.clear} /></>}
  </AuthPanel>;
}
