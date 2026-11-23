import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft, workspaceUnavailable } from "./identity-draft";
import { onlineCapability } from "./online-capability";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { TransportError } from "./transport";
import { uuid } from "./workspace-context";

export const categoryKinds = { income: "Ingreso", expense: "Gasto", transfer: "Transferencia", other: "Otra" } as const;
export const catalogLabels = {
  categories: { form: "Nueva categoría", create: "Crear categoría", saved: "Categoría creada.", duplicate: "Ya existe una categoría con ese nombre en este espacio." },
  payees: { form: "Nueva contraparte", create: "Crear contraparte", saved: "Contraparte creada.", duplicate: "Ya existe una contraparte con ese nombre en este espacio." },
  tags: { form: "Nueva etiqueta", create: "Crear etiqueta", saved: "Etiqueta creada.", duplicate: "Ya existe una etiqueta con ese nombre en este espacio." },
} as const;
export type Catalog = keyof typeof catalogLabels;

function parseDraft(catalog: Catalog, input: unknown): { name: string; kind?: string; essential?: true } {
  const category = catalog === "categories";
  try {
    const draft = fundRecord(input), fields = category ? ["name", "kind", "essential"] : ["name"];
    if (!Object.hasOwn(catalogLabels, catalog) || Object.keys(draft).some((key) => !fields.includes(key)) ||
      typeof draft.name !== "string" || draft.name.includes("\0")) throw new TypeError();
    const name = draft.name.trim();
    if (!name || [...name].length > 120) throw new TypeError();
    if (!category) return { name };
    const { kind, essential } = draft;
    if (typeof kind !== "string" || !Object.hasOwn(categoryKinds, kind) || (Object.hasOwn(draft, "essential") && typeof essential !== "boolean")) throw new TypeError();
    return { name, kind, ...(essential === true && { essential }) };
  } catch { throw new InvalidDraft(category ? "Revisa el nombre y el tipo de la categoría." : "Revisa el nombre (de 1 a 120 caracteres)."); }
}

export function createCatalogWrites(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = onlineCapability(request, scope);
  return { async create(catalog: Catalog, input: unknown, confirmation?: PendingSubmissionExpired) {
    const body = parseDraft(catalog, input), path = `/v1/${catalog}`, method = "POST";
    try {
      const result = await call(path, { method, body, successStatus: 201, onlineOnly: true,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, path, body]), async (key) => {
          const response = await operation(key).catch((error: unknown) => {
            if (error instanceof TransportError && error.kind === "http" && error.status === 409) return error;
            throw error;
          });
          if (response instanceof TransportError) return response;
          const { id: raw, name, kind, essential, archived } = fundRecord(response), id = uuid(raw);
          if (!id || name !== body.name || archived === true || (catalog === "categories" && ((kind !== undefined && kind !== body.kind) ||
            (essential ?? false) !== (body.essential ?? false)))) throw new TypeError("Invalid catalog receipt");
          return id;
        }, { serverDate, confirmation }) }, "La creación de catálogos no está disponible en este servidor.");
      if (result instanceof TransportError) throw new InvalidDraft(catalogLabels[catalog].duplicate);
      return result as string;
    } catch (error) {
      if (error instanceof Error && error.message === workspaceUnavailable) throw new InvalidDraft(workspaceUnavailable);
      if (error instanceof TransportError && error.kind === "http" && error.status === 403) throw new InvalidDraft("No tienes permiso para crear elementos en este espacio.");
      throw error;
    }
  } };
}
export type CatalogWrites = ReturnType<typeof createCatalogWrites>;
