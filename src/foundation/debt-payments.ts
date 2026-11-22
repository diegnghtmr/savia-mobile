import { amountMinor, isDay, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { debtRecord, debtsPath } from "./debts";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import type { Transactions } from "./transactions";
import { isOfflineFailure } from "./transport";
import { uuid } from "./workspace-context";

export const splitFields = { principalAmount: "Capital (opcional)", interestAmount: "Interés (opcional)", feeAmount: "Comisiones (opcional)" } as const;
const parts = Object.keys(splitFields) as (keyof typeof splitFields)[];
const invalid = () => new InvalidDraft("Revisa los datos del pago.");
function nonnegative(value: unknown, currency: string) {
  if (typeof value !== "string" || value.length > 64 || value.trimStart().startsWith("-")) throw new TypeError();
  return { amountMinor: amountMinor(value.trim(), currency), currency };
}
function paymentBody(input: unknown, currency: unknown, accounts: ReadonlyMap<string, string>) {
  try {
    const row = debtRecord(input), { date } = row, accountId = uuid(row.accountId);
    const allowed = ["accountId", "totalAmount", "date", ...parts];
    if (Object.keys(row).some((key) => !allowed.includes(key)) || !accountId || typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency) ||
      accounts.get(accountId) !== currency || typeof date !== "string" || !isDay(date)) throw new TypeError();
    const totalAmount = nonnegative(row.totalAmount, currency);
    if (totalAmount.amountMinor === "0") throw new TypeError();
    const split = parts.flatMap((part) => Object.hasOwn(row, part) ? [[part, nonnegative(row[part], currency)] as const] : []);
    if (split.length && split.reduce((sum, [, value]) => sum + BigInt(value.amountMinor), 0n) !== BigInt(totalAmount.amountMinor)) throw new TypeError();
    // Resolve the same split as the server, then send one stable representation for its fingerprint.
    const nonzero = split.filter(([, value]) => value.amountMinor !== "0");
    const principalOnly = nonzero.length === 1 && nonzero[0][0] === "principalAmount";
    return { accountId, totalAmount, ...Object.fromEntries(principalOnly ? [] : nonzero), occurredAt: `${date}T00:00:00.000Z` };
  } catch { throw invalid(); }
}

export function createDebtPayments(request: ScopedRequest, workspace: string, accountChoices: Transactions["transferAccounts"]) {
  let accounts = new Map<string, string>();
  const scope = uuid(workspace);
  return {
    async loadAccounts() {
      const choices = await accountChoices();
      accounts = new Map(choices.map(({ id, currency }) => [id, currency]));
      return choices;
    },
    async pay(raw: unknown, currency: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      if (!id || !scope) throw invalid();
      const body = paymentBody(input, currency, accounts), path = `${debtsPath}/${id}/payments`, method = "POST";
      try {
        const result = await request(scope, path, { method, body, successStatus: 201,
          submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]), async (key) => {
            const row = debtRecord(await operation(key)), amount = debtRecord(row.amount), receipt = uuid(row.id);
            if (!receipt || row.type !== "debt_payment" || row.status !== "confirmed" || uuid(row.accountId) !== body.accountId ||
              typeof row.occurredAt !== "string" || Date.parse(row.occurredAt) !== Date.parse(body.occurredAt) ||
              amount.currency !== body.totalAmount.currency || amount.amountMinor !== `-${body.totalAmount.amountMinor}`) throw new TypeError();
            return receipt;
          }, { confirmation, serverDate }),
        });
        const receipt = uuid(result);
        if (!receipt) throw new TypeError();
        return receipt;
      } catch (error) {
        if (isOfflineFailure(error)) throw new InvalidDraft("Necesitas conexión para guardar. Si ya enviaste el pago, revisa la deuda antes de reintentar.");
        throw error;
      }
    },
  };
}
export type DebtPayments = ReturnType<typeof createDebtPayments>;
