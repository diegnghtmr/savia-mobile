import { fundRecord } from "./funds";
import { uuid } from "./workspace-context";

export const jobStatuses = { queued: "En cola", processing: "En proceso", completed: "Completado", failed: "Fallido", cancelled: "Cancelado", dead_letter: "Fallido" } as const;
export function jobReceipt(input: unknown, type: string, expected?: string) {
  const { id: raw, status, type: actual, createdAt, resultResourceId } = fundRecord(input);
  const id = uuid(raw), result = uuid(resultResourceId);
  if (!id || (expected && id !== expected) || type !== actual || typeof status !== "string" || !Object.hasOwn(jobStatuses, status) ||
    typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || (resultResourceId != null && !result)) throw new TypeError();
  return { id, status: status as keyof typeof jobStatuses, result };
}
