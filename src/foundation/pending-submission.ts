import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { secureStorage } from "./session-store";
import { uuid } from "./workspace-context";

const inFlight = new Map<string, Promise<unknown>>();

export async function pendingSubmission(workspace: string, profile: string, normalized: string, operation: (key: string) => Promise<unknown>) {
  const hash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, normalized);
  const slot = `savia.ledger.v1.${workspace}.${profile}.${hash}`;
  const current = inFlight.get(slot);
  if (current) return current;
  const submit = (async () => {
    const saved = await secureStorage.getItem(slot);
    const key = uuid(saved ?? randomUUID());
    if (!key) throw new TypeError("Invalid pending submission key");
    if (saved === null) await secureStorage.setItem(slot, key);
    const result = await operation(key);
    await secureStorage.removeItem(slot);
    return result;
  })();
  inFlight.set(slot, submit);
  try { return await submit; } finally { inFlight.delete(slot); }
}
