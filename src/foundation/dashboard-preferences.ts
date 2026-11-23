import type { ScopedRequest } from "./accounts";
import { reportPeriod, reportRecord } from "./analytics";
import { ACTIVE_CURRENCIES } from "./currencies";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { memoryPendingJournal, pendingSubmission } from "./pending-submission";
import { isStrongETag, TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const dashboardPreferencesPath = "/v1/me/dashboard-preferences";
const unavailable = "Esta función no está disponible en este servidor.";
export const dashboardCards = { net_worth: "Patrimonio neto", assets: "Activos", debts: "Deudas", income: "Ingresos", expenses: "Gastos netos",
  savings_capacity: "Flujo neto", budget_utilization: "Utilización del presupuesto", account_balances: "Saldos de cuentas",
  upcoming_operations: "Próximos movimientos recurrentes", alerts: "Alertas", reconciliation_status: "Estado de conciliación" } as const;
export const dashboardPeriods = { this_month: "Este mes", this_quarter: "Este trimestre", this_year: "Este año", custom: "Personalizado" } as const;
export type DashboardCardId = keyof typeof dashboardCards;
export type DashboardPeriod = { preset: Exclude<keyof typeof dashboardPeriods, "custom"> } | { preset: "custom"; from: string; to: string };
type Card = { id: DashboardCardId; visible: boolean };
const member = <T extends object>(table: T, key: unknown): key is keyof T => typeof key === "string" && Object.hasOwn(table, key);
export const dashboardConflict = (error: unknown) => error instanceof TransportError && error.kind === "http" && (error.status === 409 || error.status === 412);
function preferences(input: unknown) {
  const row = reportRecord(input), { cards, period, presentationCurrency } = row;
  if (!Array.isArray(cards) || cards.length > Object.keys(dashboardCards).length || typeof presentationCurrency !== "string" || !ACTIVE_CURRENCIES.has(presentationCurrency)) throw new TypeError();
  const seen = new Set<DashboardCardId>();
  const ordered: Card[] = cards.map((item) => {
    const { id, visible } = reportRecord(item);
    if (!member(dashboardCards, id) || seen.has(id) || typeof visible !== "boolean") throw new TypeError();
    seen.add(id); return { id, visible };
  });
  const { preset, from, to } = reportRecord(period);
  if (!member(dashboardPeriods, preset) || (preset !== "custom" && (from !== undefined || to !== undefined))) throw new TypeError();
  const normalized: DashboardPeriod = preset === "custom" ? { preset, ...reportPeriod({ from, to }) } : { preset };
  return { cards: ordered, period: normalized, presentationCurrency };
}
export function dashboardDisplay(input: unknown) {
  const { version } = reportRecord(input);
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new TypeError();
  return { ...preferences(input), version };
}
export type DashboardPreferences = ReturnType<typeof dashboardDisplay>;
function live(input: unknown) {
  const { body, etag } = reportRecord(input);
  if (!isStrongETag(etag)) throw new TypeError();
  return { body: dashboardDisplay(body), etag };
}
export function createDashboardPreferences(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope), journal = memoryPendingJournal();
  const reviewed = new WeakSet<ReturnType<typeof live>>();
  return {
    async display() { return dashboardDisplay(await call(dashboardPreferencesPath, { successStatus: 200 }, unavailable)); },
    async edit() {
      const value = live(await call(dashboardPreferencesPath, { successStatus: 200, onlineOnly: true, includeETag: true }, unavailable));
      reviewed.add(value); return value;
    },
    async save(current: ReturnType<typeof live>, input: unknown, confirmation?: PendingSubmissionExpired) {
      let body;
      try {
        if (!reviewed.has(current)) throw new TypeError();
        const draft = reportRecord(input);
        if (typeof draft.presentationCurrency !== "string") throw new TypeError();
        body = preferences({ ...draft, presentationCurrency: draft.presentationCurrency.trim().toUpperCase() });
      } catch { throw new InvalidDraft("Revisa las preferencias del resumen."); }
      const path = dashboardPreferencesPath, method = "PUT", ifMatch = current.etag;
      const result = await call(path, { method, body, ifMatch, onlineOnly: true, includeETag: true, successStatus: 200,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]), async (key) => {
          const raw = await operation(key).catch((error: unknown) => { if (dashboardConflict(error)) return error; throw error; });
          return raw instanceof TransportError ? raw : live(raw);
        }, { serverDate, ifMatch, confirmation, journal }) }, unavailable);
      if (result instanceof TransportError) { reviewed.delete(current); throw result; }
      const value = result as ReturnType<typeof live>;
      reviewed.delete(current); reviewed.add(value); return value;
    },
  };
}
export type DashboardPreferencesApi = ReturnType<typeof createDashboardPreferences>;
