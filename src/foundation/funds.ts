import { isDay, money, type ScopedRequest } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { isCursor } from "./cursor";
import { InvalidDraft } from "./identity-draft";
import { percentOf } from "./planning-money";
import { uuid } from "./workspace-context";

export const fundsPath = "/v1/funds";
export const fundStatuses = { active: "Activo", completed: "Completado", paused: "En pausa", archived: "Archivado" } as const;
export function fundRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError();
  return input as Record<string, unknown>;
}

export function parseFund(input: unknown) {
  const { id: raw, name, currency, status, targetDate, linkedAccountId: link, targetAmount, currentAmount, recommendedMonthlyContribution } = fundRecord(input);
  const id = uuid(raw), linkedAccountId = uuid(link);
  if (!id || typeof name !== "string" || !name.trim() || typeof currency !== "string" || !ACTIVE_CURRENCIES.has(currency) ||
    typeof status !== "string" || !Object.hasOwn(fundStatuses, status) || (targetDate != null && (typeof targetDate !== "string" || !isDay(targetDate))) ||
    (link != null && !linkedAccountId)) throw new TypeError();
  const target = money(targetAmount, currency), saved = money(currentAmount, currency);
  const targetMinor = BigInt(fundRecord(targetAmount).amountMinor as string), savedMinor = BigInt(fundRecord(currentAmount).amountMinor as string);
  if (targetMinor <= 0n) throw new TypeError();
  const remaining = money({ currency, amountMinor: String(savedMinor >= targetMinor ? 0n : targetMinor - savedMinor) });
  return { id, name, currency, status: status as keyof typeof fundStatuses, targetDate: targetDate as string | null | undefined, linkedAccountId,
    target, saved, remaining, progress: percentOf(savedMinor, targetMinor),
    recommended: recommendedMonthlyContribution === undefined ? null : money(recommendedMonthlyContribution, currency) };
}

function listQuery(input: unknown, scope: string) {
  try {
    const filters = fundRecord(input), { limit, cursor } = filters;
    if (!scope || Object.keys(filters).some((key) => key !== "limit" && key !== "cursor")) throw new TypeError();
    const params = new URLSearchParams({ limit: "20" });
    if (Object.hasOwn(filters, "limit")) {
      if (typeof limit !== "string" || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) throw new TypeError();
      params.set("limit", limit);
    }
    if (Object.hasOwn(filters, "cursor")) {
      if (!isCursor(cursor, scope, undefined, true)) throw new TypeError();
      params.set("cursor", cursor);
    }
    return { params, cursor };
  } catch { throw new InvalidDraft("Filtros de fondos no válidos."); }
}

export function createFunds(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "";
  async function list(filters: unknown = {}) {
    const { params, cursor } = listQuery(filters, scope);
    const { items, pageInfo } = fundRecord(await request(scope, `${fundsPath}?${params}`, { successStatus: 200 }));
    const { hasNextPage, nextCursor } = fundRecord(pageInfo);
    const next = isCursor(nextCursor, scope, undefined, true) ? nextCursor : null;
    if (!Array.isArray(items) || typeof hasNextPage !== "boolean" || (hasNextPage ? !next || next === cursor || !items.length : nextCursor != null)) throw new TypeError();
    const rows = items.map(parseFund);
    if (new Set(rows.map(({ id }) => id)).size !== rows.length) throw new TypeError();
    return { items: rows, nextCursor: next };
  }
  return { list, async detail(raw: unknown) {
    const id = uuid(raw);
    if (!id || !scope) throw new InvalidDraft("Fondo no válido.");
    const cursors = new Set<string>(), ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const { items, nextCursor } = await list(cursor ? { cursor } : {});
      if ((nextCursor && cursors.has(nextCursor)) || items.some((row) => ids.has(row.id))) throw new TypeError();
      const fund = items.find((row) => row.id === id);
      if (fund) return fund;
      for (const row of items) ids.add(row.id);
      if (nextCursor) cursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return null;
  } };
}
export type Funds = ReturnType<typeof createFunds>;
export type Fund = ReturnType<typeof parseFund>;
