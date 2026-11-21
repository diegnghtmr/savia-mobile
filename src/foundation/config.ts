// Expo inlines this public setting; it must be an origin, never a credential.
export function readApiOrigin(
  value = process.env.EXPO_PUBLIC_SAVIA_API_URL,
  development = typeof __DEV__ !== "undefined" && __DEV__,
): string {
  const invalid = () => new TypeError("Invalid Savia API origin");
  if (!value || !/^https?:\/\/[^\s/\\@?#]+\/?$/i.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol === "https:") return url.origin;
  if (development && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value)) return url.origin;
  throw invalid();
}
