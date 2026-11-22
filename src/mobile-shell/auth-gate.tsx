import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, useColorScheme, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Auth } from "../foundation/auth";
import type { Identity } from "../foundation/identity";
import { InvalidDraft, validEmail, workspaceUnavailable } from "../foundation/identity-draft";
import { TransportError } from "../foundation/transport";
import type { Workspace, WorkspaceContext } from "../foundation/workspace-context";
import { paletteFor } from "./tokens";

export function AuthPanel({ children }: { children: ReactNode }) {
  const colors = paletteFor(useColorScheme());
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 16 }}>{children}</ScrollView>
  </SafeAreaView>;
}

export function AuthAction({ label, action, disabled = false, selected }: { label: string; action: () => void; disabled?: boolean; selected?: boolean }) {
  const colors = paletteFor(useColorScheme());
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, ...(selected !== undefined && { selected }) }} disabled={disabled} onPress={action} style={{ minHeight: 44, minWidth: 44, padding: 12, backgroundColor: colors.raised }}>
    <Text style={{ color: disabled ? colors.disabled : colors.action }}>{label}</Text>
  </Pressable>;
}

const onboardingFields = [
  ["email", "Correo electrónico", ""], ["displayName", "Nombre", ""], ["workspaceName", "Nombre del espacio personal", ""],
  ["locale", "Idioma y región (ej. es-CO)", "es-CO"], ["countryCode", "País (código de dos letras)", "CO"], ["timezone", "Zona horaria (ej. America/Bogota)", "America/Bogota"],
  ["dateFormat", "Fecha (DD/MM/YYYY, MM/DD/YYYY o YYYY-MM-DD)", "DD/MM/YYYY"], ["weekStartsOn", "Inicio de semana (0 domingo a 6 sábado)", "1"],
  ["numberFormat", "Número (1.234,56 o 1,234.56)", "1.234,56"], ["defaultCurrency", "Moneda preferida", "COP"], ["baseCurrency", "Moneda del espacio", "COP"],
] as const;
const recoveryFields = [["name", "Nombre del espacio", ""], ["baseCurrency", "Moneda del espacio", "COP"]] as const;
function DraftForm({ fields, label, submit, busy }: { fields: readonly (readonly [string, string, string])[]; label: string; submit: (values: unknown) => void; busy: boolean }) {
  const colors = paletteFor(useColorScheme());
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(([id, , value]) => [id, value])));
  return <>{fields.map(([id, name]) => <View key={id}>
    <Text style={{ color: colors.text }}>{name}</Text>
    <TextInput accessibilityLabel={name} editable={!busy} autoCapitalize="none" autoCorrect={false} value={values[id]} onChangeText={(value) => setValues((old) => ({ ...old, [id]: value }))} style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} />
  </View>)}<AuthAction label={label} action={() => submit(values)} disabled={busy} /></>;
}

function RecoveryForm({ identity, busy, submit }: { identity: Identity; busy: boolean; submit: (operation: () => Promise<WorkspaceContext>) => void }) {
  const [recover] = useState(() => identity.recovery());
  return <DraftForm fields={recoveryFields} label="Crear espacio" busy={busy} submit={(values) => submit(() => recover(values))} />;
}

const unauthorized = (error: unknown) => error instanceof TransportError && error.kind === "http" && error.status === 401;
type Route = "loading" | "sign-in" | "onboarding" | "workspace" | "retry";
export function AuthGate({ auth, identity, home, beforeSignOut }: { auth: () => Auth; identity: Identity; home: ReactNode | ((workspace: Workspace, profile: string) => ReactNode); beforeSignOut?: () => Promise<void> }) {
  const colors = paletteFor(useColorScheme());
  const [route, setRoute] = useState<Route>("loading");
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [choosing, setChoosing] = useState(false);
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
    try {
      const result = await identity.bootstrap();
      if (id !== sequence.current) return;
      setContext(result); setChoosing(false); setRoute(result ? "workspace" : "onboarding");
    } catch (error) {
      if (id === sequence.current) setRoute(unauthorized(error) ? "sign-in" : "retry");
    }
  }, [identity]);
  useEffect(() => { void check(); return () => { ++sequence.current; }; }, [check]);

  async function run(operation: () => Promise<void>, error: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setNotice("");
    try { await operation(); } catch (failure) {
      if (unauthorized(failure)) { setContext(null); setRoute("sign-in"); }
      else setNotice(failure instanceof InvalidDraft || (failure instanceof Error && failure.message === workspaceUnavailable) ? failure.message : error);
    } finally { submitting.current = false; setBusy(false); }
  }
  const changeWorkspace = (operation: () => Promise<WorkspaceContext>) => void run(async () => {
    setContext(await operation()); setChoosing(false); setRoute("workspace");
  }, "No pudimos guardar la configuración. Vuelve a intentarlo.");
  function submit() {
    if (!validEmail(email.trim()) || !pass || pass.includes("\0") || (signup && pass.length < 6)) {
      setNotice("Revisa el correo electrónico y la contraseña.");
      return;
    }
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
  const signOut = () => void run(async () => { await beforeSignOut?.(); await auth().signOut(); setContext(null); setRoute("sign-in"); }, "No pudimos cerrar la sesión.");
  const noticeText = notice ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.text }}>{notice}</Text> : null;
  if (route === "workspace" && context?.active && !choosing) return <View style={{ flex: 1, backgroundColor: colors.canvas }}>
    <SafeAreaView edges={["top"]}><Text style={{ color: colors.text }}>Espacio activo: {context.active.name}</Text><AuthAction label="Cambiar de espacio" action={() => { setChoosing(true); setNotice(""); }} disabled={busy} /></SafeAreaView>
    {typeof home === "function" ? home(context.active, context.profileId) : home}<SafeAreaView edges={["bottom"]}>{noticeText}<AuthAction label="Cerrar sesión" action={signOut} disabled={busy} /></SafeAreaView>
  </View>;
  const title = route === "sign-in" ? (signup ? "Crear cuenta" : "Iniciar sesión") : route === "onboarding" ? "Completa tu perfil" : route === "workspace" ? (context?.items.length ? "Elige un espacio" : "No tienes espacios disponibles") : route === "retry" ? "No pudimos verificar tu perfil" : "Verificando tu perfil…";
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
      <DraftForm fields={onboardingFields} label="Completar configuración" busy={busy} submit={(values) => changeWorkspace(() => identity.onboard(values))} />
      <AuthAction label="Cerrar sesión" action={signOut} disabled={busy} />
    </> : route === "workspace" && context ? <>
      {context.items.length ? context.items.map(({ id, name }) => <AuthAction key={id} label={id === context.active?.id ? `${name} (activo)` : name} action={() => changeWorkspace(() => identity.select(id))} disabled={busy} />)
        : <RecoveryForm identity={identity} busy={busy} submit={changeWorkspace} />}
      {context.active && <AuthAction label="Volver al espacio activo" action={() => setChoosing(false)} disabled={busy} />}
      <AuthAction label="Cerrar sesión" action={signOut} disabled={busy} />
    </> : null}
    {noticeText}
  </AuthPanel>;
}
