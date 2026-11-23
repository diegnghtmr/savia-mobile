import type { ImagePickerOptions } from "expo-image-picker";
import type * as PickerCache from "expo-file-system";
import { InvalidDraft } from "../foundation/identity-draft";
import { invalidImage, receiptImageLimit, validateReceiptImage, type ReceiptImageSource, type ImageOrigin } from "../foundation/receipts";
import { readLocalBlob } from "../foundation/transport";

type PickerAsset = { uri: string; fileName?: string | null; mimeType?: string; fileSize?: number; file?: Blob };
type Pick = () => Promise<{ canceled: true } | { canceled: false; assets: readonly PickerAsset[] }>;

export function imagePickerSource(pickers: Record<ImageOrigin, Pick>, readLocal: (uri: string, limit: number) => Promise<Blob>, release?: (asset: PickerAsset) => void): ReceiptImageSource {
  return async (origin) => {
    const selection = await pickers[origin]();
    if (selection.canceled) return null;
    try {
      const [asset] = selection.assets;
      if (!asset || selection.assets.length !== 1 || (asset.fileSize !== undefined && (!Number.isSafeInteger(asset.fileSize) || asset.fileSize < 1 || asset.fileSize > receiptImageLimit))) throw invalidImage();
      const blob = asset.file ?? await readLocal(asset.uri, receiptImageLimit);
      const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[blob.type];
      return validateReceiptImage({ name: asset.fileName ?? `recibo.${extension ?? "imagen"}`, blob });
    } finally {
      if (release) selection.assets.forEach(release);
    }
  };
}

const options: ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: false, base64: false, exif: false, quality: 1 };
async function pickImage(origin: ImageOrigin) {
  const picker = require("expo-image-picker") as typeof import("expo-image-picker");
  if (origin === "camera") {
    if (!(await picker.requestCameraPermissionsAsync()).granted) throw new InvalidDraft("Activa el permiso de cámara en los ajustes para tomar una foto del recibo.");
    return picker.launchCameraAsync(options);
  }
  if (!(await picker.requestMediaLibraryPermissionsAsync()).granted) throw new InvalidDraft("Activa el permiso de fotos en los ajustes para elegir una imagen del recibo.");
  return picker.launchImageLibraryAsync(options);
}

function releasePickerCopy({ uri, file }: PickerAsset) {
  if (file || !uri.startsWith("file:///")) return;
  // SDK 57 stages native images in its cache. Only delete its generated file, never a user original.
  const { File, Paths } = require("expo-file-system") as typeof PickerCache;
  const root = Paths.cache.uri.replace(/\/?$/, "/");
  if (uri.startsWith(root) && /^(?:ImagePicker\/)?[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?:\.[\da-z]+)?$/i.test(uri.slice(root.length))) {
    new File(uri).delete();
  }
}

export const defaultReceiptSource = imagePickerSource({ camera: () => pickImage("camera"), gallery: () => pickImage("gallery") }, readLocalBlob, releasePickerCopy);
