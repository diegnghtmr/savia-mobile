import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { importPath, type ImportJob } from "./imports";
import { jobReceipt } from "./job-receipt";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import type { Transactions } from "./transactions";
import { isOfflineFailure, TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const columnNames = { date: "Fecha", amount: "Importe", description: "Descripción", debitCreditIndicator: "Indicador débito/crédito" } as const;
export type Target = keyof typeof columnNames;
export const debitSigns = { negative: "Débitos negativos", positive: "Débitos positivos", separate_column: "Columna de débito/crédito" } as const;
export const dateFormats = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"] as const;
const required = ["date", "amount", "description"] as const;
const invalid = () => new InvalidDraft("Revisa los datos de la importación.");
function commitBody(raw: unknown, columns: readonly string[], accounts: Set<string>) {
  try {
    const data = fundRecord(raw), { columnMapping, debitSign = "negative", dateFormat = "YYYY-MM-DD", skipDuplicateCandidates = true } = data;
    const accountId = uuid(data.accountId);
    if (!accountId || !accounts.has(accountId) || typeof debitSign !== "string" || !Object.hasOwn(debitSigns, debitSign) ||
      !dateFormats.some((item) => item === dateFormat) || typeof skipDuplicateCandidates !== "boolean" || Object.keys(data)
        .some((key) => !["accountId", "columnMapping", "dateFormat", "debitSign", "skipDuplicateCandidates"].includes(key))) throw new TypeError();
    const map = fundRecord(columnMapping), sources = Object.keys(map).sort(), targets = new Set<unknown>();
    for (const source of sources) {
      const target = map[source];
      if (!source.trim() || ["__proto__", "constructor", "prototype"].includes(source) || columns.indexOf(source) < 0 ||
        columns.indexOf(source) !== columns.lastIndexOf(source) || typeof target !== "string" || !Object.hasOwn(columnNames, target) || targets.has(target)) throw new TypeError();
      targets.add(target);
    }
    if (!required.every((field) => targets.has(field)) || (debitSign === "separate_column") !== targets.has("debitCreditIndicator")) throw new TypeError();
    return { accountId, columnMapping: Object.fromEntries(sources.map((source) => [source, map[source]])), dateFormat, debitSign, skipDuplicateCandidates };
  } catch { throw invalid(); }
}
export function createImportCommits(request: ScopedRequest, workspace: string, accountOptions: Transactions["transferAccounts"]) {
  const scope = uuid(workspace);
  let accounts = new Set<string>();
  return {
    async loadAccounts() {
      const options = await accountOptions();
      accounts = new Set(options.map(({ id }) => id)); return options;
    },
    review(job: ImportJob, raw: unknown) { return commitBody(raw, job.sourceColumns, accounts); },
    async commit(job: ImportJob, raw: unknown, confirmed: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(job?.id);
      if (!scope || !id || confirmed !== true || !["awaiting_mapping", "awaiting_confirmation"].includes(job.status)) throw invalid();
      const body = commitBody(raw, job.sourceColumns, accounts), method = "POST", path = `${importPath}/${id}/commit`;
      try {
        const result = await request(scope, path, { method, body, successStatus: 202,
          submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]), async (key) => {
            const receipt = jobReceipt(await operation(key), "import_commit");
            if (receipt.status !== "completed" || receipt.result !== id) throw new TypeError();
            return receipt.id;
          }, { confirmation, serverDate }),
        });
        const receipt = uuid(result); if (!receipt) throw new TypeError();
        return receipt;
      } catch (error) {
        if (isOfflineFailure(error)) throw new InvalidDraft("Necesitas conexión para confirmar. Si ya enviaste la importación, consulta su estado antes de reintentar.");
        if (error instanceof TransportError && error.status === 409) throw new InvalidDraft("El estado de la importación cambió. Actualízalo antes de reintentar.");
        if (error instanceof TransportError && error.status === 422) throw invalid();
        throw error;
      }
    },
  };
}
export type ImportCommits = ReturnType<typeof createImportCommits>;
