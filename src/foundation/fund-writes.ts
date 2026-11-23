import { amountMinor, isDay, money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { fundRecord, fundsPath, parseFund, parseFundDetail } from "./funds";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { memoryPendingJournal, pendingSubmission } from "./pending-submission";
import type { Transactions } from "./transactions";
import { isOfflineFailure, isStrongETag, TransportError } from "./transport";
import { uuid } from "./workspace-context";

const invalidFund = () => new InvalidDraft("Revisa los datos del fondo.");
const invalidContribution = () => new InvalidDraft("Revisa los datos del aporte.");
const invalidWithdrawal = () => new InvalidDraft("Revisa los datos del retiro.");
const connection = () => new InvalidDraft("Necesitas conexión para guardar. Si la solicitud ya se envió, revisa el fondo antes de reintentar.");
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

function updateBody(input: unknown, currency: string, accounts: ReadonlyMap<string, string>) {
  try {
    const row = fields(input, ["name", "objective", "targetAmount", "targetDate", "linkedAccountId", "responsibleMemberIds"]);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "targetAmount") body[key] = positiveAmount(value, currency);
      else if (key === "name" || key === "objective") {
        const normalized = key === "objective" && value === null ? null : text(value, key === "name" ? 120 : 500);
        if (normalized === "") throw new TypeError();
        body[key] = normalized;
      } else if (key === "targetDate") {
        if (value !== null && (typeof value !== "string" || !isDay(value))) throw new TypeError();
        body[key] = value;
      } else if (key === "linkedAccountId") {
        const id = uuid(value);
        if (value !== null && (!id || !accounts.has(id))) throw new TypeError();
        body[key] = id;
      } else {
        if (!Array.isArray(value)) throw new TypeError();
        const ids = value.map(uuid);
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new TypeError();
        body[key] = ids;
      }
    }
    if (!Object.keys(body).length) throw new TypeError();
    return body;
  } catch { throw invalidFund(); }
}

export function createFundWrites(request: ScopedRequest, workspace: string, accountChoices: Transactions["transferAccounts"], journal = memoryPendingJournal()) {
  let accounts = new Map<string, string>();
  const scope = uuid(workspace);
  async function liveWrite(id: string, suffix: string, method: "PATCH" | "POST", body: object, parse: (raw: unknown) => unknown,
    confirmation?: PendingSubmissionExpired, ifMatch?: string) {
    if (!scope) throw invalidFund();
    const path = `${fundsPath}/${id}${suffix}`;
    try {
      await request(scope, path, { method, body, ifMatch, includeETag: method === "PATCH", successStatus: method === "PATCH" ? 200 : 201,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]),
          async (key) => parse(await operation(key)), { ifMatch, serverDate, confirmation, journal }) });
    } catch (error) {
      if (isOfflineFailure(error)) throw connection();
      throw error;
    }
  }
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
      if (isOfflineFailure(error)) throw connection();
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
    async update(raw: unknown, currency: string, etag: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      if (!id || !isStrongETag(etag) || !ACTIVE_CURRENCIES.has(currency)) throw invalidFund();
      const body = updateBody(input, currency, accounts);
      await liveWrite(id, "", "PATCH", body, (raw) => {
        const result = parseFundDetail(raw, id);
        if (result.currency !== currency || ("name" in body && result.name !== body.name) ||
          ("objective" in body && result.objective !== body.objective) || ("targetDate" in body && (result.targetDate ?? null) !== body.targetDate) ||
          ("targetAmount" in body && result.target !== money(body.targetAmount, currency)) ||
          ("linkedAccountId" in body && result.linkedAccountId !== body.linkedAccountId) ||
          (Array.isArray(body.responsibleMemberIds) && (result.responsible.length !== body.responsibleMemberIds.length ||
            !result.responsible.every((member) => (body.responsibleMemberIds as string[]).includes(member))))) throw new TypeError();
        return result.id;
      }, confirmation, etag);
    },
    async withdraw(raw: unknown, currency: string, input: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      let body;
      try {
        const row = fields(input, ["accountId", "amount", "reason"]), accountId = uuid(row.accountId), reason = text(row.reason, 500);
        if (!scope || !id || !accountId || !reason || !ACTIVE_CURRENCIES.has(currency) || accounts.get(accountId) !== currency) throw new TypeError();
        body = { accountId, amount: positiveAmount(row.amount, currency), reason };
      } catch { throw invalidWithdrawal(); }
      try {
        await liveWrite(id, "/withdrawals", "POST", body, (raw) => {
          const row = fundRecord(raw), amount = fundRecord(row.amount), receipt = uuid(row.id);
          if (!receipt || row.type !== "adjustment" || row.status !== "confirmed" || uuid(row.accountId) !== body.accountId ||
            row.notes !== body.reason || amount.currency !== currency || amount.amountMinor !== body.amount.amountMinor) throw new TypeError();
          return receipt;
        }, confirmation);
      } catch (error) {
        if (error instanceof TransportError && error.status === 409) throw new InvalidDraft("El retiro supera el saldo ahorrado del fondo.");
        if (error instanceof TransportError && error.status === 422) {
          throw new InvalidDraft(error.problemType === "https://savia.app/problems/insufficient-fund-balance" || error.code === "insufficient-fund-balance"
            ? "El fondo no tiene saldo suficiente para este retiro." : "El retiro no es válido. Revisa el importe y la cuenta de destino.");
        }
        throw error;
      }
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
