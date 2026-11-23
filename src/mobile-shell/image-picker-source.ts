import { invalidImage, receiptImageLimit, validateReceiptImage, type ReceiptImageSource, type ImageOrigin } from "../foundation/receipts";

type PickerAsset = { uri: string; fileName?: string | null; mimeType?: string; fileSize?: number; file?: Blob };
type Pick = () => Promise<{ canceled: true } | { canceled: false; assets: readonly PickerAsset[] }>;

// Supply permission-checked picker actions and a local URI reader from the host; no picker dependency here.
export function imagePickerSource(pickers: Record<ImageOrigin, Pick>, readLocal: (uri: string, limit: number) => Promise<Blob>): ReceiptImageSource {
  return async (origin) => {
    const selection = await pickers[origin]();
    if (selection.canceled) return null;
    const [asset] = selection.assets;
    if (!asset || selection.assets.length !== 1 || (asset.fileSize !== undefined && (asset.fileSize < 1 || asset.fileSize > receiptImageLimit))) throw invalidImage();
    const blob = asset.file ?? await readLocal(asset.uri, receiptImageLimit);
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[blob.type];
    return validateReceiptImage({ name: asset.fileName ?? `recibo.${extension ?? "imagen"}`, blob });
  };
}
