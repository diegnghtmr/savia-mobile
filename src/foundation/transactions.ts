import { money, type ScopedRequest } from "./accounts";
import { isCursor } from "./cursor";
import { InvalidDraft } from "./identity-draft";
import { uuid } from "./workspace-context";

export const statuses = { draft: "Borrador", pending: "Pendiente", confirmed: "Confirmada", reconciled: "Conciliada", voided: "Anulada" } as const;
const types = { income: "Ingreso", expense: "Gasto", adjustment: "Ajuste", refund: "Reembolso", debt_payment: "Pago de deuda", fund_contribution: "Aporte a fondo" } as const;
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
  async function catalog(kind: Catalog) {
    const workspace = kind === "accounts" ? undefined : requiredId(workspaceId);
    const params = new URLSearchParams({ limit: "200" }), names = new Map<string, string>(), seen = new Set<string>();
    for (;;) {
      const { items, nextCursor } = parsePage(await get(`/v1/${kind}?${params}`), (value) => {
        const { id, name } = object(value);
        if (typeof name !== "string" || !name.trim()) throw new TypeError();
        return { id: requiredId(id), name };
      }, params.get("cursor"), workspace);
      for (const { id, name } of items) {
        if (names.has(id)) throw new TypeError();
        names.set(id, name);
      }
      if (!nextCursor) return names;
      if (seen.has(nextCursor)) throw new TypeError();
      seen.add(nextCursor);
      params.set("cursor", nextCursor);
    }
  }
  return {
    options: (kind: "accounts" | "categories") => catalog(kind),
    async list(input: unknown = {}) {
      const params = queryFor(input);
      return parsePage(await get(`${endpoint}?${params}`), transaction, params.get("cursor"));
    },
    async detail(raw: unknown) {
      const id = uuid(raw);
      if (!id) throw new InvalidDraft("Movimiento no válido.");
      const body = object(await get(`${endpoint}/${id}`));
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
      return { ...row, notes, equivalent, account: label(accounts, account), category: category && label(categories, category),
        payee: payee && label(payees, payee), tags: tagIds.map((id) => label(tags, id)),
        splits: splits.map((split) => ({ ...split, category: label(categories, split.category), tags: split.tags.map((id) => label(tags, id)) })) };
    },
  };
}
export type Transactions = ReturnType<typeof createTransactions>;
