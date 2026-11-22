import type { ScopedRequest } from "./accounts";
import type { Identity } from "./identity";
import { workspaceUnavailable } from "./identity-draft";
import { atomic, nextOfflineSequence, OfflineStorageUnavailable, offlineStore, purgeOfflineScope, revokedAfter } from "./offline-db";
import { createOutbox } from "./outbox";
import { isOfflineFailure } from "./transport";
import { WorkspaceSelectionUnavailable, type WorkspaceContext } from "./workspace-context";

const cacheable = /^\/v1\/(?:accounts(?:\/[a-f\d-]{36}(?:\/balance)?)?|transactions(?:\/[a-f\d-]{36})?|budgets(?:\/[a-f\d-]{36})?|funds|debts(?:\/[a-f\d-]{36}\/projection)?|analytics\/(?:summary|cash-flow|advanced)|subscriptions|categories|payees|tags)(?:\?|$)/i;
const optional = <T>(operation: Promise<T>) => operation.catch(() => null);

export function createOffline(identity: Identity, principal: () => Promise<string | null>) {
  const store = offlineStore();
  let epoch = 0;
  const snapshot = (owner: string) => store(async (db) => {
    const row = await db.getFirstAsync<{ snapshot: string }>("SELECT snapshot FROM membership WHERE principal = ?", owner);
    return row ? JSON.parse(row.snapshot) as WorkspaceContext : null;
  });
  const stamp = () => store(nextOfflineSequence).catch((error: unknown) => {
    if (error instanceof OfflineStorageUnavailable) return null;
    throw error;
  });
  const remember = (owner: string, fresh: WorkspaceContext | null, ticket: number, started?: number, expected?: string, keepActive = false) => store(async (db) => {
    if (ticket !== epoch) throw new Error(workspaceUnavailable);
    const publish = async (value: WorkspaceContext | null) => {
      if (value) await db.runAsync("INSERT OR REPLACE INTO membership VALUES (?, ?, ?)", owner, value.profileId, JSON.stringify(value));
      else await db.runAsync("DELETE FROM membership WHERE principal = ?", owner);
    };
    const row = await db.getFirstAsync<{ snapshot: string }>("SELECT snapshot FROM membership WHERE principal = ?", owner);
    const before = row ? JSON.parse(row.snapshot) as WorkspaceContext : null;
    const fenced = started === undefined ? [] : await db.getAllAsync<{ profile: string; workspace: string }>(
      "SELECT profile, workspace FROM revocations WHERE principal = ? AND sequence > ?", owner, started);
    const protectedScopes = fenced.filter((scope) => scope.profile === fresh?.profileId || scope.profile === before?.profileId);
    if (protectedScopes.some(({ workspace }) => expected === undefined || workspace === expected)) throw new Error(workspaceUnavailable);
    // An old response for an unaffected workspace cannot change the membership of a fenced workspace.
    const protectedInProfile = (id: string) => fenced.some((scope) => scope.profile === fresh?.profileId && scope.workspace === id);
    const context = fresh && { ...fresh, items: [...fresh.items.filter(({ id }) => !protectedInProfile(id)),
      ...(before?.profileId === fresh.profileId ? before.items.filter(({ id }) => protectedInProfile(id)) : [])] };
    const stillAllowed = before?.profileId === context?.profileId
      ? context?.items.filter(({ id }) => before?.items.some((item) => item.id === id)) ?? [] : [];
    const lost = before?.items.filter(({ id }) => !stillAllowed.some((item) => item.id === id))
      .map(({ id }) => ({ profile: before.profileId, workspace: id })) ?? [];
    if (expected && context && !context.items.some(({ id }) => id === expected) &&
      !lost.some(({ profile, workspace }) => profile === context.profileId && workspace === expected)) lost.push({ profile: context.profileId, workspace: expected });
    // Fence all already-started requests and publish revocation atomically, before fallible deletion.
    if (lost.length) await atomic(db, async () => {
      const sequence = await nextOfflineSequence(db);
      for (const { profile, workspace } of lost) await db.runAsync("INSERT OR REPLACE INTO revocations VALUES (?, ?, ?, ?)", owner, profile, workspace, sequence);
      if (before) await publish({ ...before, items: stillAllowed, active: stillAllowed.find(({ id }) => id === before.active?.id) ?? null });
    });
    const stale = await db.getAllAsync<{ profile: string; workspace: string }>(
      `SELECT profile, workspace FROM cache WHERE principal = ? UNION SELECT profile, workspace FROM outbox WHERE principal = ?`, owner, owner);
    const failed: { profile: string; workspace: string; cause: unknown }[] = [];
    for (const scope of stale) {
      if (scope.profile === context?.profileId && stillAllowed.some(({ id }) => id === scope.workspace)) continue;
      try { await purgeOfflineScope(db, owner, scope.profile, scope.workspace); }
      catch (cause) { failed.push({ ...scope, cause }); }
    }
    const items = context?.items.filter(({ id }) => !failed.some((scope) => scope.profile === context.profileId && scope.workspace === id));
    const selected = keepActive && before?.profileId === context?.profileId ? before?.active : context?.active;
    const active = items?.find(({ id }) => id === selected?.id) ?? null;
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
    const ticket = epoch, owner = await optional(principal()), started = owner ? await stamp() : null;
    const current = async () => owner !== null && ticket === epoch && await optional(principal()) === owner;
    try {
      const context = await operation();
      if (owner && started !== null && await current()) await remember(owner, context, ticket, started);
      return context;
    } catch (error) {
      if (error instanceof WorkspaceSelectionUnavailable && owner && started !== null && await current()) {
        await remember(owner, error.context, ticket, started, error.selection, true);
      }
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
        const owner = await optional(principal()), started = owner ? await stamp() : null;
        const key = `${options?.includeETag ? "etag:" : ""}${path}`;
        const read = (options?.method ?? "GET") === "GET" && cacheable.test(path);
        const current = async () => owner !== null && ticket === epoch && await optional(principal()) === owner;
        try {
          const payload = await request(workspace, path, { ...options, expectedProfile: profile, onMembership: async (context) => {
            if (ticket !== epoch || (owner && !await current())) throw new Error(workspaceUnavailable);
            if (owner && started !== null) await remember(owner, context, ticket, started, workspace);
            await options?.onMembership?.(context);
          } });
          if (ticket !== epoch || (owner && !await current())) throw new Error(workspaceUnavailable);
          if (owner && started !== null) await store(async (db) => {
            if (ticket !== epoch || await revokedAfter(db, owner, profile, workspace, started)) throw new Error(workspaceUnavailable);
            if (!read) return;
            await optional(db.runAsync(`INSERT OR REPLACE INTO cache SELECT ?, ?, ?, ?, ?, ? FROM membership
              WHERE principal = ? AND profile = ? AND json_extract(snapshot, '$.active.id') = ?`, owner, profile, workspace, key,
              JSON.stringify(payload), Date.now(), owner, profile, workspace));
            await optional(db.runAsync(`DELETE FROM cache WHERE rowid IN (SELECT rowid FROM cache WHERE principal = ? AND profile = ? AND workspace = ?
              ORDER BY saved_at DESC, rowid DESC LIMIT -1 OFFSET 100)`, owner, profile, workspace));
          });
          if (read) onFresh?.();
          return payload;
        } catch (error) {
          if (owner && started !== null && read && isOfflineFailure(error) && await current()) {
            const row = await optional(store(async (db) => {
              if (await revokedAfter(db, owner, profile, workspace, started)) return null;
              return db.getFirstAsync<{ payload: string; saved_at: number }>(
                `SELECT cache.payload, cache.saved_at FROM cache JOIN membership USING (principal, profile)
                 WHERE principal = ? AND profile = ? AND workspace = ? AND path = ? AND json_extract(snapshot, '$.active.id') = ?`,
                owner, profile, workspace, key, workspace);
            }));
            if (row && await current()) { onSnapshot(row.saved_at); return JSON.parse(row.payload) as unknown; }
          }
          throw error;
        }
      };
    },
  };
}
