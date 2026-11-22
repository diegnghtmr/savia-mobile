import { amountMinor, isETag, money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { isCursor } from "./cursor";
import { InvalidDraft } from "./identity-draft";
import { creationReceipt } from "./ledger-create";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { uuid } from "./workspace-context";

export const statuses = { draft: "Borrador", pending: "Pendiente", confirmed: "Confirmada", reconciled: "Conciliada", voided: "Anulada" } as const;
export const types = { income: "Ingreso", expense: "Gasto", adjustment: "Ajuste", refund: "Reembolso", debt_payment: "Pago de deuda", fund_contribution: "Aporte a fondo" } as const;
const isMember = <T extends object>(table: T, key: unknown): key is keyof T => typeof key === "string" && Object.hasOwn(table, key);
const isDate = (value: string) => /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toJSON()?.slice(0, 10) === value;
const endpoint = "/v1/transactions";
type Catalog = "accounts" | "categories" | "payees" | "tags";
export type Filters = Partial<Record<"limit" | "accountId" | "categoryId" | "from" | "to" | "status" | "query", string>>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") throw new TypeError();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError();
  return value;
};
const requiredId = (value: unknown) => {
  const id = uuid(value);
  if (!id) throw new TypeError();
  return id;
};
const optionalText = (value: unknown) => {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError();
  return value;
};

const metadata = ["date", "categoryId", "payeeId", "description", "tagIds"] as const;
export type LedgerDraft = Partial<Record<"date" | "description" | "categoryId" | "payeeId" | "type" | "amount" | "accountId" | "status", string | null> & { tagIds: string[] }>;
const invalidMovement = () => new InvalidDraft("Revisa los datos del movimiento.");
const cleanText = (raw: unknown, max: number) => {
  if (typeof raw !== "string" || raw.includes("\0") || [...raw.trim()].length > max) throw new TypeError();
  return raw.trim();
};
function writeBody(input: unknown, currencies?: Map<string, string>) {
  try {
    const draft = object(input), keys = Object.keys(draft);
    const allowed = currencies ? [...metadata, "type", "accountId", "amount", "status"] : metadata;
    if (!keys.length || keys.some((key) => !(allowed as readonly string[]).includes(key))) throw new TypeError();
    const body: Record<string, unknown> = currencies ? { categoryId: null, payeeId: null, description: null, tagIds: [] } : {};
    if (currencies) {
      const accountId = requiredId(draft.accountId), currency = currencies.get(accountId);
      if (!currency || !isMember(types, draft.type) || !Object.hasOwn(draft, "date")) throw new TypeError();
      Object.assign(body, { accountId, type: draft.type, amount: { currency, amountMinor: amountMinor(cleanText(draft.amount, 64), currency) } });
      if (Object.hasOwn(draft, "status")) {
        if (draft.status !== "draft" && draft.status !== "pending" && draft.status !== "confirmed") throw new TypeError();
        body.status = draft.status;
      }
    }
    for (const key of metadata) {
      if (!Object.hasOwn(draft, key)) continue;
      const value = draft[key];
      if (key === "date") {
        if (typeof value !== "string" || !isDate(value)) throw new TypeError();
        body.occurredAt = `${value}T00:00:00.000Z`;
      } else if (key === "tagIds") {
        const tags = array(value).map(requiredId).sort();
        if (new Set(tags).size !== tags.length) throw new TypeError();
        body.tagIds = tags;
      } else if (key === "description") body.description = value === null ? null : cleanText(value, 500) || null;
      else body[key] = value === null ? null : requiredId(value);
    }
    return body;
  } catch { throw invalidMovement(); }
}

function queryFor(input: unknown) {
  try {
    const params = new URLSearchParams({ limit: "20" });
    for (const [key, value] of Object.entries(object(input))) {
      if (typeof value !== "string") throw new TypeError();
      switch (key) {
        case "accountId": case "categoryId": params.set(key, requiredId(value)); continue;
        case "limit": if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 200) break; throw new TypeError();
        case "cursor": if (isCursor(value)) break; throw new TypeError();
        case "from": case "to": if (isDate(value)) break; throw new TypeError();
        case "status": if (isMember(statuses, value)) break; throw new TypeError();
        case "query": if (!value.includes("\0") && [...value].length <= 200) break; throw new TypeError();
        default: throw new TypeError();
      }
      params.set(key, value);
    }
    const from = params.get("from"), to = params.get("to");
    if (from && to && from > to) throw new TypeError();
    return params;
  } catch { throw new InvalidDraft("Revisa los filtros."); }
}

function parsePage<T extends { id: string }>(input: unknown, parse: (value: unknown) => T, cursor: string | null, workspace?: string) {
  const { items, pageInfo } = object(input);
  const { hasNextPage, nextCursor } = object(pageInfo);
  const next = isCursor(nextCursor, workspace) ? nextCursor : null;
  if (typeof hasNextPage !== "boolean" || (hasNextPage ? next === null || next === cursor : nextCursor != null)) throw new TypeError();
  const rows = array(items).map(parse);
  if (new Set(rows.map(({ id }) => id)).size !== rows.length) throw new TypeError();
  return { items: rows, nextCursor: next };
}

function transaction(input: unknown) {
  const { id, type, status, occurredAt, amount, description } = object(input);
  if (!isMember(types, type) || !isMember(statuses, status) || typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) throw new TypeError();
  return { id: requiredId(id), title: optionalText(description)?.trim() || types[type], type: types[type], status: statuses[status], occurredAt, amount: money(amount) };
}

export function createTransactions(request: ScopedRequest, workspaceId: string) {
  const get = (path: string) => request(workspaceId, path, { successStatus: 200 });
  let accountCurrencies = new Map<string, string>();
  async function write(method: "POST" | "PATCH", path: string, body: object, confirmation?: PendingSubmissionExpired, expected?: string, ifMatch?: string, form?: object) {
    const result = await request(workspaceId, path, { method, body, ifMatch, form, successStatus: expected ? 200 : 201,
      submit: (profile, operation, serverDate) => pendingSubmission(requiredId(workspaceId), profile, JSON.stringify([method, path, body]), async (key) => {
        const saved = object(await operation(key));
        if (!expected) return creationReceipt(path, body, saved);
        const id = requiredId(saved.id);
        if ((expected && id !== expected) || (path.endsWith("/void") && saved.status !== "voided")) throw new TypeError();
        return id;
      }, { ifMatch, confirmation, serverDate }),
    });
    return requiredId(result);
  }
  async function catalog(kind: Catalog, currencies?: Map<string, string>) {
    const workspace = kind === "accounts" ? undefined : requiredId(workspaceId);
    const params = new URLSearchParams({ limit: "200" }), names = new Map<string, string>(), seen = new Set<string>();
    for (;;) {
      const { items, nextCursor } = parsePage(await get(`/v1/${kind}?${params}`), (value) => {
        const { id, name, currency, status } = object(value);
        if (typeof name !== "string" || !name.trim()) throw new TypeError();
        return { id: requiredId(id), name, currency, status };
      }, params.get("cursor"), workspace);
      for (const { id, name, currency, status } of items) {
        if (names.has(id)) throw new TypeError();
        names.set(id, name);
        if (currencies && (status === "active" || status === "archived") && typeof currency === "string" && ACTIVE_CURRENCIES.has(currency)) currencies.set(id, currency);
      }
      if (!nextCursor) return names;
      if (seen.has(nextCursor)) throw new TypeError();
      seen.add(nextCursor);
      params.set("cursor", nextCursor);
    }
  }
  return {
    options: (kind: "accounts" | "categories") => catalog(kind),
    async transferAccounts() {
      const currencies = new Map<string, string>();
      const names = await catalog("accounts", currencies);
      return [...currencies].map(([id, currency]) => ({ id, currency, name: names.get(id)! }));
    },
    async formOptions(creating: boolean) {
      const currencies = new Map<string, string>();
      const [accounts, categories, payees, tags] = await Promise.all([creating ? catalog("accounts", currencies) : new Map<string, string>(), catalog("categories"), catalog("payees"), catalog("tags")]);
      if (creating) accountCurrencies = currencies;
      return { accounts: new Map([...currencies].map(([id, currency]) => [id, `${accounts.get(id)} (${currency})`])), categories, payees, tags };
    },
    async create(input: unknown, confirmation?: PendingSubmissionExpired, form?: object) {
      return write("POST", endpoint, writeBody(input, accountCurrencies), confirmation, undefined, undefined, form);
    },
    async update(raw: unknown, etag: unknown, input: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      if (!id || !isETag(etag)) throw invalidMovement();
      return write("PATCH", `${endpoint}/${id}`, writeBody(input), confirmation, id, etag);
    },
    async void(raw: unknown, etag: unknown, value: unknown, confirmed: unknown, confirmation?: PendingSubmissionExpired) {
      const id = uuid(raw);
      if (!id || !isETag(etag) || confirmed !== true) throw invalidMovement();
      let reason: string;
      try { reason = cleanText(value, 500); if ([...reason].length < 3) throw new TypeError(); }
      catch { throw new InvalidDraft("Escribe un motivo de 3 a 500 caracteres."); }
      return write("POST", `${endpoint}/${id}/void`, { reason }, confirmation, id, etag);
    },
    async list(input: unknown = {}) {
      const params = queryFor(input);
      return parsePage(await get(`${endpoint}?${params}`), transaction, params.get("cursor"));
    },
    async detail(raw: unknown) {
      const id = uuid(raw);
      if (!id) throw new InvalidDraft("Movimiento no válido.");
      const response = object(await request(workspaceId, `${endpoint}/${id}`, { successStatus: 200, includeETag: true }));
      const body = object(response.body);
      const row = transaction(body);
      if (row.id !== id) throw new TypeError();
      const account = requiredId(body.accountId), category = body.categoryId == null ? null : requiredId(body.categoryId), payee = body.payeeId == null ? null : requiredId(body.payeeId);
      const tagsOf = (value: unknown) => value === undefined ? [] : array(value).map(requiredId);
      const tagIds = tagsOf(body.tagIds);
      const splits = (body.splits === undefined ? [] : array(body.splits)).map((part) => {
        const { amount, categoryId, notes, tagIds } = object(part);
        return { amount: money(amount), category: requiredId(categoryId), notes: optionalText(notes), tags: tagsOf(tagIds) };
      });
      const equivalent = body.baseCurrencyAmount === undefined ? null : money(object(body.baseCurrencyAmount).converted);
      const notes = optionalText(body.notes);
      const [accounts, categories, payees, tags] = await Promise.all([
        catalog("accounts"), category || splits.length ? catalog("categories") : null,
        payee ? catalog("payees") : null, tagIds.length || splits.some((split) => split.tags.length) ? catalog("tags") : null,
      ]);
      const label = (names: Map<string, string> | null, id: string) => names?.get(id) ?? "No disponible";
      const editable = isETag(response.etag) && body.status !== "voided" && body.status !== "reconciled" ? {
        etag: response.etag, canVoid: body.status !== "draft", fields: { date: row.occurredAt.slice(0, 10), categoryId: category, payeeId: payee, description: optionalText(body.description), tagIds },
      } : null;
      return { ...row, editable, notes, equivalent, account: label(accounts, account), category: category && label(categories, category),
        payee: payee && label(payees, payee), tags: tagIds.map((id) => label(tags, id)),
        splits: splits.map((split) => ({ ...split, category: label(categories, split.category), tags: split.tags.map((id) => label(tags, id)) })) };
    },
  };
}
export type Transactions = ReturnType<typeof createTransactions>;
