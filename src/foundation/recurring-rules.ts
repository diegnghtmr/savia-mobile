import type { ScopedRequest } from "./accounts";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import { recurringFrequencies } from "./subscriptions";
import { uuid } from "./workspace-context";

const behaviorLabels = { remind: "Recordatorio", create_draft: "Crear borrador", create_pending: "Crear pendiente", confirm_automatically: "Confirmación automática" } as const;
function parseRule(input: unknown) {
  const { id: raw, name, frequency, behavior, active, nextOccurrenceAt } = fundRecord(input), id = uuid(raw);
  const next = typeof nextOccurrenceAt === "string" ? Date.parse(nextOccurrenceAt) : NaN;
  if (!id || typeof name !== "string" || !name.trim() || typeof active !== "boolean" || !Number.isFinite(next) ||
    typeof frequency !== "string" || !Object.hasOwn(recurringFrequencies, frequency) || typeof behavior !== "string" || !Object.hasOwn(behaviorLabels, behavior)) throw new TypeError();
  return { id, name, active, frequency: recurringFrequencies[frequency as keyof typeof recurringFrequencies],
    behavior: behaviorLabels[behavior as keyof typeof behaviorLabels], next: new Date(next).toISOString().slice(0, 10) };
}

export function createRecurringRules(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope);
  const rows = new Map<string, ReturnType<typeof parseRule>>(), seen = new Set<string>();
  let next: string | null = null;
  const valid = (value: unknown): value is string => isCursor(value, scope, undefined, true);
  return { async list(cursor?: string) {
    if (cursor !== undefined && (!valid(cursor) || cursor !== next)) throw new InvalidDraft("Página de reglas recurrentes no válida.");
    if (!cursor) { rows.clear(); seen.clear(); next = null; }
    const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor", cursor);
    const { items, pageInfo } = fundRecord(await call(`/v1/recurring-rules?${query}`, { onlineOnly: true, successStatus: 200 }, "Reglas recurrentes no disponibles."));
    const { hasNextPage, nextCursor } = fundRecord(pageInfo);
    if (!Array.isArray(items) || items.length > 20 || typeof hasNextPage !== "boolean" ||
      (hasNextPage ? !valid(nextCursor) || seen.has(nextCursor) || !items.length : nextCursor !== null)) throw new TypeError();
    const page = items.map(parseRule);
    if (new Set(page.map(({ id }) => id)).size !== page.length || page.some(({ id }) => rows.has(id))) throw new TypeError();
    for (const item of page) rows.set(item.id, item);
    next = hasNextPage && valid(nextCursor) ? nextCursor : null;
    if (next) seen.add(next);
    return { items: [...rows.values()], next };
  } };
}
export type RecurringRules = ReturnType<typeof createRecurringRules>;
