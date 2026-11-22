import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { isReplayFresh, PendingSubmissionExpired } from "./pending-expiry";
import { secureStorage } from "./session-store";
import { uuid } from "./workspace-context";

const inFlight = new Map<string, Promise<unknown>>();
const hash = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);

export function readPendingRecord(raw: string | null) {
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw) as { key?: unknown; createdAt?: unknown; clock?: unknown } | null;
    const key = uuid(entry?.key), at = entry?.createdAt;
    return key ? { key, createdAt: entry?.clock === "server" && typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : null } : null;
  } catch { return null; }
}

export async function pendingSlot(workspace: string, profile: string, normalized: string, ifMatch?: string) {
  return `savia.ledger.v1.${workspace}.${profile}.` + await hash(ifMatch === undefined ? normalized : JSON.stringify([normalized, ifMatch]));
}

export async function pendingSubmission(workspace: string, profile: string, normalized: string, operation: (key: string) => Promise<unknown>,
  { serverDate, ifMatch, confirmation, journal = secureStorage, initialKey }: {
    serverDate: number | null; ifMatch?: string; confirmation?: PendingSubmissionExpired;
    journal?: typeof secureStorage; initialKey?: string;
  }) {
  const slot = await pendingSlot(workspace, profile, normalized, ifMatch);
  const current = inFlight.get(slot);
  if (current) return current;
  const submit = (async () => {
    const saved = await journal.getItem(slot);
    // Old edit/void records had neither a timestamp nor a precondition. Never send those keys.
    const legacySlot = ifMatch === undefined ? null : await pendingSlot(workspace, profile, normalized);
    const legacy = legacySlot === null ? null : await journal.getItem(legacySlot);
    const record = readPendingRecord(saved ?? legacy), unresolved = saved ?? legacy;
    const reuse = !confirmation && saved !== null && record && isReplayFresh(record.createdAt, serverDate);
    if (confirmation && (unresolved === null || !confirmation.matches(slot, unresolved))) throw new Error("Pending submission changed");
    if (!reuse && unresolved !== null && !confirmation) throw new PendingSubmissionExpired(slot, unresolved);
    const key = reuse ? record.key : uuid(unresolved === null && initialKey ? initialKey : randomUUID());
    if (!key || (!reuse && key === (record?.key ?? uuid(unresolved)))) throw new TypeError("Invalid pending submission key");
    if (!reuse) await journal.setItem(slot, JSON.stringify({ key, createdAt: serverDate, clock: "server" }));
    const result = await operation(key);
    if (legacySlot !== null && legacy !== null) await journal.removeItem(legacySlot);
    await journal.removeItem(slot);
    return result;
  })();
  inFlight.set(slot, submit);
  try { return await submit; } finally { inFlight.delete(slot); }
}
