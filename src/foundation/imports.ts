import { randomUUID } from "expo-crypto";
import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const importPath = "/v1/import-jobs";
export const importStatuses = { uploaded: "Subido", analyzing: "En análisis", awaiting_mapping: "Pendiente de asignar columnas",
  awaiting_confirmation: "Pendiente de confirmar", processing: "En proceso", completed: "Importación completada", failed: "Importación fallida",
  rolled_back: "Importación revertida" } as const;
const stats = { totalRows: "Filas totales", validRows: "Válidas", duplicateRows: "Duplicadas", errorRows: "Con errores" } as const;
const fileLimit = 5 * 1024 * 1024;
const csvMime = new Set(["", "text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"]);
export type StatementFile = Readonly<{ name: string; blob: Blob }>;
// The host supplies a Blob, not a path/URL; no file is copied or persisted by the mobile client.
export type StatementFileSource = () => Promise<StatementFile | null>;
export function validateStatement(input: unknown): StatementFile {
  let file;
  try { file = fundRecord(input); } catch { throw new InvalidDraft("Elige un archivo CSV de hasta 5 MiB."); }
  const { name, blob } = file;
  if (typeof name === "string" && /\.(qif|ofx)$/i.test(name)) throw new InvalidDraft("El servidor todavía no admite QIF ni OFX.");
  if (typeof name !== "string" || name.length > 255 || !/^[^/\\\u0000-\u001f\u007f]+\.csv$/i.test(name) || !(blob instanceof Blob) ||
    !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > fileLimit || !csvMime.has(blob.type.split(";", 1)[0].trim().toLowerCase())) {
    throw new InvalidDraft("Elige un archivo CSV de hasta 5 MiB.");
  }
  return { name, blob };
}
function parseJob(input: unknown, expected?: string) {
  const row = fundRecord(input), { id: raw, status, fileName, createdAt, sourceColumns = [] } = row, id = uuid(raw);
  if (!id || (expected && id !== expected) || typeof fileName !== "string" || !fileName.trim() || typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) || typeof status !== "string" || !Object.hasOwn(importStatuses, status) ||
    !Array.isArray(sourceColumns) || !sourceColumns.every((x): x is string => typeof x === "string")) throw new TypeError();
  const counts = Object.entries(stats).map(([key, label]) => {
    const count = row[key];
    if (count != null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw new TypeError();
    return { label, count: typeof count === "number" ? count : null };
  });
  return { id, status: status as keyof typeof importStatuses, fileName, counts, sourceColumns };
}
export function createImports(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace), uploadKeys = new WeakMap<Blob, Map<string, string>>();
  return {
    async upload(input: unknown) {
      const { name, blob } = validateStatement(input);
      if (!scope) throw new InvalidDraft("Importación no válida.");
      const multipart = new FormData(); multipart.append("file", blob, name); multipart.append("formatHint", "csv");
      const keys = uploadKeys.get(blob) ?? new Map<string, string>(); uploadKeys.set(blob, keys);
      const key = keys.get(name) ?? randomUUID(); keys.set(name, key);
      try {
        const job = parseJob(await request(scope, importPath, { method: "POST", multipart, idempotencyKey: key, successStatus: 202 }));
        keys.delete(name);
        return job;
      } catch (error) {
        if (error instanceof TransportError && error.status === 422) throw new InvalidDraft("El servidor no pudo analizar el extracto. Revisa el formato del archivo.");
        throw error;
      }
    },
    async detail(raw: unknown) {
      const id = uuid(raw);
      if (!scope || !id) throw new InvalidDraft("Importación no válida.");
      return parseJob(await request(scope, `${importPath}/${id}`, { successStatus: 200 }), id);
    },
  };
}
export type Imports = ReturnType<typeof createImports>;
export type ImportJob = ReturnType<typeof parseJob>;
