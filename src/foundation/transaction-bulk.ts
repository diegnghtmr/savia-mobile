import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft, workspaceUnavailable } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { memoryPendingJournal, pendingSubmission } from "./pending-submission";
import { TransportError } from "./transport";
import type { Transactions } from "./transactions";
import { uuid } from "./workspace-context";

const path = "/v1/transactions/bulk", method = "POST";
const unavailable = "Esta función no está disponible en este servidor.";
export const maxBulkTargets = 100;
export const bulkSingles = { confirm: "Confirmar movimientos", archive: "Archivar", unarchive: "Desarchivar",
  excludeFromReports: "Excluir de informes", includeInReports: "Incluir en informes" } as const;
export const bulkVersion = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
export type BulkAction = { type: keyof typeof bulkSingles } | { type: "convertImported"; targetType: "income" | "expense" } |
  { type: "categorize"; categoryId: string | null } | { type: "setPayee"; payeeId: string | null } |
  { type: "tag"; tagIds: string[] } | { type: "setExtraordinary"; extraordinary: boolean };
export type BulkTarget = { id: string; expectedVersion: number };
export const bulkConflict = (error: unknown) => error instanceof TransportError && error.kind === "http" && (error.status === 409 || error.status === 412);

function draft(targets: readonly BulkTarget[], action: BulkAction) {
  try {
    if (!Array.isArray(targets) || !targets.length || targets.length > maxBulkTargets) throw new TypeError();
    const checked = targets.map((raw) => {
      const row = fundRecord(raw), id = uuid(row.id), expectedVersion = bulkVersion(row.expectedVersion);
      if (!id || expectedVersion === null || Object.keys(row).length !== 2) throw new TypeError();
      return { id, expectedVersion };
    });
    if (new Set(checked.map(({ id }) => id)).size !== checked.length) throw new TypeError();
    const row = fundRecord(action), { type } = row, keys = Object.keys(row).length;
    if (typeof type !== "string") throw new TypeError();
    let command: BulkAction;
    if (keys === 1 && Object.hasOwn(bulkSingles, type)) command = { type: type as keyof typeof bulkSingles };
    else if (keys !== 2) throw new TypeError();
    else if (type === "convertImported" && (row.targetType === "income" || row.targetType === "expense")) command = { type, targetType: row.targetType };
    else if (type === "setExtraordinary" && typeof row.extraordinary === "boolean") command = { type, extraordinary: row.extraordinary };
    else if (type === "categorize" && (row.categoryId === null || uuid(row.categoryId))) command = { type, categoryId: uuid(row.categoryId) };
    else if (type === "setPayee" && (row.payeeId === null || uuid(row.payeeId))) command = { type, payeeId: uuid(row.payeeId) };
    else if (type === "tag" && Array.isArray(row.tagIds)) {
      const tagIds = row.tagIds.map(uuid);
      if (!tagIds.length || tagIds.some((id) => !id) || new Set(tagIds).size !== tagIds.length) throw new TypeError();
      command = { type, tagIds: (tagIds as string[]).sort() };
    } else throw new TypeError();
    return { targets: checked, action: command };
  } catch { throw new InvalidDraft("Revisa la selección y la acción del lote."); }
}

export function createBulkTransactions(request: ScopedRequest, workspace: string, options: Transactions["formOptions"]) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope), journal = memoryPendingJournal();
  return { options: () => options(false), async apply(targets: readonly BulkTarget[], action: BulkAction, confirmation?: PendingSubmissionExpired) {
    const body = draft(targets, action);
    try {
      const result = await call(path, { method, body, onlineOnly: true, successStatus: 200,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]), async (key) => {
          const result = await operation(key).catch((error: unknown) => { if (bulkConflict(error)) return error; throw error; });
          if (result instanceof TransportError) return result;
          const { updated } = fundRecord(result);
          if (!Array.isArray(updated) || updated.length !== body.targets.length) throw new TypeError();
          for (const [index, raw] of updated.entries()) {
            const row = fundRecord(raw), target = body.targets[index], version = bulkVersion(row.version);
            if (uuid(row.id) !== target.id || version === null || version < target.expectedVersion) throw new TypeError();
          }
          return updated.length;
        }, { serverDate, journal, confirmation }) }, unavailable);
      if (result instanceof TransportError) throw result;
      return result as number;
    } catch (error) {
      if (error instanceof Error && error.message === workspaceUnavailable) throw new InvalidDraft(workspaceUnavailable);
      if (error instanceof TransportError && error.kind === "http") {
        if (error.status === 403) throw new InvalidDraft("No tienes permiso para aplicar acciones en lote.");
        if (error.status === 422) throw new InvalidDraft("El lote contiene movimientos no aptos para esta acción. No se aplicaron cambios.");
      }
      throw error;
    }
  } };
}
export type BulkTransactions = ReturnType<typeof createBulkTransactions>;
