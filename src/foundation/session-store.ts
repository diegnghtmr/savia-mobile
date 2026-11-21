import * as SecureStore from "expo-secure-store";

export type SessionCredentials = { accessToken: string; refreshToken: string };
const key = "savia.session.v1";
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const secureStorage = {
  getItem: (id: string) => SecureStore.getItemAsync(id, options),
  setItem: (id: string, value: string) => SecureStore.setItemAsync(id, value, options),
  removeItem: (id: string) => SecureStore.deleteItemAsync(id, options),
};

function selectCredentials(value: unknown): SessionCredentials | null {
  if (!value || typeof value !== "object") return null;
  const { accessToken, refreshToken } = value as Partial<SessionCredentials>;
  return typeof accessToken === "string" && typeof refreshToken === "string" &&
    /^[\x21-\x7e]+$/.test(accessToken) && /^[\x21-\x7e]+$/.test(refreshToken)
    ? { accessToken, refreshToken } : null;
}

export const sessionStore = {
  async read(): Promise<SessionCredentials | null> {
    const value = await secureStorage.getItem(key);
    if (value === null) return null;
    try { return selectCredentials(JSON.parse(value)); } catch { return null; }
  },
  async write(session: SessionCredentials): Promise<void> {
    const credentials = selectCredentials(session);
    if (!credentials) throw new TypeError("Invalid session credentials");
    await secureStorage.setItem(key, JSON.stringify(credentials));
  },
  async clear(): Promise<void> {
    await secureStorage.removeItem(key);
  },
};
