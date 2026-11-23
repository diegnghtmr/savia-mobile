import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { InvalidDraft } from "./identity-draft";
import { isReplayFresh, PendingSubmissionExpired, pendingWarning } from "./pending-expiry";
import { secureStorage } from "./session-store";
import { uuid } from "./workspace-context";

const inFlight = new Map<string, Promise<unknown>>();
const hash = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);

export function readPendingRecord(raw: string | null) {
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw) as { key?: unknown; createdAt?: unknown; clock?: unknown; body?: unknown; replaces?: unknown } | null;
    const key = uuid(entry?.key), at = entry?.createdAt;
    return key ? { key, createdAt: entry?.clock === "server" && typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : null,
      body: entry?.body, replaces: entry?.replaces } : null;
  } catch { return null; }
}

export async function pendingSlot(workspace: string, profile: string, normalized: string, ifMatch?: string) {
  return `savia.ledger.v1.${workspace}.${profile}.` + await hash(ifMatch === undefined ? normalized : JSON.stringify([normalized, ifMatch]));
}

export async function pendingSubmission(workspace: string, profile: string, normalized: string, operation: (key: string, dispatchedBody?: string) => Promise<unknown>,
  { serverDate, ifMatch, confirmation, journal = secureStorage, journalSlot, initialKey, body, equivalents = [] }: {
    serverDate: number | null; ifMatch?: string; confirmation?: PendingSubmissionExpired;
    journal?: typeof secureStorage; journalSlot?: string; initialKey?: string;
    body?: string; equivalents?: readonly { normalized: string; body: string }[];
  }) {
  const slot = journalSlot ?? await pendingSlot(workspace, profile, normalized, ifMatch);
  const current = inFlight.get(slot);
  if (current) return current;
  const submit = (async () => {
    let target = slot, dispatch = body, saved = await journal.getItem(slot);
    const currentRecord = saved === null ? null : readPendingRecord(saved);
    const alternate = await Promise.all(equivalents.map(async (candidate) => {
      const at = await pendingSlot(workspace, profile, candidate.normalized);
      return { at, body: candidate.body, saved: await journal.getItem(at) };
    }));
    for (const candidate of alternate) {
      if (candidate.saved === null) continue;
      if (saved !== null) {
        if (currentRecord?.replaces !== await hash(JSON.stringify([candidate.at, candidate.saved]))) throw new InvalidDraft(pendingWarning);
        await journal.removeItem(candidate.at);
        continue;
      }
      target = candidate.at; dispatch = candidate.body; saved = candidate.saved;
    }
    // Old edit/void records had neither a timestamp nor a precondition. Never send those keys.
    const legacySlot = ifMatch === undefined ? null : await pendingSlot(workspace, profile, normalized);
    const legacy = legacySlot === null ? null : await journal.getItem(legacySlot);
    const record = readPendingRecord(saved ?? legacy), unresolved = saved ?? legacy;
    const reuse = !confirmation && saved !== null && record && isReplayFresh(record.createdAt, serverDate);
    if (confirmation && (unresolved === null || !confirmation.matches(target, unresolved))) throw new Error("Pending submission changed");
    if (!reuse && unresolved !== null && !confirmation) throw new PendingSubmissionExpired(target, unresolved);
    if (record?.body !== undefined && record.body !== dispatch) throw new InvalidDraft(pendingWarning);
    const key = reuse ? record.key : uuid(unresolved === null && initialKey ? initialKey : randomUUID());
    if (!key || (!reuse && key === (record?.key ?? uuid(unresolved)))) throw new TypeError("Invalid pending submission key");
    if (confirmation && target !== slot) {
      // Save the replacement before retiring the old slot, so a crash cannot lose both records.
      const replaces = await hash(JSON.stringify([target, saved]));
      await journal.setItem(slot, JSON.stringify({ key, createdAt: serverDate, clock: "server", body, replaces }));
      await journal.removeItem(target);
      target = slot; dispatch = body;
    } else if (!reuse || (dispatch !== undefined && record.body === undefined)) {
      await journal.setItem(target, JSON.stringify({ key, createdAt: reuse ? record.createdAt : serverDate, clock: "server", body: dispatch }));
    }
    const result = await operation(key, dispatch);
    if (legacySlot !== null && legacy !== null) await journal.removeItem(legacySlot);
    await journal.removeItem(target);
    return result;
  })();
  inFlight.set(slot, submit);
  try { return await submit; } finally { inFlight.delete(slot); }
}
