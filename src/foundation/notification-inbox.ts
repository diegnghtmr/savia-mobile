import type { ScopedRequest } from "./accounts";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { TransportError } from "./transport";
import { uuid } from "./workspace-context";

const path = "/v1/notifications";
export function notificationRequest(request: ScopedRequest, workspace: string) {
  return async (route: string, unavailable: string, options: NonNullable<Parameters<ScopedRequest>[2]>) => {
    let verified = false;
    try {
      return await request(workspace, route, { ...options, subjectResource: true, onMembership: async () => { verified = true; } });
    } catch (error) {
      if (verified && error instanceof TransportError && error.kind === "http" && (error.status === 404 || error.status === 501)) throw new InvalidDraft(unavailable);
      throw error;
    }
  };
}
function item(input: unknown) {
  const { id: raw, read, title, type, body, createdAt } = fundRecord(input), id = uuid(raw);
  if (!id || typeof read !== "boolean" || typeof title !== "string" || !title.trim() || typeof type !== "string" ||
    (body != null && typeof body !== "string") || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new TypeError();
  return { id, read, title, body, createdAt };
}
export function createInbox(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = notificationRequest(request, scope);
  return {
    async list(input: unknown = {}) {
      const query = new URLSearchParams({ limit: "20" });
      try {
        const filters = fundRecord(input);
        if (!scope || Object.keys(filters).some((key) => !["cursor", "unreadOnly"].includes(key))) throw new TypeError();
        if (Object.hasOwn(filters, "cursor")) {
          if (!isCursor(filters.cursor, undefined, undefined, true)) throw new TypeError();
          query.set("cursor", filters.cursor);
        }
        if (Object.hasOwn(filters, "unreadOnly")) {
          if (typeof filters.unreadOnly !== "boolean") throw new TypeError();
          query.set("unreadOnly", String(filters.unreadOnly));
        }
      } catch { throw new InvalidDraft("Filtros de notificaciones no válidos."); }
      const { items, pageInfo } = fundRecord(await call(`${path}?${query}`, "Notificaciones no disponibles.", { successStatus: 200 }));
      const { hasNextPage, nextCursor } = fundRecord(pageInfo), next = isCursor(nextCursor, undefined, undefined, true) ? nextCursor : null;
      if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !next || next === query.get("cursor") || !items.length : nextCursor != null)) throw new TypeError();
      const rows = items.map(item);
      if (new Set(rows.map(({ id }) => id)).size !== rows.length || (query.get("unreadOnly") === "true" && rows.some(({ read }) => read))) throw new TypeError();
      return { items: rows, nextCursor: next };
    },
    async mark(raw: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      if (!scope || !id) throw new InvalidDraft("Notificación no válida.");
      const route = `${path}/${id}/read`, method = "POST";
      await call(route, "Notificación no disponible.", { method, successStatus: 204,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, route]), (key) => operation(key), { confirmation, serverDate }),
      });
    },
  };
}
export type Inbox = ReturnType<typeof createInbox>;
