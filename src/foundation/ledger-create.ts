import { uuid } from "./workspace-context";

export function creationReceipt(path: string, body: object, raw: unknown) {
  const result = raw as { id?: unknown; sourceAccountId?: unknown; destinationAccountId?: unknown } | null;
  const id = uuid(result?.id);
  if (!id || (path !== "/v1/transactions" && (!("sourceAccountId" in body) || !("destinationAccountId" in body) ||
    uuid(result?.sourceAccountId) !== body.sourceAccountId || uuid(result?.destinationAccountId) !== body.destinationAccountId))) throw new TypeError();
  return id;
}
