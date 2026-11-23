import { useEffect, useState } from "react";
import { View } from "react-native";
import { InvalidDraft } from "../foundation/identity-draft";
import { memberRoles, type MemberRole, type Members, type WorkspaceInvitation, type WorkspaceMember } from "../foundation/members";
import { TransportError } from "../foundation/transport";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

type Tab = "members" | "invitations";
const statuses = { pending: "Pendiente", accepted: "Aceptada", expired: "Vencida", revoked: "Revocada" };
const loadError = "No pudimos cargar la lista.";
const name = (row: WorkspaceMember) => row.displayName || "Nombre no informado";
function RoleOptions({ roles, value, select, busy }: { roles: MemberRole[]; value: MemberRole; select: (role: MemberRole) => void; busy: boolean }) {
  return <>{roles.map((role) => <AuthAction key={role} label={`Rol: ${memberRoles[role]}`} selected={role === value} disabled={busy} action={() => select(role)} />)}</>;
}
export function MembersScreen({ api, back }: { api: Members; back: () => void }) {
  const [tab, setTab] = useState<Tab>("members"), [roles, setRoles] = useState<MemberRole[]>([]);
  const [members, setMembers] = useState<Awaited<ReturnType<Members["members"]>>>(), [invites, setInvites] = useState<Awaited<ReturnType<Members["invitations"]>>>();
  const [target, setTarget] = useState<WorkspaceMember>(), [memberRole, setMemberRole] = useState<MemberRole>("viewer"), [removing, setRemoving] = useState(false);
  const [email, setEmail] = useState(""), [inviteRole, setInviteRole] = useState<MemberRole>("viewer"), [revoking, setRevoking] = useState<WorkspaceInvitation>();
  const [notice, setNotice] = useState(""), write = usePendingWrite(), locked = write.busy || !!write.confirm;
  async function read(next: Tab, cursor?: string) {
    if (!cursor) {
      setRoles([]); setTarget(undefined); setRemoving(false); setRevoking(undefined); setMembers(undefined); setInvites(undefined);
      setRoles(await api.access());
    }
    if (next === "members") setMembers(await api.members(cursor));
    else setInvites(await api.invitations(cursor));
  }
  function show(next: Tab, cursor?: string) {
    if (next !== tab) { setEmail(""); setInviteRole("viewer"); }
    setTab(next); setNotice(""); void write.run(() => read(next, cursor), loadError);
  }
  useEffect(() => { show("members"); }, [api]);
  function saveRole(row: WorkspaceMember) {
    void write.run(async () => {
      setNotice("");
      try { await api.change(row, memberRole); }
      catch (error) {
        if (error instanceof InvalidDraft) throw error;
        await read("members");
        if (error instanceof TransportError && error.kind === "http" && (error.status === 409 || error.status === 412)) {
          throw new InvalidDraft("La membresía cambió. Revisa los datos actualizados.");
        }
        throw error;
      }
      await read("members"); setNotice("Rol actualizado.");
    }, "No pudimos cambiar el rol.");
  }
  return <AuthPanel>
    <ReportText role="header">{tab === "members" ? "Miembros del espacio" : "Invitaciones"}</ReportText>
    <AuthAction label="Volver al resumen" action={back} disabled={write.busy} />
    <AuthAction label="Actualizar lista" action={() => show(tab)} disabled={locked} />
    {tab === "members" ? !!roles.length && <AuthAction label="Ver invitaciones" action={() => show("invitations")} disabled={locked} />
      : <AuthAction label="Ver miembros" action={() => show("members")} disabled={locked} />}
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {notice && <ReportText>{notice}</ReportText>}
    {tab === "members" && members && <>
      {!members.items.length && <ReportText>No hay miembros.</ReportText>}
      {members.items.map((row) => <View key={row.id}>
        <ReportText role="header">{name(row)}</ReportText>
        <ReportText>{memberRoles[row.role]} · {row.status === "active" ? "Activo" : "Suspendido"}</ReportText>
        {roles.length > 0 && row.email && <ReportText>{row.email}</ReportText>}
        {roles.includes(row.role) && <AuthAction label={`Gestionar a ${name(row)}`} disabled={locked} action={() => {
          setNotice(""); write.clear(); setTarget(row); setMemberRole(row.role); setRemoving(false);
        }} />}
      </View>)}
      {target && <>
        <ReportText>Gestionar a {name(target)}</ReportText>
        {!removing ? <>
          <RoleOptions roles={roles} value={memberRole} select={setMemberRole} busy={locked} />
          <AuthAction label="Guardar rol" disabled={locked || memberRole === target.role} action={() => saveRole(target)} />
          <AuthAction label="Eliminar miembro" disabled={locked} action={() => setRemoving(true)} />
        </> : <>
          <ReportText>¿Quitar el acceso de {name(target)}?</ReportText>
          <AuthAction label="Confirmar eliminación" disabled={locked} action={() => void write.run(async (permit) => {
            await api.remove(target, permit); await read("members"); setNotice("Miembro eliminado.");
          }, "No pudimos eliminar al miembro.")} />
        </>}
        <AuthAction label="Cancelar gestión" disabled={locked} action={() => { setTarget(undefined); setRemoving(false); write.clear(); }} />
      </>}
      {members.next && <AuthAction label="Más miembros" disabled={locked} action={() => show("members", members.next!)} />}
    </>}
    {tab === "invitations" && invites && <>
      {!invites.items.length && <ReportText>No hay invitaciones.</ReportText>}
      {invites.items.map((row) => <View key={row.id}>
        <ReportText role="header">{row.email}</ReportText><ReportText>{memberRoles[row.role]} · {statuses[row.status]} · Vence: {row.expiresAt}</ReportText>
        {row.status === "pending" && <AuthAction label={`Revocar invitación: ${row.email}`} disabled={locked} action={() => { setNotice(""); write.clear(); setRevoking(row); }} />}
      </View>)}
      {revoking && <><ReportText>¿Revocar la invitación para {revoking.email}?</ReportText>
        <AuthAction label="Cancelar revocación" disabled={locked} action={() => { setRevoking(undefined); write.clear(); }} />
        <AuthAction label="Confirmar revocación" disabled={locked} action={() => void write.run(async (permit) => {
          const items = await api.revoke(revoking, permit); setInvites({ ...invites, items }); setRevoking(undefined); setNotice("Invitación revocada.");
        }, "No pudimos revocar la invitación.")} />
      </>}
      {invites.next && <AuthAction label="Más invitaciones" disabled={locked} action={() => show("invitations", invites.next!)} />}
      <PlanningField label="Correo de invitación" value={email} change={setEmail} busy={locked} />
      <RoleOptions roles={roles} value={inviteRole} select={setInviteRole} busy={locked} />
      <AuthAction label="Enviar invitación" disabled={locked} action={() => void write.run(async (permit) => {
        setNotice(""); const items = await api.invite(email, inviteRole, permit); setInvites({ ...invites, items }); setEmail(""); setNotice("Invitación enviada.");
      }, "No pudimos enviar la invitación.")} />
    </>}
    {write.confirm && <><AuthAction label="Confirmar reintento" disabled={write.busy} action={write.confirm} />
      <AuthAction label="Cancelar reintento" disabled={write.busy} action={write.clear} /></>}
  </AuthPanel>;
}
