import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { PendingSubmissionExpired } from "./pending-expiry";
import { secureStorage } from "./session-store";
import { uuid } from "./workspace-context";

const inFlight = new Map<string, Promise<unknown>>();
const replayLimit = 23 * 60 * 60 * 1000; // Leave an hour before the server forgets the key.
const hash = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);

function readRecord(raw: string | null) {
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw) as { key?: unknown; createdAt?: unknown } | null;
    const key = uuid(entry?.key), createdAt = entry?.createdAt;
    return key && typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= 0 ? { key, createdAt } : null;
  } catch { return null; }
}

export async function pendingSubmission(workspace: string, profile: string, normalized: string, operation: (key: string) => Promise<unknown>,
  { ifMatch, confirmation }: { ifMatch?: string; confirmation?: PendingSubmissionExpired } = {}) {
  const prefix = `savia.ledger.v1.${workspace}.${profile}.`;
  const slot = prefix + await hash(ifMatch === undefined ? normalized : JSON.stringify([normalized, ifMatch]));
  const current = inFlight.get(slot);
  if (current) return current;
  const submit = (async () => {
    const saved = await secureStorage.getItem(slot);
    // Old edit/void records had neither a timestamp nor a precondition. Never send those keys.
    const legacySlot = ifMatch === undefined ? null : prefix + await hash(normalized);
    const legacy = legacySlot === null ? null : await secureStorage.getItem(legacySlot);
    const record = readRecord(saved), now = Date.now();
    const fresh = record && now >= record.createdAt && now - record.createdAt <= replayLimit;
    const unresolved = saved ?? legacy;
    if (confirmation && (unresolved === null || fresh)) throw new Error("Pending submission changed");
    if (!fresh && unresolved !== null && !confirmation?.matches(slot, unresolved)) throw new PendingSubmissionExpired(slot, unresolved);
    const key = fresh ? record.key : uuid(randomUUID());
    if (!key || (!fresh && key === (record?.key ?? uuid(unresolved)))) throw new TypeError("Invalid pending submission key");
    if (!fresh) await secureStorage.setItem(slot, JSON.stringify({ key, createdAt: now }));
    const result = await operation(key);
    if (legacySlot !== null && legacy !== null) await secureStorage.removeItem(legacySlot);
    await secureStorage.removeItem(slot);
    return result;
  })();
  inFlight.set(slot, submit);
  try { return await submit; } finally { inFlight.delete(slot); }
}
