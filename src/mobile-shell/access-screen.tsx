import { useEffect, useState } from "react";
import { View } from "react-native";
import { mcpScopes, type Access, type Grant, type GrantDraft } from "../foundation/access";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { PrivateField } from "./private-field";
import { usePendingWrite } from "./use-pending-write";

type GrantPage = Awaited<ReturnType<Access["list"]>>;
const empty: GrantDraft = { clientName: "", scopes: [], workspaceIds: [], accounts: "", tools: "", windows: "", limit: "", currency: "", expiry: "" };
const fields = { clientName: "Nombre del cliente MCP", accounts: "IDs de cuentas (opcional)", tools: "Herramientas permitidas (opcional)",
  windows: "Horario semanal (opcional)", limit: "Límite de escritura (opcional)", currency: "Moneda del límite", expiry: "Vencimiento ISO (opcional)" } as const;
const toggle = (list: string[], member: string) => list.includes(member) ? list.filter((id) => id !== member) : [...list, member];
const state = { active: "Activo", revoked: "Revocado", expired: "Vencido" };
const loadError = "No pudimos cargar los permisos MCP.";
export function AccessScreen({ api, back }: { api: Access; back: () => void }) {
  const [page, setPage] = useState<GrantPage>(), [draft, setDraft] = useState(empty), [revoking, setRevoking] = useState<Grant>();
  const [showCli, setShowCli] = useState(false), [code, setCode] = useState(""), [approved, setApproved] = useState(false), [notice, setNotice] = useState("");
  const mcp = usePendingWrite(), cli = usePendingWrite();
  const busy = mcp.busy || cli.busy, locked = busy || !!mcp.confirm;
  function load(cursor?: string) {
    void mcp.run(async () => {
      if (!cursor) { setPage(undefined); setRevoking(undefined); setNotice(""); }
      const next = await api.list(cursor);
      setPage(next);
      setDraft((old) => ({ ...old, workspaceIds: [next.scope, ...old.workspaceIds.filter((id) => id !== next.scope && next.workspaces.some((item) => item.id === id))] }));
    }, loadError);
  }
  useEffect(() => { load(); }, [api]);
  function rows(items: Grant[]) { setPage((old) => old && { ...old, items }); }
  return <AuthPanel>
    <ReportText role="header">Accesos de MCP y CLI</ReportText>
    <AuthAction label="Volver al resumen" action={back} disabled={busy} />
    <ReportText role="header">Permisos MCP</ReportText>
    <AuthAction label="Actualizar permisos MCP" disabled={locked} action={() => load()} />
    {mcp.error && <ReportText role="alert">{mcp.error}</ReportText>}
    {notice && <ReportText>{notice}</ReportText>}
    {page && <>
      {!page.items.length && <ReportText>No hay permisos para este espacio.</ReportText>}
      {page.items.map((row) => <View key={row.id}>
        <ReportText role="header">{row.clientName}</ReportText>
        <ReportText>{state[row.status]} · {row.scopes.join(", ")}</ReportText>
        <ReportText>Espacios: {row.workspaceIds.map((id) => page.workspaces.find((item) => item.id === id)?.name ?? id).join(", ")}</ReportText>
        <ReportText>Cuentas: {row.accountIds.join(", ") || "Sin restricción por cuenta"}</ReportText>
        <ReportText>Herramientas: {row.toolAllowlist.join(", ") || "Solo lectura"}</ReportText>
        <ReportText>Horario: {row.schedule.map(({ dayOfWeek, startTime, endTime }) => `${dayOfWeek} ${startTime}-${endTime}`).join(", ") || "No permite llamadas"}</ReportText>
        <ReportText>Límite: {row.limit ?? "Sin límite adicional"} · Vence: {row.expiresAt ?? "Sin vencimiento"}</ReportText>
        {row.status === "active" && <AuthAction label={`Revocar: ${row.clientName}`} disabled={locked} action={() => { mcp.clear(); setNotice(""); setRevoking(row); }} />}
      </View>)}
      {revoking && <>
        <ReportText>Revocar {revoking.clientName} elimina el permiso en todos sus espacios.</ReportText>
        <AuthAction label="Cancelar revocación MCP" disabled={locked} action={() => setRevoking(undefined)} />
        <AuthAction label="Confirmar revocación MCP" disabled={locked} action={() => void mcp.run(async (permit) => {
          rows(await api.revoke(revoking, permit)); setRevoking(undefined); setNotice("Permiso revocado.");
        }, "No pudimos revocar el permiso MCP.")} />
      </>}
      {page.next && <AuthAction label="Más permisos MCP" disabled={locked} action={() => load(page.next!)} />}
      <ReportText role="header">Crear un permiso restringido</ReportText>
      <ReportText>El permiso incluye el espacio actual. Puedes incluir otros espacios verificados.</ReportText>
      {page.workspaces.filter(({ id }) => id !== page.scope).map(({ id, name }) => <AuthAction key={id} label={`Incluir ${name}`} disabled={locked}
        selected={draft.workspaceIds.includes(id)} action={() => setDraft({ ...draft, workspaceIds: toggle(draft.workspaceIds, id) })} />)}
      <ReportText>Alcances</ReportText>
      {mcpScopes.map((scope) => <AuthAction key={scope} label={scope} disabled={locked} selected={draft.scopes.includes(scope)}
        action={() => setDraft({ ...draft, scopes: toggle(draft.scopes, scope) })} />)}
      <ReportText>Separa con comas las cuentas, herramientas y franjas. Sin herramientas explícitas, solo lectura. Sin horario, no se permiten llamadas.</ReportText>
      <ReportText>Horario local de cada espacio: 1 (lunes) a 7 (domingo), por ejemplo 1 09:00-17:00. Separa las franjas que pasan de medianoche.</ReportText>
      {(Object.keys(fields) as (keyof typeof fields)[]).map((key) => <PlanningField key={key} label={fields[key]} value={draft[key]} busy={locked}
        change={(value) => setDraft({ ...draft, [key]: value })} />)}
      <AuthAction label="Crear permiso MCP" disabled={locked} action={() => void mcp.run(async (permit) => {
        setNotice(""); rows(await api.create(draft, permit)); setRevoking(undefined); setNotice("Permiso creado.");
      }, "No pudimos crear el permiso MCP con esas restricciones.")} />
    </>}
    {mcp.confirm && <><AuthAction label="Confirmar reintento MCP" disabled={busy} action={mcp.confirm} />
      <AuthAction label="Cancelar reintento MCP" disabled={busy} action={mcp.clear} /></>}
    <ReportText role="header">Dispositivos CLI</ReportText>
    {!showCli ? <AuthAction label="Autorizar dispositivo CLI" disabled={locked} action={() => setShowCli(true)} /> : <>
      <ReportText>Esto permite que el dispositivo use tu perfil con los alcances solicitados por la CLI. Aprueba solo un código generado por ti en tu propia terminal.</ReportText>
      <PrivateField label="Código del dispositivo" value={code} busy={locked} change={(value) => { setCode(value); setApproved(false); cli.clear(); }} />
      <AuthAction label="Aprobar dispositivo" disabled={locked} action={() => void cli.run(async () => {
        setApproved(false); await api.approve(code); setCode(""); setApproved(true);
      }, "No pudimos aprobar el dispositivo.")} />
      <AuthAction label="Cancelar" disabled={locked} action={() => { setShowCli(false); setCode(""); setApproved(false); cli.clear(); }} />
      <ReportText>Cancelar no invalida el código; caduca por sí solo.</ReportText>
      {cli.error && <ReportText role="alert">{cli.error}</ReportText>}
      {approved && <ReportText>Dispositivo CLI autorizado.</ReportText>}
    </>}
  </AuthPanel>;
}
