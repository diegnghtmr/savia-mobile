import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import { uuid } from "./workspace-context";

const endpoint = "/v1/me/sessions", unavailable = "Esta función no está disponible en este servidor.";
const timestamp = (value: unknown) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError();
  return new Date(value).toISOString();
};
function session(input: unknown) {
  const { id: raw, createdAt, lastActiveAt, userAgent, current } = fundRecord(input), id = uuid(raw);
  if (!id || typeof current !== "boolean" || (userAgent !== undefined && typeof userAgent !== "string")) throw new TypeError();
  return { id, current, userAgent: userAgent?.slice(0, 300), createdAt: timestamp(createdAt), lastActiveAt: timestamp(lastActiveAt) };
}
export function createSessions(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope);
  const rows = new Map<string, ReturnType<typeof session>>(), visited = new Set<string>();
  let next: string | null = null;
  const subject = { subjectResource: true, onlineOnly: true } as const;
  return {
    async list(cursor?: string) {
      if (cursor !== undefined && cursor !== next) throw new InvalidDraft("Página de sesiones no válida.");
      if (!cursor) { rows.clear(); visited.clear(); next = null; }
      const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor", cursor);
      const { items, pageInfo } = fundRecord(await call(`${endpoint}?${query}`, { ...subject, successStatus: 200 }, unavailable));
      const { hasNextPage, nextCursor } = fundRecord(pageInfo);
      if (!Array.isArray(items) || items.length > 20 || typeof hasNextPage !== "boolean" || (hasNextPage ?
        typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 2048 || visited.has(nextCursor) || !items.length : nextCursor !== null)) throw new TypeError();
      const page = items.map(session);
      if (new Set(page.map(({ id }) => id)).size !== page.length || page.some(({ id }) => rows.has(id)) ||
        [...rows.values(), ...page].filter(({ current }) => current).length > 1) throw new TypeError();
      for (const row of page) rows.set(row.id, row);
      next = hasNextPage && typeof nextCursor === "string" ? nextCursor : null;
      if (next) visited.add(next);
      return { items: [...rows.values()], next };
    },
    async closeOthers() {
      await call(`${endpoint}/revoke-others`, { ...subject, method: "POST", successStatus: 204 }, unavailable);
    },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
