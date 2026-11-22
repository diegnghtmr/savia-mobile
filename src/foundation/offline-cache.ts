import type { ScopedRequest } from "./accounts";
import type { Identity } from "./identity";
import { workspaceUnavailable } from "./identity-draft";
import { atomic, offlineStore } from "./offline-db";
import { createOutbox } from "./outbox";
import { isOfflineFailure } from "./transport";
import type { WorkspaceContext } from "./workspace-context";

const cacheable = /^\/v1\/(?:accounts(?:\/[a-f\d-]{36}(?:\/balance)?)?|transactions(?:\/[a-f\d-]{36})?|categories|payees|tags)(?:\?|$)/i;
const optional = <T>(operation: Promise<T>) => operation.catch(() => null);

export function createOffline(identity: Identity, principal: () => Promise<string | null>) {
  const store = offlineStore();
  let epoch = 0;
  const snapshot = (owner: string) => store(async (db) => {
    const row = await db.getFirstAsync<{ snapshot: string }>("SELECT snapshot FROM membership WHERE principal = ?", owner);
    return row ? JSON.parse(row.snapshot) as WorkspaceContext : null;
  });
  const remember = (owner: string, context: WorkspaceContext | null, ticket: number) => optional(store(async (db) => {
    if (ticket !== epoch) return;
    await atomic(db, async () => {
      for (const table of ["cache", "outbox"]) await db.runAsync(
        `DELETE FROM ${table} WHERE principal = ? AND (profile <> ? OR workspace NOT IN (SELECT value FROM json_each(?)))`,
        owner, context?.profileId ?? "", JSON.stringify(context?.items.map(({ id }) => id) ?? []));
      if (context) await db.runAsync("INSERT OR REPLACE INTO membership VALUES (?, ?, ?)", owner, context.profileId, JSON.stringify(context));
      else await db.runAsync("DELETE FROM membership WHERE principal = ?", owner);
    });
  }));
  async function verified<T extends WorkspaceContext | null>(operation: () => Promise<T>, fallback = false): Promise<T> {
    const ticket = epoch, owner = await optional(principal());
    const current = async () => owner !== null && ticket === epoch && await optional(principal()) === owner;
    try {
      const context = await operation();
      if (owner && await current()) await remember(owner, context, ticket);
      return context;
    } catch (error) {
      if (owner && fallback && isOfflineFailure(error) && await current()) {
        const saved = await optional(snapshot(owner));
        if (saved?.active && await current()) return saved as T;
      }
      throw error;
    }
  }
  return {
    outbox(profile: string, workspace: string, request: ScopedRequest) {
      const ticket = epoch;
      return createOutbox(store, async () => ticket === epoch ? optional(principal()) : null, profile, workspace, request);
    },
    identity: {
      bootstrap: () => verified(identity.bootstrap, true),
      select: (id: unknown) => verified(() => identity.select(id)),
      onboard: (input: unknown) => verified(() => identity.onboard(input)),
      recovery: () => { const recover = identity.recovery(); return (input: unknown) => verified(() => recover(input)); },
    },
    async beforeSignOut() {
      ++epoch;
      const owner = await optional(principal());
      await optional(store((db) => atomic(db, async () => {
        for (const table of ["cache", "outbox", "membership"]) {
          if (owner) await db.runAsync(`DELETE FROM ${table} WHERE principal = ?`, owner);
          else await db.runAsync(`DELETE FROM ${table}`);
        }
      })));
    },
    scope(profile: string, workspace: string, request: ScopedRequest, onSnapshot: (at: number) => void): ScopedRequest {
      const ticket = epoch;
      return async (expected, path, options) => {
        if (ticket !== epoch || expected !== workspace) throw new Error(workspaceUnavailable);
        const owner = await optional(principal());
        const key = `${options?.includeETag ? "etag:" : ""}${path}`;
        const read = (options?.method ?? "GET") === "GET" && cacheable.test(path);
        const current = async () => owner !== null && ticket === epoch && await optional(principal()) === owner;
        try {
          const payload = await request(workspace, path, { ...options, expectedProfile: profile, onMembership: async (context) => {
            if (owner && await current()) await remember(owner, context, ticket);
            if (ticket !== epoch) throw new Error(workspaceUnavailable);
          } });
          if (owner && read && await current()) await optional(store(async (db) => {
            if (ticket !== epoch) return;
            await db.runAsync(`INSERT OR REPLACE INTO cache SELECT ?, ?, ?, ?, ?, ? FROM membership
              WHERE principal = ? AND profile = ? AND json_extract(snapshot, '$.active.id') = ?`, owner, profile, workspace, key,
              JSON.stringify(payload), Date.now(), owner, profile, workspace);
            await db.runAsync(`DELETE FROM cache WHERE rowid IN (SELECT rowid FROM cache WHERE principal = ? AND profile = ? AND workspace = ?
              ORDER BY saved_at DESC, rowid DESC LIMIT -1 OFFSET 100)`, owner, profile, workspace);
          }));
          return payload;
        } catch (error) {
          if (owner && read && isOfflineFailure(error) && await current()) {
            const row = await optional(store((db) => db.getFirstAsync<{ payload: string; saved_at: number }>(
              `SELECT cache.payload, cache.saved_at FROM cache JOIN membership USING (principal, profile)
               WHERE principal = ? AND profile = ? AND workspace = ? AND path = ? AND json_extract(snapshot, '$.active.id') = ?`,
              owner, profile, workspace, key, workspace)));
            if (row && await current()) { onSnapshot(row.saved_at); return JSON.parse(row.payload) as unknown; }
          }
          throw error;
        }
      };
    },
  };
}
