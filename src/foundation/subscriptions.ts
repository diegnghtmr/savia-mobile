import { money, type ScopedRequest } from "./accounts";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { memoryPendingJournal, pendingSubmission } from "./pending-submission";
import { isStrongETag } from "./transport";
import { uuid } from "./workspace-context";

const subscriptionsPath = "/v1/subscriptions", unavailable = "Suscripciones detectadas no disponibles.";
export const recurringFrequencies = { daily: "Diaria", weekly: "Semanal", biweekly: "Quincenal", monthly: "Mensual", yearly: "Anual", custom: "Personalizada" } as const;
function parseSubscription(input: unknown) {
  const { id: raw, payeeName, currentAmount, frequency, nextExpectedAt, status, etag, recurringRuleId } = fundRecord(input), id = uuid(raw);
  const instant = typeof nextExpectedAt === "string" ? Date.parse(nextExpectedAt) : NaN;
  if (!id || typeof payeeName !== "string" || !payeeName.trim() || typeof frequency !== "string" || !frequency.trim() ||
    (nextExpectedAt != null && !Number.isFinite(instant))) throw new TypeError();
  return { id, name: payeeName, amount: money(currentAmount), frequency: Object.hasOwn(recurringFrequencies, frequency)
    ? recurringFrequencies[frequency as keyof typeof recurringFrequencies] : frequency,
    nextDate: nextExpectedAt == null ? null : new Date(instant).toISOString().slice(0, 10), status,
    etag: isStrongETag(etag) ? etag : null, rule: uuid(recurringRuleId) };
}
export type SubscriptionCandidate = ReturnType<typeof parseSubscription>;

export function createSubscriptions(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope), journal = memoryPendingJournal();
  const rows = new Map<string, SubscriptionCandidate>(), seen = new Set<string>();
  let next: string | null = null, canDecide = false;
  const valid = (value: unknown): value is string => isCursor(value, scope, "detected");
  const snapshot = () => ({ items: [...rows.values()], next, canDecide });
  return {
    async list(cursor?: string) {
      if (cursor !== undefined && (!valid(cursor) || cursor !== next)) throw new InvalidDraft("Página de suscripciones no válida.");
      if (!cursor) {
        rows.clear(); seen.clear(); next = null; canDecide = false;
        const { id, role } = fundRecord(await call(`/v1/workspaces/${scope}`, { subjectResource: true, onlineOnly: true, successStatus: 200 }, unavailable));
        if (uuid(id) !== scope) throw new TypeError();
        canDecide = role === "owner" || role === "administrator" || role === "editor";
      }
      const query = new URLSearchParams({ limit: "20", status: "detected" }); if (cursor) query.set("cursor", cursor);
      const { items, pageInfo } = fundRecord(await call(`${subscriptionsPath}?${query}`, { onlineOnly: true, successStatus: 200 }, unavailable));
      const { hasNextPage, nextCursor } = fundRecord(pageInfo);
      if (!Array.isArray(items) || items.length > 20 || typeof hasNextPage !== "boolean" ||
        (hasNextPage ? !valid(nextCursor) || seen.has(nextCursor) || !items.length : nextCursor !== null)) throw new TypeError();
      const page = items.map(parseSubscription);
      if (new Set(page.map(({ id }) => id)).size !== page.length || page.some((row) => row.status !== "detected" || rows.has(row.id))) throw new TypeError();
      for (const row of page) rows.set(row.id, row);
      next = hasNextPage && valid(nextCursor) ? nextCursor : null;
      if (next) seen.add(next);
      return snapshot();
    },
    async decide(action: "confirm" | "discard", row: SubscriptionCandidate, confirmation?: PendingSubmissionExpired) {
      if (!canDecide || !row || rows.get(row.id) !== row || !isStrongETag(row.etag) || (action !== "confirm" && action !== "discard")) {
        throw new InvalidDraft("Revisa la suscripción antes de decidir.");
      }
      const path = `${subscriptionsPath}/${row.id}/${action}`, ifMatch = row.etag, method = "POST";
      await call(path, { method, ifMatch, includeETag: true, successStatus: 200,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path]), async (key) => {
          const { body, etag } = fundRecord(await operation(key)), result = parseSubscription(body);
          if (result.id !== row.id || !isStrongETag(etag) || etag !== result.etag || etag === ifMatch ||
            result.status !== (action === "confirm" ? "confirmed" : "ignored") || (action === "confirm" ? !result.rule : result.rule !== null)) throw new TypeError();
          return result.id;
        }, { serverDate, ifMatch, confirmation, journal }) }, unavailable, [501]);
      rows.delete(row.id);
      return snapshot();
    },
  };
}
export type Subscriptions = ReturnType<typeof createSubscriptions>;
