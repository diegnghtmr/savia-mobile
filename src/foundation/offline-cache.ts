import type { ScopedRequest } from "./accounts";
import type { Identity } from "./identity";
import { workspaceUnavailable } from "./identity-draft";
import { OfflineStorageUnavailable, offlineStore, purgeOfflineScope } from "./offline-db";
import { createOutbox } from "./outbox";
import { isOfflineFailure } from "./transport";
import type { WorkspaceContext } from "./workspace-context";

const cacheable = /^\/v1\/(?:accounts(?:\/[a-f\d-]{36}(?:\/balance)?)?|transactions(?:\/[a-f\d-]{36})?|budgets(?:\/[a-f\d-]{36})?|funds|categories|payees|tags)(?:\?|$)/i;
const optional = <T>(operation: Promise<T>) => operation.catch(() => null);

export function createOffline(identity: Identity, principal: () => Promise<string | null>) {
  const store = offlineStore();
  let epoch = 0;
  const snapshot = (owner: string) => store(async (db) => {
    const row = await db.getFirstAsync<{ snapshot: string }>("SELECT snapshot FROM membership WHERE principal = ?", owner);
    return row ? JSON.parse(row.snapshot) as WorkspaceContext : null;
  });
  const remember = (owner: string, context: WorkspaceContext | null, ticket: number, expected?: string) => store(async (db) => {
    if (ticket !== epoch) return;
    const publish = async (value: WorkspaceContext | null) => {
      if (value) await db.runAsync("INSERT OR REPLACE INTO membership VALUES (?, ?, ?)", owner, value.profileId, JSON.stringify(value));
      else await db.runAsync("DELETE FROM membership WHERE principal = ?", owner);
    };
    const row = await db.getFirstAsync<{ snapshot: string }>("SELECT snapshot FROM membership WHERE principal = ?", owner);
    const before = row ? JSON.parse(row.snapshot) as WorkspaceContext : null;
    const stillAllowed = before?.profileId === context?.profileId
      ? context?.items.filter(({ id }) => before?.items.some((item) => item.id === id)) ?? [] : [];
    // Commit revocation before any fallible purge. A regrant cannot reactivate old rows until their purge succeeds.
    if (before && stillAllowed.length < before.items.length) await publish({ ...before, items: stillAllowed,
      active: stillAllowed.find(({ id }) => id === before.active?.id) ?? null });
    const stale = await db.getAllAsync<{ profile: string; workspace: string }>(
      `SELECT profile, workspace FROM cache WHERE principal = ? UNION SELECT profile, workspace FROM outbox WHERE principal = ?`, owner, owner);
    const failed: { profile: string; workspace: string; cause: unknown }[] = [];
    for (const scope of stale) {
      if (scope.profile === context?.profileId && stillAllowed.some(({ id }) => id === scope.workspace)) continue;
      try { await purgeOfflineScope(db, owner, scope.profile, scope.workspace); }
      catch (cause) { failed.push({ ...scope, cause }); }
    }
    const items = context?.items.filter(({ id }) => !failed.some((scope) => scope.profile === context.profileId && scope.workspace === id));
    const active = items?.find(({ id }) => id === context?.active?.id) ?? null;
    await publish(context && { ...context, items: items!, active });
    const affected = expected ?? context?.active?.id;
    const failure = failed.find(({ workspace }) => workspace === affected);
    if (failure) throw new Error(workspaceUnavailable, { cause: failure.cause });
    if (!context && failed.length) throw new AggregateError(failed.map(({ cause }) => cause), "No pudimos borrar los datos sin conexión.");
  }).catch((error: unknown) => {
    if (error instanceof OfflineStorageUnavailable) return;
    throw error;
  });
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
    async signOut(operation: () => Promise<void>) {
      const owner = await optional(principal());
      await operation();
      ++epoch;
      await remember(owner ?? "", null, epoch);
    },
    scope(profile: string, workspace: string, request: ScopedRequest, onSnapshot: (at: number) => void, onFresh?: () => void): ScopedRequest {
      const ticket = epoch;
      return async (expected, path, options) => {
        if (ticket !== epoch || expected !== workspace) throw new Error(workspaceUnavailable);
        const owner = await optional(principal());
        const key = `${options?.includeETag ? "etag:" : ""}${path}`;
        const read = (options?.method ?? "GET") === "GET" && cacheable.test(path);
        const current = async () => owner !== null && ticket === epoch && await optional(principal()) === owner;
        try {
          const payload = await request(workspace, path, { ...options, expectedProfile: profile, onMembership: async (context) => {
            if (owner && await current()) await remember(owner, context, ticket, workspace);
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
          if (read && ticket === epoch) onFresh?.();
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
