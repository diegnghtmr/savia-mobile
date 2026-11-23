import type { NotificationPermissionsStatus } from "expo-notifications";
import { Platform } from "react-native";
import { InvalidDraft } from "../foundation/identity-draft";
import type { PushTokenSource } from "../foundation/notification-preferences";

export const defaultPushTokenSource: PushTokenSource = async () => {
  if (__DEV__) throw new InvalidDraft("El registro push no está disponible en compilaciones de desarrollo.");
  const platform = Platform.OS;
  if (platform !== "android" && platform !== "ios") throw new InvalidDraft("El registro push solo está disponible en Android e iOS.");

  const { default: constants } = require("expo-constants") as typeof import("expo-constants");
  const config = constants.expoConfig;
  const projectId = [constants.easConfig?.projectId, config?.extra?.eas?.projectId]
    .find((value): value is string => typeof value === "string" && !!value.trim())?.trim();
  if (!projectId) throw new InvalidDraft("No se configuró el ID del proyecto Expo para registrar notificaciones.");
  const appVersion = config?.version;
  if (!appVersion) throw new InvalidDraft("No se pudo identificar la versión de esta aplicación.");

  const notifications = require("expo-notifications") as typeof import("expo-notifications");
  if (platform === "android") {
    // Android 13 and later need a notification channel before prompting for permission.
    await notifications.setNotificationChannelAsync("savia", { name: "Savia", importance: notifications.AndroidImportance.DEFAULT });
  }
  const allowed = (settings: NotificationPermissionsStatus) => settings.granted ||
    (platform === "ios" && settings.ios?.status === notifications.IosAuthorizationStatus.PROVISIONAL);
  let permissions = await notifications.getPermissionsAsync();
  if (!allowed(permissions) && permissions.canAskAgain) permissions = await notifications.requestPermissionsAsync();
  if (!allowed(permissions)) throw new InvalidDraft("Activa el permiso de notificaciones en los ajustes para registrar este dispositivo.");

  // In SDK 57 an explicit URL keeps the standard endpoint but stops the SDK enabling background token updates.
  const { data: expoPushToken } = await notifications.getExpoPushTokenAsync({
    projectId, url: "https://exp.host/--/api/v2/push/getExpoPushToken",
  });
  return { expoPushToken, platform, appVersion };
};
