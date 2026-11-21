import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, useColorScheme, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Auth } from "../foundation/auth";
import { TransportError } from "../foundation/transport";
import { paletteFor } from "./tokens";

export function AuthPanel({ children }: { children: ReactNode }) {
  const colors = paletteFor(useColorScheme());
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 16 }}>{children}</ScrollView>
  </SafeAreaView>;
}

export function AuthAction({ label, action, disabled = false }: { label: string; action: () => void; disabled?: boolean }) {
  const colors = paletteFor(useColorScheme());
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={action} style={{ minHeight: 44, minWidth: 44, padding: 12, backgroundColor: colors.raised }}>
    <Text style={{ color: disabled ? colors.disabled : colors.action }}>{label}</Text>
  </Pressable>;
}

type Route = "loading" | "sign-in" | "onboarding" | "home" | "retry";
export function AuthGate({ auth, request, home }: { auth: () => Auth; request: (path: string, options: { successStatus: number }) => Promise<unknown>; home: ReactNode }) {
  const colors = paletteFor(useColorScheme());
  const [route, setRoute] = useState<Route>("loading");
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const sequence = useRef(0);
  const check = useCallback(async () => {
    const id = ++sequence.current;
    setRoute("loading");
    let next: Route = "home";
    try { await request("/v1/me", { successStatus: 200 }); }
    catch (error) {
      const status = error instanceof TransportError && error.kind === "http" ? error.status : undefined;
      next = status === 404 ? "onboarding" : status === 401 ? "sign-in" : "retry";
    }
    if (id === sequence.current) setRoute(next);
  }, [request]);
  useEffect(() => { void check(); return () => { ++sequence.current; }; }, [check]);

  async function run(operation: () => Promise<void>, error: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setNotice("");
    try { await operation(); } catch { setNotice(error); }
    finally { submitting.current = false; setBusy(false); }
  }
  function submit() {
    if (!email.trim() || !pass) return;
    const secret = pass;
    setPass("");
    void run(async () => {
      if (signup && !await auth().signUp(email.trim(), secret)) {
        setNotice("Revisa tu correo para confirmar tu cuenta.");
        return;
      }
      if (!signup) await auth().signIn(email.trim(), secret);
      setSignup(false);
      await check();
    }, "No pudimos continuar. Verifica tus datos e inténtalo de nuevo.");
  }
  const signOut = () => void run(async () => { await auth().signOut(); setRoute("sign-in"); }, "No pudimos cerrar la sesión.");
  const noticeText = notice ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.text }}>{notice}</Text> : null;
  if (route === "home") return <View style={{ flex: 1, backgroundColor: colors.canvas }}>{home}<SafeAreaView edges={["bottom"]}>{noticeText}<AuthAction label="Cerrar sesión" action={signOut} disabled={busy} /></SafeAreaView></View>;
  const title = route === "sign-in" ? (signup ? "Crear cuenta" : "Iniciar sesión") : route === "onboarding" ? "Completa tu perfil" : route === "retry" ? "No pudimos verificar tu perfil" : "Verificando tu perfil…";
  const field = { minHeight: 44, padding: 12, backgroundColor: colors.raised, color: colors.text };
  const autofill = { signIn: "current-password", signUp: "new-password" } as const;
  return <AuthPanel>
    <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 26 }}>{title}</Text>
    {route === "sign-in" ? <>
      <TextInput accessibilityLabel="Correo electrónico" placeholder="Correo electrónico" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" editable={!busy} value={email} onChangeText={setEmail} style={field} />
      <TextInput accessibilityLabel="Contraseña" placeholder="Contraseña" placeholderTextColor={colors.muted} autoCapitalize="none" autoComplete={signup ? autofill.signUp : autofill.signIn} secureTextEntry editable={!busy} value={pass} onChangeText={setPass} style={field} />
      <AuthAction label={signup ? "Registrarme" : "Ingresar"} action={submit} disabled={busy || !email.trim() || !pass} />
      <AuthAction label={signup ? "Volver a iniciar sesión" : "Crear una cuenta"} action={() => { setSignup(!signup); setPass(""); setNotice(""); }} disabled={busy} />
    </> : route === "retry" ? <AuthAction label="Reintentar" action={() => void check()} /> : route === "onboarding" ? <>
      <Text style={{ color: colors.text }}>La configuración inicial todavía no está disponible.</Text>
      <AuthAction label="Cerrar sesión" action={signOut} disabled={busy} />
    </> : null}
    {noticeText}
  </AuthPanel>;
}
