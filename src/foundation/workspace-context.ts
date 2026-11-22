import { workspaceUnavailable } from "./identity-draft";
import { secureStorage } from "./session-store";
import type { SaviaRequest } from "./transport";

export type Workspace = { id: string; name: string };
export type WorkspaceContext = { profileId: string; active: Workspace | null; items: Workspace[] };
const endpoint = "/v1/workspaces";
const slot = (profileId: string) => `savia.workspace.${profileId}`;
export const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;

export async function readProfileId(request: SaviaRequest) {
  const result = await request("/v1/me", { successStatus: 200 }) as { id?: unknown } | null;
  const id = uuid(result?.id);
  if (!id) throw new Error("Invalid profile response");
  return id;
}

export async function readWorkspaceContext(request: SaviaRequest, profileId: string, select?: string): Promise<WorkspaceContext> {
  const workspaces = new Map<string, Workspace>();
  const cursors = new Set<string>();
  let path = endpoint;
  for (;;) {
    const result = await request(path, { successStatus: 200 }) as { items?: unknown; pageInfo?: { hasNextPage?: unknown; nextCursor?: unknown } } | null;
    if (!Array.isArray(result?.items) || typeof result.pageInfo?.hasNextPage !== "boolean") throw new Error("Invalid workspace page");
    for (const item of result.items) {
      const id = uuid(item?.id);
      if (!id || workspaces.has(id) || typeof item?.name !== "string" || !item.name.trim()) throw new Error("Ambiguous or invalid workspace list");
      workspaces.set(id, { id, name: item.name });
    }
    if (!result.pageInfo.hasNextPage) break;
    const cursor = result.pageInfo.nextCursor;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error("Invalid workspace cursor");
    cursors.add(cursor);
    path = `${endpoint}?cursor=${encodeURIComponent(cursor)}`;
  }
  const saved = select ?? uuid(await secureStorage.getItem(slot(profileId)));
  const active = saved ? workspaces.get(saved) ?? null : null;
  if (select !== undefined) {
    if (!active) throw new Error(workspaceUnavailable);
    await secureStorage.setItem(slot(profileId), active.id);
  }
  return { profileId, active, items: [...workspaces.values()] };
}
