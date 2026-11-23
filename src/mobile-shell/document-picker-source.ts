import { validateStatement, type StatementFileSource } from "../foundation/imports";
import { readLocalBlob } from "../foundation/transport";

type PickerAsset = { uri: string; name: string; size?: number; file?: Blob };
type Pick = () => Promise<{ canceled: true } | { canceled: false; assets: readonly PickerAsset[] }>;
export function documentPickerSource(pick: Pick, readLocal: (uri: string, limit: number) => Promise<Blob>): StatementFileSource {
  return async () => {
    const selection = await pick();
    if (selection.canceled) return null;
    const [asset] = selection.assets, limit = 5 * 1024 * 1024;
    if (!asset || selection.assets.length !== 1 || (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit))) return validateStatement(null);
    return validateStatement({ name: asset.name, blob: asset.file ?? await readLocal(asset.uri, limit) });
  };
}

export const defaultStatementSource = documentPickerSource(() => {
  const { getDocumentAsync } = require("expo-document-picker") as typeof import("expo-document-picker");
  return getDocumentAsync({ type: ["text/csv", "application/csv", "application/vnd.ms-excel"], copyToCacheDirectory: false, multiple: false, base64: false });
}, readLocalBlob);
