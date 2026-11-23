import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { memoryPendingJournal, pendingSubmission } from "./pending-submission";
import { uuid } from "./workspace-context";

const path = "/v1/ai/credentials", unavailable = "Credenciales de IA no disponibles.";
const creatable = ["api_key", "service_account", "access_token", "gateway_token", "local_endpoint"];
const providerName = /^[a-z0-9][a-z0-9-]*$/;
type Owner = "user" | "workspace";
type ProviderChoice = { providerId: string; name: string; credentialType: string };
const bounded = (s: unknown, max: number): s is string => typeof s === "string" && [...s].length <= max && !/[\x00-\x1f\x7f]/.test(s);
function provider(raw: unknown) {
  const { providerId, displayName, enabled, policyStatus, credentialTypes } = fundRecord(raw);
  if (!bounded(providerId, 80) || !providerName.test(providerId) || !bounded(displayName, 120) || !Array.isArray(credentialTypes)) throw new TypeError();
  if (enabled !== true || (policyStatus !== "approved" && policyStatus !== "restricted")) return [];
  return creatable.filter((type) => credentialTypes.includes(type)).map((credentialType) => ({ providerId, name: displayName, credentialType }));
}
function credential(raw: unknown, profile: string) {
  const { id: value, providerId, ownerType, ownerSubjectId, credentialType, maskedIdentifier, alias, status, version } = fundRecord(raw), id = uuid(value);
  if (ownerType === "user" && uuid(ownerSubjectId) !== profile) return null;
  if (!id || !bounded(providerId, 80) || !providerName.test(providerId) || (ownerType !== "user" && (ownerType !== "workspace" || ownerSubjectId !== null)) ||
    !bounded(credentialType, 32) || ![...creatable, "oauth"].includes(credentialType) || (status !== "active" && status !== "disabled" && status !== "revoked")) throw new TypeError();
  const mask = typeof maskedIdentifier === "string" && /^[•*]{4}[A-Za-z0-9_-]{0,4}$/.test(maskedIdentifier) ? maskedIdentifier : "••••";
  const tag = typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? `"${version}"` : null;
  return { id, providerId, ownerType, credentialType, status, mask, alias: bounded(alias, 120) ? alias : null, tag } as const;
}
export type Credential = NonNullable<ReturnType<typeof credential>>;
function aliasFrom(value: string) {
  if (!bounded(value, 120)) throw new InvalidDraft("El alias debe tener hasta 120 caracteres.");
  return value.trim() || null;
}
function checkSecret(input: string) {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) throw new InvalidDraft("Ingresa un secreto válido.");
  return input;
}
function parseMetadata(draft: string) {
  try {
    const value = fundRecord(JSON.parse(draft));
    if (Object.entries(value).some(([k, v]) => typeof v !== "string" || ["__proto__", "prototype", "constructor"].includes(k))) throw new TypeError();
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  } catch { throw new InvalidDraft("Usa un objeto JSON con valores de texto para los metadatos."); }
}

export function createAICredentials(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope);
  let choices: ProviderChoice[] = [], rows: Credential[] = [];
  // Secrets and secret-derived fingerprints stay in this view's memory. Reopen by reviewing the list, not by restoring a secret draft.
  const journal = memoryPendingJournal();
  function write<T>(method: "POST" | "PATCH" | "DELETE" | "PUT", route: string, body: object | undefined, status: number,
    parse: (result: unknown, profile: string) => T, confirmation?: PendingSubmissionExpired, ifMatch?: string) {
    return call(route, { method, body, ifMatch, successStatus: status,
      submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, route, body]),
        async (key) => parse(await operation(key), profile), { serverDate, confirmation, ifMatch, journal: method === "POST" || method === "PATCH" ? journal : undefined }),
    }, unavailable, route.startsWith(`${path}/`) ? [501] : undefined) as Promise<T>;
  }
  function updateRows(raw: unknown, profile: string, id?: string) {
    const row = credential(raw, profile);
    if (!row || (id && row.id !== id)) throw new TypeError();
    rows = [...rows.filter((previous) => previous.id !== row.id), row];
    return rows;
  }
  return {
    async load() {
      choices = []; rows = [];
      let profile = "";
      const [providers, list] = await Promise.all([
        call("/v1/ai/providers", { successStatus: 200 }, unavailable),
        call(path, { successStatus: 200, onMembership: async (context) => { profile = context.profileId; } }, unavailable),
      ]);
      if (!Array.isArray(providers) || !Array.isArray(list) || !profile) throw new TypeError();
      const parsed = list.map((row) => credential(row, profile)).filter((row): row is Credential => !!row && row.status !== "revoked");
      if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) throw new TypeError();
      choices = providers.flatMap(provider); rows = parsed;
      return { choices, rows };
    },
    add(choice: ProviderChoice | undefined, ownerType: Owner, secret: string, alias: string, metadata: string, confirm?: PendingSubmissionExpired) {
      if (!choice || !choices.includes(choice) || (ownerType !== "user" && ownerType !== "workspace")) throw new InvalidDraft("Elige un proveedor y tipo de credencial disponibles.");
      const { providerId, credentialType } = choice, label = aliasFrom(alias);
      const body = { providerId, credentialType, ownerType, secret: checkSecret(secret), ...(label ? { alias: label } : {}),
        ...(metadata.trim() ? { metadata: parseMetadata(metadata) } : {}) };
      return write("POST", path, body, 201, updateRows, confirm);
    },
    edit(row: Credential, alias: string, status: "active" | "disabled", secret: string, confirm?: PendingSubmissionExpired) {
      if (!rows.includes(row) || !row.tag || (status !== "active" && status !== "disabled")) throw new InvalidDraft("Vuelve a cargar la credencial antes de editarla.");
      const label = aliasFrom(alias), body = { ...(label !== row.alias ? { alias: label } : {}), ...(status !== row.status ? { status } : {}),
        ...(secret !== "" ? { replacementSecret: checkSecret(secret) } : {}) };
      if (!Object.keys(body).length) throw new InvalidDraft("No hay cambios para guardar.");
      return write("PATCH", `${path}/${row.id}`, body, 200, (raw, profile) => updateRows(raw, profile, row.id), confirm, row.tag);
    },
    remove(row: Credential, confirm?: PendingSubmissionExpired) {
      if (!rows.includes(row)) throw new InvalidDraft("Vuelve a cargar la credencial antes de revocarla.");
      return write("DELETE", `${path}/${row.id}`, undefined, 204, () => rows = rows.filter(({ id }) => id !== row.id), confirm);
    },
    setDefault(model: string, row: Credential | undefined, confirm?: PendingSubmissionExpired) {
      const modelRef = model.trim();
      if (!bounded(modelRef, 256) || !/^[a-z0-9][a-z0-9-]*:.+$/.test(modelRef)) throw new InvalidDraft("Ingresa un modelo como proveedor:modelo.");
      if (row && (!rows.includes(row) || row.ownerType !== "workspace" || row.status !== "active" || row.providerId !== modelRef.split(":", 1)[0])) {
        throw new InvalidDraft("Elige una credencial activa del espacio para ese proveedor.");
      }
      return write("PUT", "/v1/ai/default-model", { modelRef, credentialId: row?.id ?? null }, 204, () => {}, confirm);
    },
  };
}
export type AICredentials = ReturnType<typeof createAICredentials>;
