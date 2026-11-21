import { fireEvent, render, screen, userEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { createAuth, type Auth } from "../src/foundation/auth";
import { createTransport } from "../src/foundation/transport";
import { AuthGate } from "../src/mobile-shell/auth-gate";

jest.mock("@supabase/supabase-js", () => ({ createClient: jest.fn() }));
jest.mock("expo-crypto", () => ({ getRandomValues: jest.fn(), digest: jest.fn(), CryptoDigestAlgorithm: { SHA256: "SHA-256" } }));
jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, setItemAsync: jest.fn(), getItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));

const session = { access_token: "access-fixture", refresh_token: "refresh-fixture" };
const input = { email: "fixture@example.invalid", password: "fixture-password" };
const result = { data: { session }, error: null };
const provider = {
  signInWithPassword: jest.fn().mockResolvedValue(result),
  signUp: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
  getSession: jest.fn().mockResolvedValue(result), refreshSession: jest.fn().mockResolvedValue(result),
  signOut: jest.fn().mockResolvedValue({ error: null }), exchangeCodeForSession: jest.fn().mockResolvedValue(result),
};
const client = jest.mocked(createClient);
const origin = "https://project.invalid";
beforeEach(() => { jest.clearAllMocks(); client.mockReturnValue({ auth: provider } as unknown as ReturnType<typeof createClient>); });

test("uses public configuration, S256-capable PKCE, and only device-bound storage for SDK session and verifier", async () => {
  const auth = createAuth(origin, "sb_publishable_fixture");
  const [url, key, options] = client.mock.calls[0] ?? [];
  expect([url, key]).toEqual([origin, "sb_publishable_fixture"]);
  expect(options?.auth).toMatchObject({ flowType: "pkce", persistSession: true, detectSessionInUrl: false });
  expect(globalThis.crypto.getRandomValues).toEqual(expect.any(Function));
  expect(globalThis.crypto.subtle.digest).toEqual(expect.any(Function));
  const keychain = { keychainAccessible: 1 };
  const store = options!.auth!.storage!;
  const storageKey = options!.auth!.storageKey!;
  for (const id of [storageKey, `${storageKey}-code-verifier`]) {
    await store.setItem(id, "fixture"); await store.getItem(id); await store.removeItem(id);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(id, "fixture", keychain);
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(id, keychain);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(id, keychain);
  }
  await expect(auth.signIn(input.email, input.password)).resolves.toBeUndefined();
  expect(provider.signInWithPassword).toHaveBeenCalledWith(input);
  await expect(auth.signUp(input.email, input.password)).resolves.toBe(false);
  expect(provider.signUp).toHaveBeenCalledWith({ ...input, options: { emailRedirectTo: "co.savia.mobile://auth/callback" } });
  await auth.exchangeCode("auth-code-fixture");
  expect(provider.exchangeCodeForSession).toHaveBeenCalledWith("auth-code-fixture");
  await expect(auth.refreshSession()).resolves.toBe(true);
  expect(provider.refreshSession).toHaveBeenCalledTimes(1);
  await auth.signOut();
  expect(provider.signOut).toHaveBeenCalledWith({ scope: "local" });
  await expect(auth.readSession()).resolves.toEqual({ accessToken: session.access_token });
});

test.each(["sb_secret_fixture", "eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fixture"])("rejects non-public build configuration before SDK creation", (key) => {
  expect(() => createAuth(origin, key)).toThrow("Invalid Supabase public key");
  expect(client).not.toHaveBeenCalled();
});

function gate(status: number, authenticated = true) {
  const auth: Auth = { signIn: jest.fn(), signUp: jest.fn().mockResolvedValue(false), signOut: jest.fn(), refreshSession: jest.fn(), exchangeCode: jest.fn(), readSession: jest.fn().mockResolvedValue(authenticated ? { accessToken: "access-fixture", refreshToken: "refresh-fixture" } : null) };
  const send = jest.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300, redirected: false, headers: new Headers(), json: async () => ({ id: "profile" }) });
  const api = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read: auth.readSession } });
  return { auth, send, view: <AuthGate auth={() => auth} request={api.request} home={<Text>Resumen protegido</Text>} /> };
}

test.each([[200, "Resumen protegido"], [401, "Iniciar sesión"], [404, "Completa tu perfil"], [201, "Reintentar"], [302, "Reintentar"], [403, "Reintentar"], [503, "Reintentar"]] as const)("routes the direct /v1/me result %s to %s", async (status, label) => {
  const { send, view } = gate(status);
  await render(view);
  expect(await screen.findByText(label)).toBeTruthy();
  expect(send).toHaveBeenCalledWith("https://api.invalid/v1/me", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer access-fixture" }) }));
  if (status !== 404) expect(screen.queryByText("Completa tu perfil")).toBeNull();
  if (status !== 200) expect(screen.queryByText("Resumen protegido")).toBeNull();
});

test("submits accessible sign-in, re-checks the profile, and offers sign-out", async () => {
  const { view, auth, send } = gate(200, false);
  const user = userEvent.setup();
  await render(view);
  await screen.findByText("Iniciar sesión");
  expect(send).not.toHaveBeenCalled();
  jest.mocked(auth.readSession).mockResolvedValueOnce({ accessToken: "access-fixture" });
  await fireEvent.changeText(screen.getByLabelText("Correo electrónico"), input.email);
  await fireEvent.changeText(screen.getByLabelText("Contraseña"), input.password);
  await user.press(screen.getByRole("button", { name: "Ingresar" }));
  expect(await screen.findByText("Resumen protegido")).toBeTruthy();
  expect(auth.signIn).toHaveBeenCalledWith(input.email, input.password);
  await user.press(screen.getByRole("button", { name: "Cerrar sesión" }));
  expect(await screen.findByText("Iniciar sesión")).toBeTruthy();
  expect(auth.signOut).toHaveBeenCalledTimes(1);
});

test("registers with a protected password field and shows email confirmation without a session", async () => {
  const { view, auth, send } = gate(200, false);
  const user = userEvent.setup();
  await render(view);
  await user.press(await screen.findByRole("button", { name: "Crear una cuenta" }));
  const password = screen.getByLabelText("Contraseña");
  expect(password).toHaveProp("secureTextEntry", true);
  await fireEvent.changeText(screen.getByLabelText("Correo electrónico"), input.email);
  await fireEvent.changeText(password, input.password);
  await user.press(screen.getByRole("button", { name: "Registrarme" }));
  expect(await screen.findByText("Revisa tu correo para confirmar tu cuenta.")).toBeTruthy();
  expect(auth.signUp).toHaveBeenCalledWith(input.email, input.password);
  expect(send).not.toHaveBeenCalled();
});
