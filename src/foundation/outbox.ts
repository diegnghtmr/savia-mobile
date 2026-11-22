import { randomUUID } from "expo-crypto";
import type { ScopedRequest } from "./accounts";
import { workspaceUnavailable } from "./identity-draft";
import { creationReceipt } from "./ledger-create";
import { offlineMembership, purgeOfflineScope, type offlineStore } from "./offline-db";
import { OutboxQueued, PendingSubmissionExpired } from "./pending-expiry";
import { pendingSlot, pendingSubmission, readPendingRecord } from "./pending-submission";
import { secureStorage } from "./session-store";
import { isOfflineFailure, TransportError } from "./transport";
import { uuid } from "./workspace-context";

type Entry = { id: number; path: string; body: string; slot: string; legacy_slot: string | null; key: string; queued_at: number; record: string | null; issue: string | null };
const scope = "principal = ? AND profile = ? AND workspace = ?";
const normalize = (path: string, body: object) => JSON.stringify(["POST", path, body]);
const allowed = (path: string, body: object) => path === "/v1/transfers" || path === "/v1/currency-exchanges" ||
  (path === "/v1/transactions" && (("status" in body && body.status === "draft") ||
    ("type" in body && (body.type === "expense" || body.type === "income"))));

export function createOutbox(store: ReturnType<typeof offlineStore>, owner: () => Promise<string | null>, profile: string, workspace: string, request: ScopedRequest) {
  const forms = new WeakMap<object, { id: string; accepted: Set<string> }>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  const find = (principal: string, id: number) => store(async (db) => (await offlineMembership(db, principal, profile, workspace))?.active
    ? db.getFirstAsync<Entry>(`SELECT * FROM outbox WHERE ${scope} AND id = ?`, principal, profile, workspace, id) : null);
  const list = async () => {
    const principal = await owner();
    return principal ? store(async (db) => (await offlineMembership(db, principal, profile, workspace))?.active
      ? db.getAllAsync<Pick<Entry, "id" | "path" | "issue" | "queued_at">>(
        `SELECT id, path, issue, queued_at FROM outbox WHERE ${scope} ORDER BY id`, principal, profile, workspace) : []) : [];
  };
  let syncing: Promise<Map<number, string>> | undefined;
  async function run(confirmId?: number) {
    const receipts = new Map<number, string>(), principal = await owner();
    if (!principal) return receipts;
    for (;;) {
      const item = await store(async (db) => {
        const membership = await offlineMembership(db, principal, profile, workspace);
        if (!membership) await purgeOfflineScope(db, principal, profile, workspace).catch(() => { /* Retry on the next sync; never use these rows. */ });
        return membership?.active ? db.getFirstAsync<Entry>(`SELECT * FROM outbox WHERE ${scope} ORDER BY id LIMIT 1`, principal, profile, workspace) : null;
      });
      if (!item || (item.issue && (item.issue !== "expired" || item.id !== confirmId || item.record === null))) return receipts;
      const body = JSON.parse(item.body) as object;
      try {
        const value = await request(workspace, item.path, { method: "POST", body, successStatus: 201,
          submit: async (verified, operation, serverDate) => {
            if (profile !== verified || await owner() !== principal) throw new Error(workspaceUnavailable);
            return pendingSubmission(workspace, profile, normalize(item.path, body), async (key) => {
              if (await owner() !== principal || !await find(principal, item.id)) throw new Error(workspaceUnavailable);
              return creationReceipt(item.path, body, await operation(key));
            }, {
              serverDate, initialKey: item.key, journalSlot: item.slot,
              confirmation: item.issue === "expired" ? new PendingSubmissionExpired(item.slot, item.record!) : undefined,
              journal: {
                getItem: async () => (await find(principal, item.id))?.record ?? null,
                async setItem(_slot, record) {
                  const updated = await store((db) => db.runAsync(`UPDATE outbox SET key = ?, record = ?, issue = NULL WHERE ${scope} AND id = ?`,
                    readPendingRecord(record)!.key, record, principal, profile, workspace, item.id));
                  if (updated.changes !== 1) throw new Error(workspaceUnavailable);
                },
                async removeItem() {
                  if (item.legacy_slot && await secureStorage.getItem(item.legacy_slot) !== null) await secureStorage.removeItem(item.legacy_slot);
                  await store((db) => db.runAsync(`DELETE FROM outbox WHERE ${scope} AND id = ?`, principal, profile, workspace, item.id));
                },
              },
            });
          },
        });
        const id = uuid(value);
        if (!id) throw new TypeError();
        receipts.set(item.id, id);
      } catch (error) {
        if (!isOfflineFailure(error)) {
          const status = error instanceof TransportError ? error.status : undefined;
          const issue = error instanceof PendingSubmissionExpired ? "expired" : status && [409, 412, 422].includes(status) ? String(status) : "failed";
          await store((db) => db.runAsync(`UPDATE outbox SET issue = ? WHERE ${scope} AND id = ?`, issue, principal, profile, workspace, item.id));
        }
        return receipts;
      }
    }
  }
  function drain(id?: number) {
    return syncing ??= run(id).finally(() => { syncing = undefined; changed(); });
  }
  const queued: ScopedRequest = async (expected, path, options) => {
    const body = options?.body;
    if (expected !== workspace || options?.method !== "POST" || !options.submit || !body || typeof body !== "object" || !allowed(path, body)) return request(expected, path, options);
    const principal = await owner();
    if (!principal) throw new Error(workspaceUnavailable);
    const form = options.form;
    let attempt = form ? forms.get(form) : undefined;
    if (!attempt) {
      attempt = { id: randomUUID(), accepted: new Set() };
      if (form) forms.set(form, attempt);
    }
    const command = normalize(path, body), legacy = await pendingSlot(workspace, profile, command);
    const slot = await pendingSlot(workspace, profile, JSON.stringify(["outbox", attempt.id, command]));
    const id = await store(async (db) => {
      if (!(await offlineMembership(db, principal, profile, workspace))?.active) throw new Error(workspaceUnavailable);
      const existing = await db.getFirstAsync<{ id: number }>(`SELECT id FROM outbox WHERE ${scope} AND slot = ?`, principal, profile, workspace, slot);
      if (existing || attempt.accepted.has(slot)) return existing?.id;
      const claimed = await db.getFirstAsync(`SELECT id FROM outbox WHERE ${scope} AND legacy_slot = ?`, principal, profile, workspace, legacy);
      const record = claimed ? null : await secureStorage.getItem(legacy);
      const key = readPendingRecord(record)?.key ?? uuid(record) ?? randomUUID();
      const saved = await db.runAsync(`INSERT INTO outbox (principal, profile, workspace, path, body, slot, key, queued_at, record, legacy_slot)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM membership WHERE principal = ? AND profile = ? AND json_extract(snapshot, '$.active.id') = ?`,
        principal, profile, workspace, path, JSON.stringify(body), slot, key, Date.now(), record, record === null ? null : legacy, principal, profile, workspace);
      if (saved.changes !== 1) throw new Error(workspaceUnavailable);
      attempt.accepted.add(slot);
      return (await db.getFirstAsync<{ id: number }>(`SELECT id FROM outbox WHERE ${scope} AND slot = ?`, principal, profile, workspace, slot))?.id;
    });
    if (!id) throw new OutboxQueued(null);
    changed();
    const result = (await drain()).get(id);
    if (result) return result;
    const entry = await find(principal, id);
    if (!entry) throw new Error(workspaceUnavailable);
    throw new OutboxQueued(entry.issue);
  };
  return {
    request: queued, list,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async sync(confirmed?: number) {
      if (confirmed !== undefined && syncing) await syncing;
      await drain(confirmed);
    },
    async discard(id: number) {
      if (syncing) await syncing;
      const principal = await owner();
      if (principal) await store(async (db) => {
        if ((await offlineMembership(db, principal, profile, workspace))?.active) await db.runAsync(
          `DELETE FROM outbox WHERE ${scope} AND id = ? AND issue IS NOT NULL`, principal, profile, workspace, id);
      });
      changed();
    },
  };
}
export type Outbox = ReturnType<typeof createOutbox>;
