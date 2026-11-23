import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { isOfflineFailure, TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const receiptsPath = "/v1/receipts";
export const receiptImageLimit = 5 * 1024 * 1024;
export const receiptStatuses = { uploaded: "Recibo subido", processing: "Procesando recibo…", awaiting_review: "Revisar datos extraídos",
  confirmed: "Recibo confirmado", failed: "No se pudo leer el recibo" } as const;
export const receiptFields = { merchant: "Comercio", date: "Fecha sugerida", currency: "Moneda sugerida", total: "Total sugerido" } as const;
export type ReceiptImage = Readonly<{ name: string; blob: Blob }>;
export type ImageOrigin = "camera" | "gallery";
export type ReceiptImageSource = (origin: ImageOrigin) => Promise<ReceiptImage | null>;
export const invalidImage = () => new InvalidDraft("Elige una imagen JPEG, PNG o WebP de hasta 5 MiB.");
const extensions = new Map([["image/jpeg", /\.jpe?g$/i], ["image/png", /\.png$/i], ["image/webp", /\.webp$/i]]);
export function validateReceiptImage(input: unknown): ReceiptImage {
  let file;
  try { file = fundRecord(input); } catch { throw invalidImage(); }
  const { name, blob } = file;
  if (typeof name !== "string" || name.length > 255 || /[/\\\x00-\x1f\x7f]/.test(name) || !(blob instanceof Blob) ||
    !extensions.get(blob.type)?.test(name) || !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > receiptImageLimit) throw invalidImage();
  return { name, blob };
}
async function hashImage(blob: Blob) {
  // React Native Blob may not implement arrayBuffer; FileReader can read the same native object without a file copy.
  const bytes = typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { if (reader.result instanceof ArrayBuffer) resolve(reader.result); else reject(invalidImage()); };
    reader.onerror = reader.onabort = () => reject(invalidImage());
    reader.readAsArrayBuffer(blob);
  });
  if (bytes.byteLength !== blob.size) throw invalidImage();
  return Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function parsedField(raw: unknown) {
  if (raw == null) return null;
  const { value, confidence } = fundRecord(raw);
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new TypeError();
  const rendered = typeof value === "string" && [...value].length <= 500 ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  return rendered ? { value: rendered, confidence: Math.round(confidence * 100) } : null;
}
function parsedReceipt(input: unknown, expected?: string) {
  const row = fundRecord(input), { id: raw, status, createdAt, fileName, processingLocation } = row, id = uuid(raw), transactionId = uuid(row.transactionId);
  if (!id || (expected && id !== expected) || typeof status !== "string" || !Object.hasOwn(receiptStatuses, status) ||
    typeof fileName !== "string" || !fileName.trim() || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
    typeof processingLocation !== "string" || !["device", "savia", "external_provider"].includes(processingLocation) ||
    (row.transactionId != null && !transactionId) || (status === "confirmed" && !transactionId)) throw new TypeError();
  return { id, status: status as keyof typeof receiptStatuses, fileName, transactionId,
    merchant: parsedField(row.merchant), date: parsedField(row.date), currency: parsedField(row.currency), total: parsedField(row.total) };
}
export const receiptInProgress = (status: Receipt["status"]) => status === "uploaded" || status === "processing";
export function createReceipts(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace);
  return {
    async upload(input: unknown, confirmation?: PendingSubmissionExpired) {
      const { name, blob } = validateReceiptImage(input);
      if (!scope) throw new InvalidDraft("Recibo no válido.");
      const method = "POST", processing = "savia", multipart = new FormData();
      const fingerprint = JSON.stringify([method, receiptsPath, name, blob.type, processing, await hashImage(blob)]);
      multipart.append("file", blob, name); multipart.append("processingPreference", processing);
      try {
        return parsedReceipt(await request(scope, receiptsPath, { method, multipart, successStatus: 202,
          submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, fingerprint, async (key) => {
            const raw = await operation(key); parsedReceipt(raw); return raw;
          }, { serverDate, confirmation }),
        }));
      } catch (error) {
        if (isOfflineFailure(error)) throw new InvalidDraft("Necesitas conexión para subir el recibo. Reintenta con la misma imagen.");
        if (error instanceof TransportError && error.status === 422) throw new InvalidDraft("El servidor no pudo aceptar la imagen.");
        throw error;
      }
    },
    async detail(raw: unknown) {
      const id = uuid(raw);
      if (!scope || !id) throw new InvalidDraft("Recibo no válido.");
      return parsedReceipt(await request(scope, `${receiptsPath}/${id}`, { successStatus: 200 }), id);
    },
  };
}
export type Receipt = ReturnType<typeof parsedReceipt>;
export type Receipts = ReturnType<typeof createReceipts>;
