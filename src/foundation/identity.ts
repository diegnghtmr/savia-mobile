import { randomUUID } from "expo-crypto";
import { InvalidDraft, onboardingDraft, recoveryDraft, workspaceUnavailable } from "./identity-draft";
import { TransportError, type WithSession } from "./transport";
import { readProfileId, readWorkspaceContext, uuid } from "./workspace-context";

export function createIdentity(withSession: WithSession, newKey = randomUUID) {
  return {
    bootstrap: () => withSession(async (request) => {
      let profileId: string;
      try { profileId = await readProfileId(request); }
      catch (error) {
        if (error instanceof TransportError && error.kind === "http" && error.status === 404) return null;
        throw error;
      }
      return readWorkspaceContext(request, profileId);
    }),
    async onboard(input: unknown) {
      const body = onboardingDraft(input);
      return withSession(async (request) => {
        const result = await request("/v1/onboarding", { method: "POST", body, successStatus: [200, 201] }) as { profileId?: unknown; workspaceId?: unknown } | null;
        const expectedProfile = uuid(result?.profileId);
        const workspaceId = uuid(result?.workspaceId);
        if (!expectedProfile || !workspaceId || expectedProfile !== await readProfileId(request)) throw new Error("Invalid onboarding response");
        return readWorkspaceContext(request, expectedProfile, workspaceId);
      });
    },
    async select(selection: unknown) {
      const id = uuid(selection);
      if (!id) throw new InvalidDraft(workspaceUnavailable);
      return withSession(async (request) => readWorkspaceContext(request, await readProfileId(request), id));
    },
    recovery() {
      const keys = new Map<string, string>();
      return async (input: unknown) => {
        const body = recoveryDraft(input);
        return withSession(async (request) => {
          const profileId = await readProfileId(request);
          const context = await readWorkspaceContext(request, profileId);
          if (context.items.length) return context;
          const draft = JSON.stringify([profileId, body]);
          const idempotencyKey = keys.get(draft) ?? newKey();
          keys.set(draft, idempotencyKey);
          const result = await request("/v1/workspaces", { method: "POST", body, idempotencyKey, successStatus: 201 }) as { id?: unknown } | null;
          const workspaceId = uuid(result?.id);
          if (!workspaceId) throw new Error("Invalid workspace response");
          return readWorkspaceContext(request, profileId, workspaceId);
        });
      };
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;
