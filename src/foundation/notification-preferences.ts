import type { ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { notificationRequest } from "./notification-inbox";
import type { PendingSubmissionExpired } from "./pending-expiry";
import { pendingSubmission } from "./pending-submission";
import { uuid } from "./workspace-context";

const preferencesPath = "/v1/me/notification-preferences", pushPath = "/v1/me/push-devices";
const unavailable = "Preferencias de notificaciones no disponibles.";
export const notificationChannels = { in_app: "En la aplicación", push: "Notificaciones push", email: "Correo electrónico" } as const;
export type QuietHours = { start: string; end: string; timezone: string };
export type Preferences = { channels: Record<keyof typeof notificationChannels, boolean>; quietHours: QuietHours | null; digestEnabled: boolean };
export type PushRegistration = Readonly<{ expoPushToken: string; platform: "ios" | "android"; appVersion: string }>;
export type PushTokenSource = () => Promise<PushRegistration | null>;
const only = (row: Record<string, unknown>, keys: readonly string[]) => Object.keys(row).every((key) => keys.includes(key));
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const etagValid = (value: unknown): value is string => typeof value === "string" && /^"[\x21\x23-\x7e]{1,128}"$/.test(value);
function quietHours(input: unknown): QuietHours | null {
  if (input === null) return null;
  const row = fundRecord(input), { start, end, timezone } = row;
  if (!only(row, ["start", "end", "timezone"]) || typeof start !== "string" || typeof end !== "string" || !time.test(start) || !time.test(end) || start === end ||
    typeof timezone !== "string" || timezone.length > 100 || !/^[A-Za-z_][A-Za-z0-9_+/-]*$/.test(timezone)) throw new TypeError();
  new Intl.DateTimeFormat("es", { timeZone: timezone });
  return { start, end, timezone };
}
function parsePreferences(input: unknown): Preferences {
  const row = fundRecord(input), { digestEnabled } = row, channels = fundRecord(row.channels), { in_app, push, email } = channels;
  if (!only(row, ["channels", "quietHours", "digestEnabled"]) || !only(channels, Object.keys(notificationChannels)) || typeof digestEnabled !== "boolean" ||
    typeof in_app !== "boolean" || typeof push !== "boolean" || typeof email !== "boolean") throw new TypeError();
  return { channels: { in_app, push, email }, quietHours: quietHours(row.quietHours), digestEnabled };
}
function snapshot(raw: unknown) {
  const { body, etag } = fundRecord(raw);
  if (!etagValid(etag)) throw new TypeError();
  return { value: parsePreferences(body), etag };
}
export function createNotificationPreferences(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "", call = notificationRequest(request, scope);
  return {
    async load() {
      if (!scope) throw new InvalidDraft(unavailable);
      return snapshot(await call(preferencesPath, unavailable, { includeETag: true, successStatus: 200 }));
    },
    async save(input: unknown, ifMatch: unknown, confirmation?: PendingSubmissionExpired) {
      let body;
      try { if (!scope || !etagValid(ifMatch)) throw new TypeError(); body = parsePreferences(input); }
      catch { throw new InvalidDraft("Revisa las preferencias de notificaciones."); }
      const method = "PUT";
      return snapshot(await call(preferencesPath, unavailable, { method, body, ifMatch, includeETag: true, successStatus: 200,
        submit: (profile, operation, serverDate) => pendingSubmission(scope, profile, JSON.stringify([method, preferencesPath, body]), async (key) => {
          const raw = await operation(key); snapshot(raw); return raw;
        }, { serverDate, ifMatch, confirmation }),
      }));
    },
    async register(input: unknown) {
      let body;
      try {
        const row = fundRecord(input), { expoPushToken, platform, appVersion } = row;
        if (!scope || !only(row, ["expoPushToken", "platform", "appVersion"]) || typeof expoPushToken !== "string" || expoPushToken.length > 255 ||
          !/^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/.test(expoPushToken) || (platform !== "ios" && platform !== "android") ||
          typeof appVersion !== "string" || !appVersion.trim() || [...appVersion].length > 64 || /[\x00-\x1f\x7f]/.test(appVersion)) throw new TypeError();
        body = { expoPushToken, platform, appVersion };
      } catch { throw new InvalidDraft("Token de notificaciones no válido."); }
      // Registration is a server upsert by (subject, token); no token or write key is persisted client-side.
      const result = uuid(fundRecord(await call(pushPath, "Registro de notificaciones push no disponible.", { method: "POST", body, successStatus: [200, 201] })).deviceId);
      if (!result) throw new TypeError();
      return result;
    },
  };
}
export type NotificationPreferences = ReturnType<typeof createNotificationPreferences>;
