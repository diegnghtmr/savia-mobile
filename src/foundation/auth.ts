import { createClient } from "@supabase/supabase-js";
import { CryptoDigestAlgorithm, digest, getRandomValues } from "expo-crypto";
import { Platform } from "react-native";
import { readApiOrigin } from "./config";
import { secureStorage } from "./session-store";
import { authNetwork, TransportError } from "./transport";
import { uuid } from "./workspace-context";

export interface Auth {
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<boolean>;
  signOut(scope?: "local" | "global"): Promise<void>;
  refreshSession(): Promise<boolean>;
  exchangeCode(code: string): Promise<void>;
  readSession(): Promise<{ accessToken: string } | null>;
  localPrincipal?(): Promise<string | null>;
}

function isPublicKey(key: string): boolean {
  if (/^sb_publishable_[\w-]+$/.test(key)) return true;
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) return false;
  try {
    const payload = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))).role === "anon";
  } catch { return false; }
}

function ensurePkceCrypto() {
  if (Platform.OS === "web" || typeof TextEncoder !== "function") throw new Error("Secure mobile authentication is unavailable");
  // Expo's native runtime provides URL and TextEncoder, but not all of Web Crypto.
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  if (!globalThis.crypto.getRandomValues) Object.defineProperty(globalThis.crypto, "getRandomValues", { value: getRandomValues });
  if (!globalThis.crypto.subtle?.digest) Object.defineProperty(globalThis.crypto, "subtle", { value: {
    digest(algorithm: string, data: BufferSource) {
      if (algorithm !== "SHA-256") throw new TypeError("Unsupported PKCE algorithm");
      return digest(CryptoDigestAlgorithm.SHA256, data);
    },
  } });
}

export function createAuth(url = process.env.EXPO_PUBLIC_SUPABASE_URL, key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY): Auth {
  if (!url || !key || !isPublicKey(key)) throw new TypeError("Invalid Supabase public key");
  const origin = readApiOrigin(url, false);
  ensurePkceCrypto();
  const storageKey = `savia.auth.${Array.from(origin, (char) => char.charCodeAt(0).toString(16)).join("")}`;
  const { auth } = createClient(origin, key, {
    auth: { storage: secureStorage, storageKey, flowType: "pkce", persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: authNetwork(origin),
  });
  return {
    async signIn(email, password) {
      const { data, error } = await auth.signInWithPassword({ email, password });
      if (error || !data.session) throw new Error("Sign-in failed");
    },
    async signUp(email, password) {
      const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo: "co.savia.mobile://auth/callback" } });
      if (error) throw new Error("Sign-up failed");
      return Boolean(data.session);
    },
    async signOut(scope = "local") {
      try {
        const { error } = await auth.signOut({ scope });
        if (error) throw new Error("Sign-out failed");
      } catch (error) {
        // An expired session can fail to refresh before the SDK reaches its local cleanup.
        if (scope === "global") await Promise.all(["", "-code-verifier", "-user"].map((suffix) => secureStorage.removeItem(storageKey + suffix)));
        throw error;
      }
    },
    async refreshSession() {
      const { data, error } = await auth.refreshSession();
      if (error) throw new Error("Session refresh failed");
      return Boolean(data.session);
    },
    async exchangeCode(code) {
      if (!/^[\w-]{1,256}$/.test(code)) throw new TypeError("Invalid auth code");
      const { data, error } = await auth.exchangeCodeForSession(code);
      if (error || !data.session) throw new Error("Email confirmation failed");
    },
    async localPrincipal() {
      const raw = await secureStorage.getItem(storageKey);
      if (raw === null) return null;
      try { return uuid(JSON.parse(raw)?.user?.id); } catch { return null; }
    },
    async readSession() {
      const { data, error } = await auth.getSession();
      if (error) {
        if (error.name === "AuthSessionMissingError" || ["session_not_found", "refresh_token_not_found", "refresh_token_already_used"].includes(error.code ?? "")) return null;
        if (error.name === "AuthRetryableFetchError" && !error.status) throw new TransportError("network");
        throw new Error("Session recovery failed");
      }
      return data.session ? { accessToken: data.session.access_token } : null;
    },
  };
}

let instance: Auth | undefined;
export const getAuth = () => instance ??= createAuth();
