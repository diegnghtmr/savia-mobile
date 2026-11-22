import { amountMinor, isDay, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import type { Transactions } from "./transactions";
import { uuid } from "./workspace-context";

export type TransferMode = "transfer" | "exchange";
const common = ["sourceAccountId", "destinationAccountId", "amount", "date", "description"] as const;
const extra = ["received", "executedRate"] as const;
export type TransferDraft = Partial<Record<typeof common[number] | typeof extra[number], string>>;
const rateFields = ["baseCurrency", "quoteCurrency", "from", "to"] as const;
export type RateFilters = Partial<Record<typeof rateFields[number], string>>;
const decimal = /^(\d+)(?:[.,](\d+))?$/;

function object(value: unknown) {
  if (!value || typeof value !== "object") throw new TypeError();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  return value as Record<string, unknown>;
}

function positiveAmount(value: unknown, currency: string) {
  if (typeof value !== "string" || value.length > 64) throw new TypeError();
  const minor = amountMinor(value.trim(), currency);
  if (minor === "0" || minor.startsWith("-")) throw new TypeError();
  return { amountMinor: minor, currency };
}

function positiveRate(value: unknown) {
  const parts = typeof value === "string" ? decimal.exec(value.trim()) : null;
  if (!parts) throw new TypeError();
  const whole = parts[1].replace(/^0+(?=\d)/, ""), fraction = (parts[2] ?? "").replace(/0+$/, "");
  if (whole === "0" && !fraction) throw new TypeError();
  return fraction ? `${whole}.${fraction}` : whole;
}

function transferBody(mode: unknown, input: unknown, currencies: ReadonlyMap<string, string>) {
  try {
    if (mode !== "transfer" && mode !== "exchange") throw new TypeError();
    const draft = object(input), allowed: readonly string[] = mode === "transfer" ? common : [...common, ...extra];
    if (Object.keys(draft).some((field) => !allowed.includes(field))) throw new TypeError();
    const sourceAccountId = uuid(draft.sourceAccountId), destinationAccountId = uuid(draft.destinationAccountId);
    if (!sourceAccountId || !destinationAccountId || sourceAccountId === destinationAccountId) throw new TypeError();
    const from = currencies.get(sourceAccountId), to = currencies.get(destinationAccountId);
    if (!from || !to || (from === to) !== (mode === "transfer")) throw new TypeError();
    if (typeof draft.date !== "string" || !isDay(draft.date)) throw new TypeError();
    const raw = Object.hasOwn(draft, "description") ? draft.description : "";
    if (typeof raw !== "string" || raw.includes("\0") || [...raw.trim()].length > 500) throw new TypeError();
    const base = { sourceAccountId, destinationAccountId, occurredAt: `${draft.date}T00:00:00.000Z`, description: raw.trim() || null };
    const amount = positiveAmount(draft.amount, from);
    return mode === "transfer" ? { path: "/v1/transfers", body: { ...base, amount } }
      : { path: "/v1/currency-exchanges", body: { ...base, sourceAmount: amount, destinationAmount: positiveAmount(draft.received, to), executedRate: positiveRate(draft.executedRate) } };
  } catch { throw new InvalidDraft("Revisa los datos de la transferencia."); }
}

function rateQuery(input: unknown) {
  try {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(object(input))) {
      if (typeof value !== "string") throw new TypeError();
      if (key === "baseCurrency" || key === "quoteCurrency") {
        if (!/^[a-z]{3}$/i.test(value) || !ACTIVE_CURRENCIES.has(value.toUpperCase())) throw new TypeError();
        query.set(key, value.toUpperCase());
      } else if ((key === "from" || key === "to") && isDay(value)) query.set(key, value);
      else throw new TypeError();
    }
    const from = query.get("from"), to = query.get("to");
    if (from && to && from > to) throw new TypeError();
    return query.toString();
  } catch { throw new InvalidDraft("Revisa los filtros."); }
}

function parseRate(input: unknown) {
  const row = object(input);
  const id = uuid(row.id);
  const { baseCurrency, quoteCurrency, rate, effectiveAt, source, isStale, ageHours } = row;
  if (!id || typeof baseCurrency !== "string" || !ACTIVE_CURRENCIES.has(baseCurrency) || typeof quoteCurrency !== "string" || !ACTIVE_CURRENCIES.has(quoteCurrency) ||
    typeof rate !== "string" || !/^\d+(?:\.\d+)?$/.test(rate) || typeof effectiveAt !== "string" || !Number.isFinite(Date.parse(effectiveAt)) || typeof source !== "string" || !source.trim()) throw new TypeError();
  return { id, baseCurrency, quoteCurrency, rate, effectiveAt, source, manual: row.manual === true,
    stale: typeof isStale === "boolean" ? isStale : null, ageHours: typeof ageHours === "number" && Number.isFinite(ageHours) ? ageHours : null };
}

export function createTransfers(request: ScopedRequest, workspaceId: string, accountChoices: Transactions["transferAccounts"]) {
  let currencies = new Map<string, string>();
  return {
    async loadAccounts() {
      const accounts = await accountChoices();
      currencies = new Map(accounts.map(({ id, currency }) => [id, currency]));
      return accounts;
    },
    async submit(mode: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const { path, body } = transferBody(mode, input, currencies);
      const workspace = uuid(workspaceId);
      if (!workspace) throw new TypeError();
      const method = "POST";
      const result = await request(workspace, path, { method, body, successStatus: 201,
        submit: (profile, operation) => pendingSubmission(workspace, profile, JSON.stringify([method, path, body]), async (key) => {
          const result = object(await operation(key)), id = uuid(result.id);
          if (!id || uuid(result.sourceAccountId) !== body.sourceAccountId || uuid(result.destinationAccountId) !== body.destinationAccountId) throw new TypeError();
          return id;
        }, { confirmation }),
      });
      const id = uuid(result);
      if (!id) throw new TypeError();
      return id;
    },
    async rates(input: unknown = {}) {
      const query = rateQuery(input);
      const result = await request(workspaceId, `/v1/exchange-rates${query ? `?${query}` : ""}`, { successStatus: 200 });
      if (!Array.isArray(result)) throw new TypeError();
      const rates = result.map(parseRate);
      if (new Set(rates.map(({ id }) => id)).size !== rates.length) throw new TypeError();
      return rates;
    },
  };
}
export type Transfers = ReturnType<typeof createTransfers>;
