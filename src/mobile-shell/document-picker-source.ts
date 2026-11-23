import type * as PickerCache from "expo-file-system";
import { Platform } from "react-native";
import { validateStatement, type StatementFileSource } from "../foundation/imports";
import { readLocalBlob } from "../foundation/transport";

type PickerAsset = { uri: string; name: string; size?: number; file?: Blob };
type Pick = () => Promise<{ canceled: true } | { canceled: false; assets: readonly PickerAsset[] }>;
export function documentPickerSource(pick: Pick, readLocal: (uri: string, limit: number) => Promise<Blob>, release?: (asset: PickerAsset) => void): StatementFileSource {
  return async () => {
    const selection = await pick();
    if (selection.canceled) return null;
    try {
      const [asset] = selection.assets, limit = 5 * 1024 * 1024;
      if (!asset || selection.assets.length !== 1 || (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit))) return validateStatement(null);
      return validateStatement({ name: asset.name, blob: asset.file ?? await readLocal(asset.uri, limit) });
    } finally {
      if (release) selection.assets.forEach(release);
    }
  };
}

function isPickerCopy(uri: string, cacheUri: string) {
  if (Platform.OS !== "ios") return false;
  // Even with Expo's extra cache copy disabled, UIKit imports a copy into the app sandbox.
  const container = /^(.*)\/Library\/Caches\/?$/.exec(cacheUri.replace(/^file:\/\/\/private\//, "file:///"))?.[1];
  const local = uri.replace(/^file:\/\/\/private\//, "file:///");
  if (!container) return false;
  const root = [`${container}/tmp/`, `${container}/Documents/Inbox/`].find((path) => local.startsWith(path));
  if (!root) return false;
  const suffix = local.slice(root.length);
  return !/[?#\\]/.test(suffix) && suffix.split("/").every((part) => {
    try { const name = decodeURIComponent(part); return !!name && name !== "." && name !== ".." && !/[/\\\u0000]/.test(name); }
    catch { return false; }
  });
}

function releasePickerCopy({ uri, file }: PickerAsset) {
  if (file || !uri.startsWith("file:///")) return;
  const { File, Paths } = require("expo-file-system") as typeof PickerCache;
  if (isPickerCopy(uri, Paths.cache.uri)) new File(uri).delete();
}

export const defaultStatementSource = documentPickerSource(() => {
  const { getDocumentAsync } = require("expo-document-picker") as typeof import("expo-document-picker");
  return getDocumentAsync({ type: ["text/csv", "application/csv", "application/vnd.ms-excel"], copyToCacheDirectory: false, multiple: false, base64: false });
}, readLocalBlob, releasePickerCopy);
