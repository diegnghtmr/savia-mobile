import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import { type Accounts, statuses, types } from "../foundation/accounts";
import { InvalidDraft } from "../foundation/identity-draft";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";

function Copy({ children, role }: { children: ReactNode; role?: "header" | "alert" }) {
  const colors = paletteFor(useColorScheme());
  return <Text accessibilityRole={role} accessibilityLiveRegion={role === "alert" ? "polite" : undefined} style={{ color: colors.text, ...(role === "header" && { fontSize: 26 }) }}>{children}</Text>;
}

const labels = { active: "Activas", archived: "Archivadas", closed: "Cerradas" } as const;
type Filter = keyof typeof labels | undefined;
type Page = Awaited<ReturnType<Accounts["list"]>>;
function List({ api, status, change, open }: { api: Accounts; status: Filter; change: (status: Filter) => void; open: (id: string) => void }) {
  const [page, setPage] = useState<Page>({ items: [], nextCursor: null });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const sequence = useRef(0);
  const seen = useRef(new Set<string>());
  async function load(cursor?: string) {
    const operation = ++sequence.current;
    setBusy(true); setError(false);
    try {
      const result = await api.list({ ...(status && { status }), ...(cursor && { cursor }) });
      if (operation !== sequence.current) return;
      if (cursor && (result.items.some(({ id }) => page.items.some((item) => item.id === id)) || (result.nextCursor && seen.current.has(result.nextCursor)))) throw new Error("Repeated account page");
      if (cursor) seen.current.add(cursor); else seen.current.clear();
      setPage({ items: [...(cursor ? page.items : []), ...result.items], nextCursor: result.nextCursor });
    } catch { if (operation === sequence.current) setError(true); }
    finally { if (operation === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { ++sequence.current; }; }, []);
  return <>
    <Copy>Estado de la cuenta</Copy>
    <AuthAction label="Todas" action={() => change(undefined)} selected={!status} />
    {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => <AuthAction key={key} label={labels[key]} action={() => change(key)} selected={status === key} />)}
    {error && <><Copy role="alert">No pudimos cargar las cuentas.</Copy><AuthAction label="Reintentar" action={() => void load(page.nextCursor ?? undefined)} disabled={busy} /></>}
    {busy && <Copy>Cargando cuentas…</Copy>}
    {!busy && !error && !page.items.length && <Copy>No hay cuentas para este estado.</Copy>}
    {page.items.map(({ id, name, status, currency, balance, asOf }) => <View key={id} style={{ gap: 4 }}>
      <AuthAction label={name} action={() => open(id)} />
      <Copy>{statuses[status]} · {currency} · {balance ?? "Saldo no disponible"}</Copy>
      {asOf && <Copy>Saldo al {asOf}</Copy>}
    </View>)}
    {page.nextCursor && !error && <AuthAction label="Cargar más" action={() => void load(page.nextCursor ?? undefined)} disabled={busy} />}
  </>;
}

function Detail({ api, id }: { api: Accounts; id: string }) {
  const [attempt, retry] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<Accounts["detail"]>> | null>();
  useEffect(() => {
    let current = true;
    setData(undefined);
    void api.detail(id).then((value) => { if (current) setData(value); }, () => { if (current) setData(null); });
    return () => { current = false; };
  }, [api, id, attempt]);
  if (data === null) return <><Copy role="alert">No pudimos cargar la cuenta.</Copy><AuthAction label="Reintentar" action={() => retry(attempt + 1)} /></>;
  if (!data) return <Copy>Cargando cuenta…</Copy>;
  const { account, confirmed, pending, available, reconciled, equivalent } = data;
  return <>
    <Copy role="header">{account.name}</Copy><Copy>{types[account.type]} · {statuses[account.status]} · {account.currency}</Copy>
    {account.metadata.map(([key, value]) => <Copy key={key}>{value}</Copy>)}
    <Copy>Saldo confirmado: {confirmed}</Copy><Copy>Saldo pendiente: {pending}</Copy><Copy>Saldo disponible: {available}</Copy><Copy>Saldo conciliado: {reconciled}</Copy>
    <Copy>Equivalente en moneda base: {equivalent}</Copy><Copy>Saldo al {data.asOf}</Copy>
    <Copy>Tasa: {data.rate} · {data.rateDate} · {data.rateSource}</Copy>
  </>;
}

const fields = { name: "Nombre de la cuenta", currency: "Moneda", openingBalance: "Saldo inicial", openingBalanceDate: "Fecha del saldo inicial (AAAA-MM-DD)", institution: "Institución", maskedNumber: "Número enmascarado", description: "Descripción" } as const;
function Create({ api, open, back }: { api: Accounts; open: (id: string) => void; back: () => void }) {
  const colors = paletteFor(useColorScheme());
  const [save] = useState(() => api.draft());
  const [values, setValues] = useState<Partial<Record<keyof typeof fields, string>>>({ currency: "COP" });
  const [type, setType] = useState<keyof typeof types>("cash");
  const [includeInNetWorth, setInclude] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function submit() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { open(await save({ ...values, type, includeInNetWorth })); }
    catch (failure) { setError(failure instanceof InvalidDraft ? failure.message : "No pudimos crear la cuenta. Vuelve a intentarlo."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <AuthAction label="Volver a cuentas" action={back} disabled={busy} />
    <Copy role="header">Nueva cuenta</Copy><Copy>Tipo de cuenta</Copy>
    {(Object.keys(types) as (keyof typeof types)[]).map((key) => <AuthAction key={key} label={types[key]} action={() => setType(key)} selected={type === key} disabled={busy} />)}
    {(Object.keys(fields) as (keyof typeof fields)[]).map((key) => <View key={key}>
      <Copy>{fields[key]}</Copy><TextInput accessibilityLabel={fields[key]} value={values[key] ?? ""} onChangeText={(value) => setValues((old) => ({ ...old, [key]: value }))} editable={!busy} style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} />
    </View>)}
    <Copy>Saldo inicial y fecha opcionales. Para el saldo usa coma o punto decimal, sin separadores de miles.</Copy>
    <AuthAction label="Incluir en el patrimonio" action={() => setInclude(!includeInNetWorth)} selected={includeInNetWorth} disabled={busy} />
    <AuthAction label="Crear cuenta" action={() => void submit()} disabled={busy} />
    {error && <Copy role="alert">{error}</Copy>}
  </>;
}

export function AccountsScreen({ api, back }: { api: Accounts; back: () => void }) {
  const [panel, show] = useState<"list" | "create" | { id: string }>("list");
  const [status, change] = useState<Filter>(undefined);
  const open = (id: string) => show({ id });
  return <AuthPanel>
    {panel === "list" ? <>
      <Copy role="header">Cuentas</Copy><AuthAction label="Volver al resumen" action={back} />
      <AuthAction label="Nueva cuenta" action={() => show("create")} /><List key={status ?? "all"} api={api} status={status} change={change} open={open} />
    </> : panel === "create" ? <Create api={api} open={open} back={() => show("list")} /> : <>
      <AuthAction label="Volver a cuentas" action={() => show("list")} />
      <Detail key={panel.id} api={api} id={panel.id} />
    </>}
  </AuthPanel>;
}
