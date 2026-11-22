import { amountMinor, isDay, money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { fundRecord, fundsPath, parseFund } from "./funds";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import type { Transactions } from "./transactions";
import { isOfflineFailure } from "./transport";
import { uuid } from "./workspace-context";

const invalidFund = () => new InvalidDraft("Revisa los datos del fondo.");
const invalidContribution = () => new InvalidDraft("Revisa los datos del aporte.");
function fields(input: unknown, allowed: string[]) {
  const row = fundRecord(input);
  if (Object.keys(row).some((key) => !allowed.includes(key))) throw new TypeError();
  return row;
}
function text(raw: unknown, limit: number) {
  if (typeof raw !== "string" || raw.includes("\0")) throw new TypeError();
  const value = raw.trim();
  if ([...value].length > limit) throw new TypeError();
  return value;
}
function positiveAmount(raw: unknown, currency: string) {
  const minor = amountMinor(text(raw, 64), currency);
  if (minor === "0" || minor.startsWith("-")) throw new TypeError();
  return { amountMinor: minor, currency };
}

function createBody(input: unknown) {
  try {
    const row = fields(input, ["name", "currency", "targetAmount", "targetDate", "linkedAccountId"]);
    const name = text(row.name, 120), currency = text(row.currency, 3).toUpperCase();
    const { targetDate, linkedAccountId: link } = row, linkedAccountId = uuid(link);
    if (!name || !ACTIVE_CURRENCIES.has(currency) || (link != null && !linkedAccountId) ||
      (targetDate != null && (typeof targetDate !== "string" || !isDay(targetDate)))) throw new TypeError();
    return { name, currency, targetAmount: positiveAmount(row.targetAmount, currency), ...(targetDate && { targetDate }), ...(linkedAccountId && { linkedAccountId }) };
  } catch { throw invalidFund(); }
}

function contributionBody(input: unknown, currency: unknown, accounts: ReadonlyMap<string, string>) {
  try {
    const { accountId: raw, amount, date, notes } = fields(input, ["accountId", "amount", "date", "notes"]);
    const accountId = uuid(raw);
    if (!accountId || typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency) || accounts.get(accountId) !== currency ||
      typeof date !== "string" || !isDay(date)) throw new TypeError();
    return { accountId, amount: positiveAmount(amount, currency), occurredAt: `${date}T00:00:00.000Z`, notes: notes == null ? null : text(notes, 500) || null };
  } catch { throw invalidContribution(); }
}

export function createFundWrites(request: ScopedRequest, workspace: string, accountChoices: Transactions["transferAccounts"]) {
  let accounts = new Map<string, string>();
  const scope = uuid(workspace);
  async function write(path: string, body: object, receipt: (raw: unknown) => string, confirmation?: PendingSubmissionExpired) {
    if (!scope) throw invalidFund();
    const method = "POST";
    try {
      const result = await request(scope, path, { method, body, successStatus: 201,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]),
          async (key) => receipt(await operation(key)), { serverDate, confirmation }),
      });
      const id = uuid(result);
      if (!id) throw new TypeError();
      return id;
    } catch (error) {
      if (isOfflineFailure(error)) throw new InvalidDraft("Necesitas conexión para guardar. Si la solicitud ya se envió, revisa el fondo antes de reintentar.");
      throw error;
    }
  }
  return {
    async loadAccounts() {
      const choices = await accountChoices();
      accounts = new Map(choices.map(({ id, currency }) => [id, currency]));
      return choices;
    },
    async create(input: unknown, confirmation?: PendingSubmissionExpired) {
      const body = createBody(input);
      return write(fundsPath, body, (raw) => {
        const fund = parseFund(raw);
        if (fund.name !== body.name || fund.currency !== body.currency || fund.target !== money(body.targetAmount) ||
          (fund.targetDate ?? null) !== (body.targetDate ?? null) || fund.linkedAccountId !== (body.linkedAccountId ?? null)) throw new TypeError();
        return fund.id;
      }, confirmation);
    },
    async contribute(rawId: unknown, currency: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(rawId);
      if (!id || !scope) throw invalidContribution();
      const body = contributionBody(input, currency, accounts);
      return write(`${fundsPath}/${id}/contributions`, body, (raw) => {
        const row = fundRecord(raw), receiptId = uuid(row.id), amount = fundRecord(row.amount);
        if (!receiptId || row.type !== "fund_contribution" || row.status !== "confirmed" || uuid(row.accountId) !== body.accountId ||
          typeof row.occurredAt !== "string" || Date.parse(row.occurredAt) !== Date.parse(body.occurredAt) ||
          amount.currency !== body.amount.currency || amount.amountMinor !== `-${body.amount.amountMinor}`) throw new TypeError();
        return receiptId;
      }, confirmation);
    },
  };
}
export type FundWrites = ReturnType<typeof createFundWrites>;
