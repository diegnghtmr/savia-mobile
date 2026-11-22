import { randomUUID } from "expo-crypto";
import { ACTIVE_CURRENCIES } from "./currencies";
import { InvalidDraft } from "./identity-draft";
import { TransportError, type createTransport } from "./transport";
import { uuid } from "./workspace-context";

export const types = { cash: "Efectivo", savings: "Ahorros", checking: "Cuenta corriente", digital_wallet: "Billetera digital", credit_card: "Tarjeta de crédito", loan: "Préstamo", investment_manual: "Inversión manual", receivable: "Cuenta por cobrar", generic: "Genérica" } as const;
export const statuses = { active: "Activa", archived: "Archivada", closed: "Cerrada" } as const;
const textFields = [["institution", 120], ["maskedNumber", 32], ["description", 500]] as const;
const opening = ["openingBalance", "openingBalanceDate"] as const;
const accountsPath = "/v1/accounts";
export type ScopedRequest = ReturnType<typeof createTransport>["requestInWorkspace"];

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") throw new TypeError();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  return value as Record<string, unknown>;
};
const member = <T extends object>(values: T, key: unknown): key is keyof T => typeof key === "string" && Object.hasOwn(values, key);
const isCursor = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,256}$/.test(value);
const isDay = (value: string) => /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toJSON()?.slice(0, 10) === value;
const zero = new Set("BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF".split(" "));
const three = new Set("BHD IQD JOD KWD LYD OMR TND".split(" "));
// ISO 4217 minor units; TRD §22.1 uses two digits for COP.
const scale = (currency: string) => zero.has(currency) ? 0 : three.has(currency) ? 3 : 2;

function amountMinor(value: string, currency: string) {
  const match = /^(-?)(\d+)(?:[.,](\d+))?$/.exec(value);
  const digits = scale(currency);
  if (!match || (match[3]?.length ?? 0) > digits) throw new TypeError();
  const minor = (match[2] + (match[3] ?? "").padEnd(digits, "0")).replace(/^0+(?=\d)/, "");
  if (minor.length > 19 || (minor.length === 19 && minor > "9223372036854775807")) throw new TypeError();
  return `${minor === "0" ? "" : match[1]}${minor}`;
}

function money(input: unknown, expected?: string) {
  const { amountMinor: minor, currency } = record(input);
  if (typeof minor !== "string" || !/^-?\d+$/.test(minor) || typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency) || (expected && currency !== expected)) throw new TypeError();
  const count = scale(currency);
  const digits = minor.replace(/^-?0*(?=\d)/, "").padStart(count + 1, "0");
  const whole = count ? `${digits.slice(0, -count)},${digits.slice(-count)}` : digits;
  return `${minor.startsWith("-") && /[1-9]/.test(digits) ? "−" : ""}${whole} ${currency}`;
}

function text(value: unknown, max: number, trim = true) {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError();
  const normalized = trim ? value.trim() : value;
  if ([...normalized].length > max) throw new TypeError();
  return normalized;
}

function createBody(input: unknown) {
  try {
    const data = record(input);
    if (Object.keys(data).some((key) => !["name", "type", "currency", "includeInNetWorth", ...opening, ...textFields.map(([field]) => field)].includes(key))) throw new TypeError();
    const name = text(data.name, 120);
    const currency = text(data.currency, 3).toUpperCase();
    const { type, includeInNetWorth } = data;
    if (!name || !member(types, type) || !ACTIVE_CURRENCIES.has(currency) || (Object.hasOwn(data, "includeInNetWorth") && typeof includeInNetWorth !== "boolean")) throw new TypeError();
    const optional = (key: string, length: number) => Object.hasOwn(data, key) ? text(data[key], length) : "";
    const amount = optional("openingBalance", 64);
    const date = optional("openingBalanceDate", 10);
    if (date && (!amount || !isDay(date))) throw new TypeError();
    return { name, type, currency, ...Object.fromEntries(textFields.flatMap(([key, length]) => {
      const value = optional(key, length);
      return value ? [[key, value]] : [];
    })), ...(includeInNetWorth === false ? { includeInNetWorth } : {}),
    ...(amount ? { openingBalance: { amountMinor: amountMinor(amount, currency), currency } } : {}), ...(date ? { openingBalanceDate: date } : {}) };
  } catch { throw new InvalidDraft("Revisa los datos de la cuenta."); }
}

const invalidAccount = () => new InvalidDraft("Revisa los datos de la cuenta.");
const isETag = (value: unknown): value is string => typeof value === "string" && value.endsWith('"') && /^"(?:0|[1-9]\d{0,9})"$/.test(value) && Number(value.slice(1, -1)) <= 2_147_483_647;

function updateBody(input: unknown) {
  try {
    const entries = Object.entries(record(input));
    if (!entries.length) throw new TypeError();
    return Object.fromEntries(entries.map(([key, value]) => {
      if (key === "name") {
        const name = text(value, 120);
        if (name) return [key, name];
      }
      if (key === "includeInNetWorth" && typeof value === "boolean") return [key, value];
      if (key === "status" && (value === "active" || value === "archived")) return [key, value];
      const limit = textFields.find(([field]) => field === key)?.[1];
      if (limit) return [key, value === null ? null : text(value, limit) || null];
      throw new TypeError();
    }));
  } catch { throw invalidAccount(); }
}

function listQuery(input: unknown) {
  try {
    const query = record(input);
    if (Object.keys(query).some((key) => !["cursor", "status", "limit"].includes(key))) throw new TypeError();
    const { status, cursor, limit = "10" } = query;
    if ((Object.hasOwn(query, "status") && !member(statuses, status)) || (Object.hasOwn(query, "cursor") && !isCursor(cursor)) ||
      (Object.hasOwn(query, "limit") && typeof query.limit !== "string") || typeof limit !== "string" || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) throw new TypeError();
    const params = new URLSearchParams({ limit });
    if (typeof status === "string") params.set("status", status);
    if (typeof cursor === "string") params.set("cursor", cursor);
    return { params, cursor };
  } catch { throw new InvalidDraft("Filtros de cuentas no válidos."); }
}

function parseAccount(input: unknown) {
  const entry = record(input);
  const { type, status, currency } = entry;
  const id = uuid(entry.id);
  const name = text(entry.name, 120);
  if (!id || !name || !member(types, type) || !member(statuses, status) || typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency)) throw new TypeError();
  const metadata = textFields.flatMap(([key, size]) => entry[key] == null ? [] : [[key, text(entry[key], size)]] as const);
  return { id, name, status, type, currency, metadata };
}

export function createAccounts(request: ScopedRequest, workspaceId: string, newKey = randomUUID) {
  const get = (path: string) => request(workspaceId, path, { successStatus: 200 });
  const closeKeys = new Map<string, string>();
  const readBalance = async ({ id, currency }: ReturnType<typeof parseAccount>) => {
    const value = record(await get(`${accountsPath}/${id}/balance`));
    if (uuid(value.accountId) !== id || typeof value.asOf !== "string" || !Number.isFinite(Date.parse(value.asOf))) throw new TypeError();
    return { value, confirmed: money(value.nativeBalance, currency), asOf: value.asOf };
  };
  return {
    async list(input: unknown = {}) {
      const { params, cursor } = listQuery(input);
      const { items, pageInfo } = record(await get(`${accountsPath}?${params}`));
      const { hasNextPage, nextCursor } = record(pageInfo);
      if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !isCursor(nextCursor) || nextCursor === cursor : nextCursor != null)) throw new TypeError();
      const accounts = items.map(parseAccount);
      if (new Set(accounts.map(({ id }) => id)).size !== accounts.length) throw new TypeError();
      const rows = await Promise.all(accounts.map(async (account) => {
        try { const { confirmed, asOf } = await readBalance(account); return { ...account, balance: confirmed, asOf }; }
        catch (error) {
          if (error instanceof TransportError && error.kind === "http" && [404, 503].includes(error.status ?? 0)) return { ...account, balance: null, asOf: null };
          throw error;
        }
      }));
      return { items: rows, nextCursor: hasNextPage && isCursor(nextCursor) ? nextCursor : null };
    },
    async detail(raw: unknown) {
      const id = uuid(raw);
      if (!id) throw new InvalidDraft("Cuenta no válida.");
      const { body, etag } = record(await request(workspaceId, `${accountsPath}/${id}`, { successStatus: 200, includeETag: true }));
      const account = parseAccount(body);
      const { includeInNetWorth } = record(body);
      if (account.id !== id) throw new TypeError();
      const editable = account.status !== "closed" && isETag(etag) && typeof includeInNetWorth === "boolean" ? { etag, includeInNetWorth } : null;
      const { value, confirmed, asOf } = await readBalance(account);
      const bucket = (name: string) => value[name] === undefined ? "No informado" : money(value[name], account.currency);
      const fx = record(value.baseCurrencyEquivalent);
      const { rate, rateDate, rateSource } = fx;
      if (money(fx.original, account.currency) !== confirmed || typeof rate !== "string" || !/^\d+(?:\.\d+)?$/.test(rate) || typeof rateDate !== "string" || !isDay(rateDate) || typeof rateSource !== "string" || !rateSource.trim()) throw new TypeError();
      return { account, editable, asOf, confirmed, pending: bucket("pendingBalance"), available: bucket("availableBalance"), reconciled: bucket("reconciledBalance"), equivalent: money(fx.converted), rate, rateDate, rateSource };
    },
    async update(raw: unknown, etag: unknown, input: unknown) {
      const id = uuid(raw);
      if (!id || !isETag(etag)) throw invalidAccount();
      const body = updateBody(input);
      await request(workspaceId, `${accountsPath}/${id}`, { method: "PATCH", body, ifMatch: etag, successStatus: 200 });
    },
    async close(raw: unknown, etag: unknown, confirmed: unknown) {
      const id = uuid(raw);
      if (!id || !isETag(etag) || confirmed !== true) throw invalidAccount();
      const draft = `${id}:${etag}`;
      const idempotencyKey = closeKeys.get(draft) ?? uuid(newKey());
      if (!idempotencyKey) throw new TypeError();
      closeKeys.set(draft, idempotencyKey);
      await request(workspaceId, `${accountsPath}/${id}/close`, { method: "POST", ifMatch: etag, idempotencyKey, successStatus: 200 });
    },
    draft() {
      const keys = new Map<string, string>();
      return async (input: unknown) => {
        const body = createBody(input);
        const normalized = JSON.stringify(body);
        const idempotencyKey = keys.get(normalized) ?? uuid(newKey());
        if (!idempotencyKey) throw new TypeError();
        keys.set(normalized, idempotencyKey);
        const result = record(await request(workspaceId, accountsPath, { method: "POST", successStatus: 201, body, idempotencyKey }));
        const id = uuid(result.id);
        if (!id) throw new TypeError();
        return id;
      };
    },
  };
}
export type Accounts = ReturnType<typeof createAccounts>;
