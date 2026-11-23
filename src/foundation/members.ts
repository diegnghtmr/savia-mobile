import type { ScopedRequest } from "./accounts";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { InvalidDraft, validEmail } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { memoryPendingJournal, pendingSubmission } from "./pending-submission";
import { TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const memberRoles = { owner: "Propietario", administrator: "Administrador", editor: "Editor", viewer: "Lector" } as const;
export type MemberRole = keyof typeof memberRoles;
const role = (v: unknown): v is MemberRole => typeof v === "string" && Object.hasOwn(memberRoles, v);
const roles = Object.keys(memberRoles) as MemberRole[];
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const withoutHeader = { subjectResource: true } as const;
const rosterUnavailable = "Miembros del espacio no disponibles.", invitesUnavailable = "Invitaciones no disponibles.";
const noManage = "No tienes permiso para gestionar este espacio.";
function memberRefusal(error: unknown): never {
  if (error instanceof TransportError && error.kind === "http" && error.status === 409 && error.problemType === "https://savia.app/problems/last-owner-required") {
    throw new InvalidDraft("El espacio debe conservar al menos un propietario activo.");
  }
  throw error;
}
function parseMember(raw: unknown) {
  const { id: value, userId, displayName, email, role: level, status, joinedAt } = fundRecord(raw), id = uuid(value);
  if (!id || !uuid(userId) || typeof displayName !== "string" || !role(level) || (status !== "active" && status !== "suspended") || !date(joinedAt)) throw new TypeError();
  return { id, displayName, email: typeof email === "string" && validEmail(email) ? email : null, role: level, status } as const;
}
function parseInvitation(raw: unknown) {
  const { id: value, email, role: level, status, expiresAt, createdAt } = fundRecord(raw), id = uuid(value);
  if (!id || typeof email !== "string" || !validEmail(email) || !role(level) || !date(expiresAt) || !date(createdAt) ||
    (status !== "pending" && status !== "accepted" && status !== "expired" && status !== "revoked")) throw new TypeError();
  return { id, email, role: level, status, expiresAt } as const;
}
export type WorkspaceMember = ReturnType<typeof parseMember>;
export type WorkspaceInvitation = ReturnType<typeof parseInvitation>;

export function createMembers(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", root = `/v1/workspaces/${scope}`, roster = `${root}/members`, invites = `${root}/invitations`;
  const call = onlineCapability(request, scope), journal = memoryPendingJournal();
  let allowed: MemberRole[] = [];
  const http = (error: unknown, ...status: number[]) => error instanceof TransportError && error.kind === "http" && status.includes(error.status ?? 0);
  function collection<T extends { id: string }>(path: string, unavailable: string, parse: (input: unknown) => T, valid: (value: unknown) => value is string) {
    const rows = new Map<string, T>(), seen = new Set<string>();
    return { rows, async load(cursor?: string) {
      if (cursor !== undefined && (!valid(cursor) || !seen.has(cursor))) throw new InvalidDraft("Página no válida.");
      if (!cursor) { rows.clear(); seen.clear(); }
      const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor", cursor);
      const raw = await call(`${path}?${query}`, { ...withoutHeader, successStatus: 200 }, unavailable);
      const { items, pageInfo } = fundRecord(raw), { hasNextPage, nextCursor } = fundRecord(pageInfo), next = valid(nextCursor) ? nextCursor : null;
      if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !next || seen.has(next) || !items.length : nextCursor != null)) throw new TypeError();
      const page = items.map(parse);
      if (new Set(page.map(({ id }) => id)).size !== page.length || page.some(({ id }) => rows.has(id))) throw new TypeError();
      for (const item of page) rows.set(item.id, item);
      if (next) seen.add(next);
      return { items: [...rows.values()], next };
    } };
  }
  const members = collection(roster, rosterUnavailable, parseMember, (value): value is string => isCursor(value, scope, undefined, true));
  const invitations = collection(invites, invitesUnavailable, parseInvitation, (value): value is string => isCursor(value, undefined, undefined, true));
  const editable = (row: WorkspaceMember) => members.rows.get(row.id) === row && allowed.includes(row.role);
  async function access() {
    allowed = [];
    const { id, role: level, kind } = fundRecord(await call(root, { ...withoutHeader, successStatus: 200 }, rosterUnavailable));
    if (uuid(id) !== scope || !role(level) || (kind !== "family" && kind !== "shared" && kind !== "personal")) throw new TypeError();
    if (kind !== "personal" && (level === "owner" || level === "administrator")) allowed = roles.filter((value) => level === "owner" || value !== "owner");
    return allowed;
  }
  async function write<T>(path: string, method: "POST" | "DELETE", status: number, body: object | undefined, parse: (input: unknown) => T,
    confirmation?: PendingSubmissionExpired) {
    return await call(path, { ...withoutHeader, method, successStatus: status, body,
      submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]),
        async (key) => parse(await operation(key)), { serverDate, confirmation, journal }),
    }, path.startsWith(invites) ? invitesUnavailable : rosterUnavailable, path === invites ? undefined : [501]) as T;
  }
  return {
    access, members: members.load,
    async invitations(cursor?: string) {
      if (!allowed.length) throw new InvalidDraft(noManage);
      try { return await invitations.load(cursor); }
      catch (error) { if (http(error, 403)) throw new InvalidDraft(noManage); throw error; }
    },
    async change(row: WorkspaceMember, level: unknown) {
      if (!editable(row) || !role(level) || !allowed.includes(level) || level === row.role) throw new InvalidDraft("Elige un rol distinto y disponible para este miembro.");
      // The roster has no row-version field. PATCH does not advertise an idempotency key.
      const result = parseMember(await call(`${roster}/${row.id}`, { ...withoutHeader, method: "PATCH", body: { role: level }, successStatus: 200 }, rosterUnavailable, [501]).catch(memberRefusal));
      if (result.id !== row.id || result.role !== level) throw new TypeError();
    },
    async remove(row: WorkspaceMember, confirmation?: PendingSubmissionExpired) {
      if (!editable(row)) throw new InvalidDraft(noManage);
      await write(`${roster}/${row.id}`, "DELETE", 204, undefined, () => {}, confirmation).catch(memberRefusal);
    },
    async invite(raw: string, level: MemberRole, confirmation?: PendingSubmissionExpired) {
      const email = raw.trim().toLowerCase();
      if (!validEmail(email) || !allowed.includes(level)) throw new InvalidDraft("Revisa el correo y el rol de la invitación.");
      return write(invites, "POST", 201, { email, role: level }, (input) => {
        const item = parseInvitation(input);
        if (item.email.toLowerCase() !== email || item.role !== level || item.status !== "pending") throw new TypeError();
        invitations.rows.set(item.id, item);
        return [...invitations.rows.values()];
      }, confirmation);
    },
    async revoke(row: WorkspaceInvitation, confirmation?: PendingSubmissionExpired) {
      if (!allowed.length || invitations.rows.get(row.id) !== row || row.status !== "pending") throw new InvalidDraft("Revisa la invitación antes de revocarla.");
      return write(`${invites}/${row.id}/revoke`, "POST", 200, undefined, (input) => {
        const item = parseInvitation(input);
        if (item.id !== row.id || item.status !== "revoked") throw new TypeError();
        invitations.rows.set(item.id, item);
        return [...invitations.rows.values()];
      }, confirmation);
    },
  };
}
export type Members = ReturnType<typeof createMembers>;
