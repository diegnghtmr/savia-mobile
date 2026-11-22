import { amountMinor, isETag, type ScopedRequest } from "./accounts";
import { budgetRecord, budgetsPath, day, member, methods, parseBudget, rollover } from "./budgets";
import { ACTIVE_CURRENCIES } from "./currencies";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { isOfflineFailure } from "./transport";
import { uuid } from "./workspace-context";

const invalid = () => new InvalidDraft("Revisa los datos del presupuesto.");
const invalidAllocations = () => new InvalidDraft("Revisa las asignaciones.");
const fieldsOnly = (row: object, fields: string[]) => Object.keys(row).every((key) => fields.includes(key));
function name(value: unknown) {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError();
  const text = value.trim();
  if (!text || [...text].length > 120) throw new TypeError();
  return text;
}
function createBody(input: unknown) {
  try {
    const row = budgetRecord(input), { method, periodStart, periodEnd, copyFromBudgetId } = row;
    if (!fieldsOnly(row, ["name", "method", "periodStart", "periodEnd", "copyFromBudgetId"]) || !member(methods, method) || !day(periodStart) || !day(periodEnd)) throw new TypeError();
    const days = (Date.parse(periodEnd) - Date.parse(periodStart)) / 86400000;
    const source = uuid(copyFromBudgetId);
    if (days <= 0 || days > 366 || (Object.hasOwn(row, "copyFromBudgetId") && copyFromBudgetId !== null && !source)) throw new TypeError();
    return { name: name(row.name), method, periodStart, periodEnd, ...(source && { copyFromBudgetId: source }) };
  } catch { throw invalid(); }
}
function editBody(input: unknown) {
  try {
    const row = budgetRecord(input), { method } = row, hasMethod = Object.hasOwn(row, "method");
    if (!Object.keys(row).length || !fieldsOnly(row, ["name", "method"]) || (hasMethod && !member(methods, method))) throw new TypeError();
    return { ...(Object.hasOwn(row, "name") && { name: name(row.name) }), ...(hasMethod && { method }) };
  } catch { throw invalid(); }
}
export type AllocationDraft = { categoryId: string; planned: string; rolloverPolicy: keyof typeof rollover; rolloverTargetId?: string };
function allocationBody(input: unknown, currency: unknown) {
  try {
    if (typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency) || !Array.isArray(input) || input.length > 1000) throw new TypeError();
    const seen = new Set<string>();
    const allocations = Array.from(input, (entry: unknown) => {
      const row = budgetRecord(entry), { planned, rolloverPolicy: policy, rolloverTargetId } = row;
      const categoryId = uuid(row.categoryId), target = uuid(rolloverTargetId);
      if (!fieldsOnly(row, ["categoryId", "planned", "rolloverPolicy", "rolloverTargetId"]) || !categoryId || seen.has(categoryId) ||
        typeof planned !== "string" || planned.length > 64 || !member(rollover, policy) || policy === "to_fund" ||
        (policy === "to_category" ? !target : (Object.hasOwn(row, "rolloverTargetId") && rolloverTargetId !== null))) throw new TypeError();
      seen.add(categoryId);
      return { categoryId, planned: { amountMinor: amountMinor(planned.trim(), currency, true), currency }, rolloverPolicy: policy, ...(target && { rolloverTargetId: target }) };
    });
    return { allocations: allocations.sort((a, b) => a.categoryId.localeCompare(b.categoryId)) };
  } catch { throw invalidAllocations(); }
}
function original(raw: unknown, tag: unknown) {
  const id = uuid(raw);
  if (!id || !isETag(tag) || tag === '"0"') throw new InvalidDraft("Presupuesto no válido.");
  return { id, tag };
}

export function createBudgetWrites(request: ScopedRequest, workspace: string) {
  async function write(method: "POST" | "PATCH" | "PUT", path: string, body: object, confirmation?: PendingSubmissionExpired, expected?: string, ifMatch?: string) {
    const scope = uuid(workspace);
    if (!scope) throw invalid();
    try {
      const result = await request(scope, path, { method, body, ifMatch, successStatus: expected ? 200 : 201,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]), async (key) => {
          const { id } = parseBudget(await operation(key));
          if (expected && id !== expected) throw new TypeError();
          return id;
        }, { serverDate, confirmation, ifMatch }),
      });
      const id = uuid(result);
      if (!id) throw new TypeError();
      return id;
    } catch (error) {
      if (isOfflineFailure(error)) throw new InvalidDraft("Necesitas conexión para guardar el presupuesto. Vuelve a intentarlo.");
      throw error;
    }
  }
  return {
    async create(input: unknown, confirmation?: PendingSubmissionExpired) { return write("POST", budgetsPath, createBody(input), confirmation); },
    async update(raw: unknown, etag: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const { id, tag } = original(raw, etag);
      return write("PATCH", `${budgetsPath}/${id}`, editBody(input), confirmation, id, tag);
    },
    async replace(raw: unknown, etag: unknown, currency: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const { id, tag } = original(raw, etag);
      return write("PUT", `${budgetsPath}/${id}/allocations`, allocationBody(input, currency), confirmation, id, tag);
    },
  };
}
export type BudgetWrites = ReturnType<typeof createBudgetWrites>;
