import type { ScopedRequest } from "./accounts";
import type { AgentRunResult } from "./agent-events";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { TransportError } from "./transport";
import { uuid } from "./workspace-context";

const conversations = "/v1/agent/conversations", approvals = "/v1/approvals";
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const risks = { low_risk_write: "Escritura de bajo riesgo", financial_write: "Operación financiera", destructive: "Destructiva", administrative: "Administrativa" } as const;
const states = { pending: "Pendiente", approved: "Aprobada", rejected: "Rechazada", expired: "Vencida", consumed: "Ejecutada" } as const;
const member = <T extends object>(values: T, key: unknown): key is keyof T => typeof key === "string" && Object.hasOwn(values, key);

function conversation(input: unknown) {
  const { id: raw, title, createdAt, updatedAt } = fundRecord(input), id = uuid(raw);
  if (!id || typeof title !== "string" || !date(createdAt) || !date(updatedAt)) throw new TypeError();
  return { id, title };
}
function approval(input: unknown, expected?: string, profile?: string) {
  const { id: raw, toolName, riskClass, argumentsHash, preview, status, expiresAt, createdBy } = fundRecord(input), id = uuid(raw), creator = uuid(createdBy);
  if (!id || (expected && id !== expected) || typeof toolName !== "string" || !toolName.trim() || !member(risks, riskClass) || !member(states, status) ||
    !date(expiresAt) || typeof argumentsHash !== "string" || !argumentsHash.trim() || argumentsHash.length > 256 || /[\x00-\x1f\x7f]/.test(argumentsHash)) throw new TypeError();
  return Object.freeze({ id, toolName, risk: risks[riskClass], label: states[status], status, expiresAt, argumentsHash,
    creator, canDecide: creator !== null && creator === profile, preview: JSON.stringify(fundRecord(preview), null, 2) });
}
function draft(raw: unknown, limit: number, message: string, required = true) {
  if (typeof raw !== "string" || raw.includes("\0") || [...raw].length > limit || (required && !raw.trim())) throw new InvalidDraft(message);
  return raw.trim();
}
export type Approval = ReturnType<typeof approval>;
export type Decision = "confirm" | "reject";
export class ApprovalDecisionForbidden extends InvalidDraft {
  constructor() { super("Solo quien creó la propuesta puede decidir."); }
}
export function createAssistant(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "";
  let reviewed: Approval | null = null;
  const cursorValid = (raw: unknown, inbox: boolean): raw is string => isCursor(raw, scope, undefined, true) || (inbox && isCursor(raw, undefined, undefined, true));
  async function list<T extends { id: string }>(path: string, cursor: unknown, parse: (row: unknown) => T, inbox = false) {
    if (!scope || (cursor !== undefined && !cursorValid(cursor, inbox))) throw new InvalidDraft("Página no válida.");
    const query = new URLSearchParams({ limit: "20" });
    if (typeof cursor === "string") query.set("cursor", cursor);
    if (inbox) query.set("status", "pending");
    let verified = false, payload;
    try { payload = await request(scope, `${path}?${query}`, { successStatus: 200, onMembership: async () => { verified = true; } }); }
    catch (error) {
      if (inbox && verified && error instanceof TransportError && error.kind === "http" && (error.status === 404 || error.status === 501)) throw new InvalidDraft("Bandeja de propuestas no disponible.");
      throw error;
    }
    const { items, pageInfo } = fundRecord(payload), { hasNextPage, nextCursor } = fundRecord(pageInfo);
    if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !cursorValid(nextCursor, inbox) || nextCursor === cursor || !items.length : nextCursor != null)) throw new TypeError();
    const rows = items.map(parse);
    if (new Set(rows.map(({ id }) => id)).size !== rows.length) throw new TypeError();
    return { items: rows, nextCursor: hasNextPage ? nextCursor as string : null };
  }
  function write<T>(path: string, body: object, status: number, parse: (result: unknown) => T, confirmation?: PendingSubmissionExpired,
    { events, expires, creator }: { events?: true; expires?: string; creator?: string } = {}) {
    if (!scope) throw new InvalidDraft("No hay un espacio activo disponible.");
    // The journal receives a fingerprint, not a serialized body or a cached response.
    return request(scope, path, { method: "POST", body, successStatus: status, agentEvents: events,
      submit: (profile, operation, serverDate) => {
        if (creator !== undefined && profile !== creator) throw new ApprovalDecisionForbidden();
        if (expires && serverDate !== null && Date.parse(expires) <= serverDate) throw new InvalidDraft("La propuesta ya venció.");
        return pendingSubmission(scope, profile, JSON.stringify(["POST", path, body]), async (key) => parse(await operation(key)), { serverDate, confirmation });
      },
    }) as Promise<T>;
  }
  return {
    conversations: (cursor?: unknown) => list(conversations, cursor, conversation),
    approvals: (cursor?: unknown) => list(approvals, cursor, (row) => {
      const proposal = approval(row); if (proposal.status !== "pending") throw new TypeError(); return proposal;
    }, true),
    create(raw: unknown, confirmation?: PendingSubmissionExpired) {
      const title = draft(raw, 120, "Revisa el título de la conversación.", false);
      return write(conversations, title ? { title } : {}, 201, conversation, confirmation);
    },
    send(raw: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      if (!id) throw new InvalidDraft("Conversación no válida.");
      const message = draft(input, 20000, "Escribe un mensaje de hasta 20 000 caracteres.");
      return write(`${conversations}/${id}/messages`, { message }, 200, (result) => result as AgentRunResult, confirmation, { events: true });
    },
    async detail(raw: unknown) {
      reviewed = null;
      const id = uuid(raw);
      if (!scope || !id) throw new InvalidDraft("Identificador de la propuesta no válido.");
      let profile: string | undefined;
      const data = await request(scope, `${approvals}/${id}`, { successStatus: 200, onMembership: async (context) => {
        if (context.active?.id === scope) profile = context.profileId;
      } });
      return reviewed = approval(data, id, profile);
    },
    async decide(row: Approval, decision: Decision, confirmation?: PendingSubmissionExpired) {
      if (row !== reviewed || row.status !== "pending" || (decision !== "confirm" && decision !== "reject")) throw new InvalidDraft("Revisa la propuesta antes de decidir.");
      if (!row.canDecide || !row.creator) throw new ApprovalDecisionForbidden();
      try {
        return reviewed = await write(`${approvals}/${row.id}/${decision}`, { argumentsHash: row.argumentsHash }, 200, (input) => {
          const next = approval(input, row.id);
          if (next.argumentsHash !== row.argumentsHash || (decision === "reject" ? next.status !== "rejected" : !["approved", "consumed"].includes(next.status))) throw new TypeError();
          return next;
        }, confirmation, { expires: row.expiresAt, creator: row.creator });
      } catch (error) {
        if (error instanceof TransportError && error.kind === "http" && error.status === 403) {
          reviewed = null; throw new ApprovalDecisionForbidden();
        }
        if (error instanceof TransportError && error.status === 412) reviewed = null;
        throw error;
      }
    },
  };
}
export type Assistant = ReturnType<typeof createAssistant>;
