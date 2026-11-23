import { isDay, type ScopedRequest } from "./accounts";
import { isCursor } from "./cursor";
import { fundRecord } from "./funds";
import { parseFxRatesUsed, type FxRateUsed } from "./fx-rates";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { memoryPendingJournal, pendingSubmission } from "./pending-submission";
import { TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const reportFormats = { json: "JSON", csv: "CSV", pdf: "PDF" } as const;
export const reportPresets = {
  monthly_summary: "Resumen mensual", cash_flow: "Flujo de caja", expenses: "Gastos", income: "Ingresos",
  budget: "Presupuesto", net_worth: "Patrimonio neto", debts: "Deudas", funds: "Fondos", family_workspace: "Espacio familiar",
  multi_currency: "Multimoneda", forecast: "Pronóstico", period_comparison: "Comparación de períodos",
} as const;
export const exportFormats = { csv: "CSV", json_backup: "Respaldo JSON", xlsx: "Excel (XLSX)" } as const;
// The schema also declares budgets, debts, and report, but the export service rejects those resources.
export const resources = { all: "Todos los datos", transactions: "Movimientos", accounts: "Cuentas" } as const;
export const jobStatuses = { queued: "En cola", processing: "En proceso", completed: "Completado", failed: "Fallido" } as const;
const paths = { report: "/v1/report-runs", export: "/v1/export-jobs", backup: "/v1/backup-jobs" } as const;
const unavailable = "Esta función no está disponible en este servidor.";
const backupUnavailable = "Copia completa no disponible en este servidor.";
export const backupForbidden = "Solo el propietario puede crear y descargar copias completas.";
const noLink = "No hay un enlace de descarga vigente.";
export type JobKind = keyof typeof paths;
export type DataJob = Readonly<{ id: string; kind: JobKind; status: keyof typeof jobStatuses; format?: string; fxRatesUsed?: readonly FxRateUsed[] }>;
export const inProgress = (job: DataJob) => job.status === "queued" || job.status === "processing";
export type ReportSelection = { definitionId: string; preset?: never } | { preset: string; definitionId?: never };
export type JobDraft = ({ kind: "report"; format: string } & ReportSelection) |
  { kind: "export"; format: string; resource: string; from: string; to: string } | { kind: "backup" };

function member<T extends object>(set: T, value: unknown): value is keyof T {
  return typeof value === "string" && Object.hasOwn(set, value);
}
function parseJob(input: unknown, kind: JobKind, format?: string): DataJob {
  const { id: raw, status, format: actual, createdAt, fxRatesUsed } = fundRecord(input), id = uuid(raw);
  if (!id || !member(jobStatuses, status) || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
    (kind !== "backup" && actual !== format)) throw new TypeError("Invalid data job");
  const rates = kind === "report" ? parseFxRatesUsed(fxRatesUsed) : undefined;
  return Object.freeze({ id, status, kind, format, ...(rates && { fxRatesUsed: rates }) });
}

function parseDefinition(input: unknown) {
  const { id: raw, name } = fundRecord(input), id = uuid(raw);
  if (!id || typeof name !== "string" || !name.trim()) throw new TypeError("Invalid report definition");
  return { id, name };
}

function validDownload(link: unknown, expiresAt: unknown, serverDate: number | null, elapsed: number) {
  if (serverDate === null || typeof expiresAt !== "string" || !(Date.parse(expiresAt) > serverDate + elapsed) ||
    typeof link !== "string" || !/^https:\/\/[^/?#]/.test(link) || /[\s\\#\x00-\x1f\x7f]/.test(link)) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? link : null;
  } catch { return null; }
}

export function createDataJobs(request: ScopedRequest, workspace: string, journal = memoryPendingJournal()) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope);
  const rows = new Map<string, ReturnType<typeof parseDefinition>>(), seen = new Set<string>();
  const submitted = new WeakSet<DataJob>();
  const cursorOK = (value: unknown): value is string => isCursor(value, scope, undefined, true);
  let next: string | null = null;
  async function isOwner() {
    const { id, role } = fundRecord(await call(`/v1/workspaces/${scope}`,
      { subjectResource: true, onlineOnly: true, successStatus: 200 }, unavailable, []));
    if (uuid(id) !== scope || !["owner", "administrator", "editor", "viewer"].includes(String(role))) throw new TypeError("Invalid workspace role");
    return role === "owner";
  }
  async function withJob<T>(kind: JobKind, operation: () => Promise<T>) {
    try {
      if (kind === "backup" && !await isOwner()) throw new InvalidDraft(backupForbidden);
      return await operation();
    } catch (error) {
      if (error instanceof TransportError && error.kind === "http" && error.status === 403) {
        throw new InvalidDraft(kind === "backup" ? backupForbidden : "No tienes permiso para realizar esta operación.");
      }
      throw error;
    }
  }
  async function inspect(job: DataJob, download = false) {
    if (!submitted.has(job)) throw new InvalidDraft("Revisa el trabajo antes de continuar.");
    return withJob(job.kind, async () => {
      let serverDate: number | null = null;
      const started = performance.now();
      const missing = job.kind === "backup" || (job.kind === "export" && !download) ? [404, 501] : [501];
      const raw = await call(`${paths[job.kind]}/${job.id}`, { onlineOnly: true, successStatus: 200,
        ...(download ? { onResponseDate: (date: number | null) => { serverDate = date; } } : {}) },
      job.kind === "backup" ? backupUnavailable : unavailable, missing);
      const current = parseJob(raw, job.kind, job.format);
      if (current.id !== job.id) throw new TypeError("Unexpected data job");
      const { downloadUrl, expiresAt } = fundRecord(raw);
      const link = download && current.status === "completed" ? validDownload(downloadUrl, expiresAt, serverDate, performance.now() - started) : null;
      submitted.add(current);
      return { current, link };
    });
  }
  function payload(draft: JobDraft) {
    if (draft.kind === "backup") return undefined;
    if (draft.kind === "report") {
      const { definitionId, preset, format } = draft;
      if (member(reportFormats, format)) {
        if (preset === undefined && typeof definitionId === "string" && rows.has(definitionId)) return { definitionId, format };
        if (definitionId === undefined && member(reportPresets, preset)) return { preset, format };
      }
      throw new InvalidDraft("Selecciona un informe y un formato.");
    }
    const from = draft.from.trim(), to = draft.to.trim();
    if (!member(exportFormats, draft.format) || !member(resources, draft.resource) ||
      (from && !isDay(from)) || (to && !isDay(to)) || (from && to && from > to)) throw new InvalidDraft("Revisa los datos de la exportación.");
    return { format: draft.format, resource: draft.resource, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  return {
    isOwner,
    async definitions(cursor?: string) {
      if (cursor !== undefined && (!cursorOK(cursor) || cursor !== next)) throw new InvalidDraft("Página de informes no válida.");
      if (!cursor) { rows.clear(); seen.clear(); next = null; }
      const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor", cursor);
      const { items, pageInfo } = fundRecord(await call(`/v1/report-definitions?${query}`, { onlineOnly: true, successStatus: 200 }, unavailable));
      const { hasNextPage, nextCursor } = fundRecord(pageInfo);
      if (!Array.isArray(items) || items.length > 20 || typeof hasNextPage !== "boolean" ||
        (hasNextPage ? !cursorOK(nextCursor) || seen.has(nextCursor) || !items.length : nextCursor !== null)) throw new TypeError("Invalid report definitions page");
      const page = items.map(parseDefinition);
      if (new Set(page.map(({ id }) => id)).size !== page.length || page.some(({ id }) => rows.has(id))) throw new TypeError("Duplicate report definition");
      for (const row of page) rows.set(row.id, row);
      next = cursorOK(nextCursor) ? nextCursor : null;
      if (next) seen.add(next);
      return { items: [...rows.values()], next };
    },
    async start(draft: JobDraft, confirmation?: PendingSubmissionExpired) {
      const { kind } = draft, body = payload(draft), path = paths[kind];
      return withJob(kind, async () => {
        const job = await call(path, { method: "POST", body, onlineOnly: true, successStatus: 202,
          submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify(["POST", path, body]),
            async (key) => parseJob(await operation(key), kind, body?.format), { serverDate, journal, confirmation }) },
        kind === "backup" ? backupUnavailable : unavailable) as DataJob;
        submitted.add(job);
        return job;
      });
    },
    async status(job: DataJob) { return (await inspect(job)).current; },
    async download(job: DataJob) {
      const { link } = await inspect(job, true);
      if (!link) throw new InvalidDraft(noLink);
      return link;
    },
  };
}
export type DataJobs = ReturnType<typeof createDataJobs>;
