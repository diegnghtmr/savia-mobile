import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { receiptsPath, type Receipts } from "./receipts";
import { createMovementBody, type Transactions } from "./transactions";
import { isOfflineFailure, TransportError } from "./transport";
import { uuid } from "./workspace-context";

const invalid = () => new InvalidDraft("Revisa los datos del movimiento.");
function matchesMovement(raw: unknown, receipt: string, body: Record<string, unknown>, linked?: string) {
  const row = fundRecord(raw), amount = fundRecord(row.amount), expected = fundRecord(body.amount), id = uuid(row.id);
  if (!id || (linked && linked !== id) || uuid(row.receiptId) !== receipt || uuid(row.accountId) !== body.accountId ||
    row.type !== "expense" || row.status !== "confirmed" || typeof row.occurredAt !== "string" || Date.parse(row.occurredAt) !== Date.parse(body.occurredAt as string) ||
    amount.currency !== expected.currency || amount.amountMinor !== expected.amountMinor || (row.description ?? null) !== body.description) throw new TypeError();
  return id;
}
export function createReceiptConfirmations(request: ScopedRequest, workspace: string, readReceipt: Receipts["detail"], accountChoices: Transactions["transferAccounts"]) {
  const scope = uuid(workspace);
  let accounts = new Map<string, string>();
  return {
    async loadAccounts() {
      const options = await accountChoices();
      accounts = new Map(options.map(({ id, currency }) => [id, currency]));
      return options;
    },
    async confirm(raw: unknown, draft: unknown, confirmed: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      if (!scope || !id || confirmed !== true) throw invalid();
      let transaction;
      try {
        const input = fundRecord(draft);
        if (Object.keys(input).some((key) => !["accountId", "date", "amount", "description"].includes(key))) throw new TypeError();
        transaction = createMovementBody({ ...input, type: "expense", status: "confirmed" }, accounts);
        if (BigInt(fundRecord(transaction.amount).amountMinor as string) <= 0n) throw new TypeError();
      } catch { throw invalid(); }
      const path = `${receiptsPath}/${id}/confirm`, method = "POST", body = { transaction };
      try {
        const result = await request(scope, path, { method, body, successStatus: 201,
          submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]), async (key) => {
            try { return matchesMovement(await operation(key), id, transaction); }
            catch (error) {
              if (!isOfflineFailure(error) && !(error instanceof TransportError && error.status === 409)) throw error;
              // The server can claim the receipt before checking the ledger idempotency key on retry.
              const current = await readReceipt(id).catch(() => null);
              if (current?.status !== "confirmed" || !current.transactionId) throw error;
              const linked = current.transactionId;
              return matchesMovement(await request(scope, `/v1/transactions/${linked}`, { successStatus: 200 }), id, transaction, linked);
            }
          }, { confirmation, serverDate }),
        });
        const resultId = uuid(result); if (!resultId) throw new TypeError();
        return resultId;
      } catch (error) {
        if (isOfflineFailure(error)) throw new InvalidDraft("Necesitas conexión para confirmar el recibo. Revisa su estado antes de reintentar.");
        if (error instanceof TransportError && error.status === 409) throw new InvalidDraft("El recibo cambió. Actualiza su estado antes de reintentar.");
        throw error;
      }
    },
  };
}
export type ReceiptConfirmations = ReturnType<typeof createReceiptConfirmations>;
