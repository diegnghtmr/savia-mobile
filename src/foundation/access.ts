import { amountMinor, isDay, money, type ScopedRequest } from "./accounts";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { TransportError } from "./transport";
import { uuid, type Workspace } from "./workspace-context";

const grants = "/v1/mcp/grants", cli = "/v1/cli/device/approve", unavailable = "Permisos MCP no disponibles.";
const cursorValid = (cursor: unknown): cursor is string => isCursor(cursor, undefined, undefined, true);
export const mcpScopes = ["accounts:read", "accounts:write", "transactions:read", "transactions:write", "budgets:read", "budgets:write", "reports:read", "reports:write", "workspace:admin"] as const;
// Exact names from the authority's x-savia-mcp-tool annotations.
const tools = ["list_workspaces", "list_accounts", "create_account", "get_account_balance", "search_transactions", "create_transaction", "update_transaction",
  "void_transaction", "create_transfer", "create_cross_currency_transfer", "create_budget", "get_budget_status", "update_budget", "update_budget_allocations",
  "create_sinking_fund", "get_sinking_fund", "update_sinking_fund", "contribute_to_fund", "withdraw_from_fund", "get_debt_projection", "get_financial_summary",
  "create_forecast", "run_scenario", "scan_receipt", "create_report_definition", "run_report", "export_report_pdf", "list_ai_providers", "get_forecast"];
const options = { subjectResource: true } as const;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const timestamp = (s: unknown): s is string => typeof s === "string" && /T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:[0-5]\d)$/.test(s) &&
  isDay(s.slice(0, 10)) && s[10] === "T" && Number.isFinite(Date.parse(s));
const list = (input: string) => input.trim() ? input.trim().split(/\s*,\s*/) : [];
function unique(input: unknown, normalize: (value: unknown) => string | null) {
  if (!Array.isArray(input)) throw new TypeError();
  const values = input.map(normalize);
  if (values.some((value) => value === null) || new Set(values).size !== values.length) throw new TypeError();
  return (values as string[]).sort();
}
const only = (values: readonly string[]) => (s: unknown) => typeof s === "string" && values.includes(s) ? s : null;
function schedule(input: unknown) {
  if (!Array.isArray(input)) throw new TypeError();
  const result = input.map((raw) => {
    const { dayOfWeek, startTime, endTime } = fundRecord(raw);
    if (typeof dayOfWeek !== "number" || !Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7 || typeof startTime !== "string" ||
      typeof endTime !== "string" || !clock.test(startTime) || (!clock.test(endTime) && endTime !== "24:00") || startTime >= endTime) throw new TypeError();
    return { dayOfWeek, startTime, endTime };
  });
  if (new Set(result.map((window) => JSON.stringify(window))).size !== result.length) throw new TypeError();
  return result.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
}
const name = (s: unknown): s is string => typeof s === "string" && !!s.trim() && [...s].length <= 120 && !/[\x00-\x1f\x7f]/.test(s);
export type GrantDraft = { clientName: string; scopes: string[]; workspaceIds: string[]; accounts: string; tools: string; windows: string; limit: string; currency: string; expiry: string };
function command(draft: GrantDraft, scope: string, workspaces: Workspace[]) {
  const clientName = draft.clientName.trim(), scopes = unique(draft.scopes, only(mcpScopes)), workspaceIds = unique(draft.workspaceIds, uuid);
  if (!name(clientName) || !scopes.length || !workspaceIds.includes(scope) || workspaceIds.some((id) => !workspaces.some((workspace) => workspace.id === id))) throw new TypeError();
  const accountIds = unique(list(draft.accounts), uuid), toolAllowlist = unique(list(draft.tools), only(tools));
  const windows = schedule(list(draft.windows).map((text) => {
    const match = /^([1-7])\s+(\d\d:\d\d)-(\d\d:\d\d)$/.exec(text);
    if (!match) throw new TypeError();
    return { dayOfWeek: Number(match[1]), startTime: match[2], endTime: match[3] };
  }));
  const expiresAt = draft.expiry.trim() || null, currency = draft.currency.trim().toUpperCase(), limit = draft.limit.trim();
  if ((expiresAt && !timestamp(expiresAt)) || (!!currency !== !!limit)) throw new TypeError();
  const maxWriteAmount = limit ? { amountMinor: amountMinor(limit, currency), currency } : null;
  if (maxWriteAmount && (maxWriteAmount.amountMinor.startsWith("-") || !money(maxWriteAmount))) throw new TypeError();
  // Never omit restrictions to fall back to a backend that doesn't implement them.
  return { clientName, scopes, workspaceIds, ...(accountIds.length ? { accountIds } : {}), toolAllowlist, schedule: windows, maxWriteAmount, expiresAt };
}
function grant(raw: unknown) {
  const row = fundRecord(raw), id = uuid(row.id), { clientName, status, expiresAt, createdAt } = row;
  if (!id || !name(clientName) || !timestamp(createdAt) || (expiresAt != null && !timestamp(expiresAt)) ||
    (status !== "active" && status !== "expired" && status !== "revoked")) throw new TypeError();
  return { id, clientName, status, expiresAt: expiresAt ?? null, scopes: unique(row.scopes, only(mcpScopes)), workspaceIds: unique(row.workspaceIds ?? [], uuid),
    accountIds: unique(row.accountIds ?? [], uuid), toolAllowlist: unique(row.toolAllowlist, only(tools)), schedule: schedule(row.schedule),
    limit: row.maxWriteAmount == null ? null : money(row.maxWriteAmount) } as const;
}
export type Grant = ReturnType<typeof grant>;
export function createAccess(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope);
  let workspaces: Workspace[] = [];
  const known = new Map<string, Grant>(), seenCursors = new Set<string>();
  return {
    async list(cursor?: string) {
      if (cursor !== undefined && (!cursorValid(cursor) || !seenCursors.has(cursor))) throw new InvalidDraft("Página de permisos no válida.");
      if (!cursor) { known.clear(); seenCursors.clear(); workspaces = []; }
      const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor", cursor);
      const { items, pageInfo } = fundRecord(await call(`${grants}?${query}`, { ...options, successStatus: 200,
        onMembership: async (context) => { workspaces = context.items; } }, unavailable));
      const { hasNextPage, nextCursor } = fundRecord(pageInfo), next = cursorValid(nextCursor) ? nextCursor : null;
      if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !next || seenCursors.has(next) || !items.length : nextCursor != null)) throw new TypeError();
      const visible = items.map(grant).filter((row) => row.workspaceIds.includes(scope));
      if (new Set(visible.map((row) => row.id)).size !== visible.length || visible.some((row) => known.has(row.id))) throw new TypeError();
      for (const row of visible) known.set(row.id, row);
      if (next) seenCursors.add(next);
      return { items: [...known.values()], next, workspaces, scope };
    },
    async create(draft: GrantDraft, confirmation?: PendingSubmissionExpired) {
      let body: ReturnType<typeof command>;
      try { body = command(draft, scope, workspaces); }
      catch { throw new InvalidDraft("Revisa las restricciones del permiso MCP."); }
      const fingerprint = JSON.stringify(["POST", grants, body]);
      return await call(grants, { ...options, method: "POST", body, successStatus: 201, onMembership: async ({ items }) => {
        if (body.workspaceIds.some((id) => !items.some((workspace) => workspace.id === id))) throw new InvalidDraft("Uno de los espacios elegidos ya no está disponible.");
      }, submit: (profile, operation, serverDate) => {
        if (body.expiresAt && serverDate !== null && Date.parse(body.expiresAt) <= serverDate) throw new InvalidDraft("El vencimiento debe ser posterior a la hora del servidor.");
        return pendingSubmission(scope, profile, fingerprint, async (key) => {
          const row = grant(await operation(key));
          const restrictions = [row.scopes, row.workspaceIds, row.accountIds, row.toolAllowlist, row.schedule, row.limit, row.expiresAt ? Date.parse(row.expiresAt) : null];
          const requested = [body.scopes, body.workspaceIds, body.accountIds ?? [], body.toolAllowlist, body.schedule, body.maxWriteAmount ? money(body.maxWriteAmount) : null,
            body.expiresAt ? Date.parse(body.expiresAt) : null];
          if (row.status !== "active" || row.clientName !== body.clientName || JSON.stringify(restrictions) !== JSON.stringify(requested)) throw new TypeError();
          known.set(row.id, row); return [...known.values()];
        }, { serverDate, confirmation });
      } }, unavailable) as Grant[];
    },
    async revoke(row: Grant, confirmation?: PendingSubmissionExpired) {
      if (known.get(row.id) !== row || row.status !== "active") throw new InvalidDraft("Revisa el permiso antes de revocarlo.");
      const path = `${grants}/${row.id}`;
      await call(path, { ...options, method: "DELETE", successStatus: 204,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify(["DELETE", path]), (key) => operation(key), { serverDate, confirmation }),
      }, unavailable, [501]);
      known.delete(row.id); return [...known.values()];
    },
    async approve(input: string) {
      const raw = typeof input === "string" && input.length <= 16 ? input.replace(/[\s-]/g, "") : "";
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/i.test(raw)) throw new InvalidDraft("Código no válido o vencido.");
      try { await call(cli, { ...options, method: "POST", body: { userCode: raw.toUpperCase() }, successStatus: 204 }, "Autorización de dispositivos CLI no disponible."); }
      catch (error) {
        if (error instanceof TransportError && error.kind === "http" && error.status === 400) throw new InvalidDraft("Código no válido o vencido.");
        if (error instanceof TransportError && error.kind === "http" && error.status === 429) throw new InvalidDraft("Demasiados intentos. Espera antes de volver a intentarlo.");
        throw error;
      }
    },
  };
}
export type Access = ReturnType<typeof createAccess>;
