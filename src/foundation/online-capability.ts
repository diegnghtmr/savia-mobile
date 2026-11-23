import type { ScopedRequest } from "./accounts";
import { InvalidDraft, workspaceUnavailable } from "./identity-draft";
import { TransportError } from "./transport";

type Options = NonNullable<Parameters<ScopedRequest>[2]>;
export function onlineCapability(request: ScopedRequest, workspace: string) {
  return async (path: string, options: Options, unavailable: string, missing = [404, 501]) => {
    if (!workspace) throw new InvalidDraft(workspaceUnavailable);
    let verified = false;
    try {
      return await request(workspace, path, { ...options, onMembership: async (context) => {
        verified = context.active?.id === workspace;
        await options.onMembership?.(context);
      } });
    } catch (error) {
      if (verified && error instanceof TransportError && error.kind === "http" && missing.includes(error.status ?? 0)) throw new InvalidDraft(unavailable);
      throw error;
    }
  };
}
