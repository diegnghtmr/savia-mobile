import { uuid } from "./workspace-context";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Account and ledger lists are unbound; catalog lists bind their cursor to the workspace.
export function isCursor(value: unknown, expectedWorkspaceId?: string): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return false;
  let decoded = "", bits = 0, byte = 0;
  for (const char of value) {
    byte = (byte << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode((byte >> bits) & 255);
    }
  }
  try {
    const tuple: unknown = JSON.parse(decoded);
    if (!Array.isArray(tuple) || JSON.stringify(tuple) !== decoded) return false;
    if (expectedWorkspaceId === undefined ? tuple.length !== 2 : tuple.length !== 3 || tuple[0] !== expectedWorkspaceId || !uuid(tuple[0])) return false;
    const [createdAt, id] = expectedWorkspaceId === undefined ? tuple : tuple.slice(1);
    if (typeof createdAt !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt) || !uuid(id)) return false;
    const date = new Date(createdAt);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 23) === createdAt.slice(0, 23);
  } catch { return false; }
}
