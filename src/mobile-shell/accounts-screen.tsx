import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import { type Accounts, statuses, types } from "../foundation/accounts";
import { InvalidDraft } from "../foundation/identity-draft";
import { TransportError } from "../foundation/transport";
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

type AccountDetail = Awaited<ReturnType<Accounts["detail"]>>;
function Detail({ api, id, back }: { api: Accounts; id: string; back: () => void }) {
  const [attempt, retry] = useState(0);
  const [data, setData] = useState<AccountDetail | null>();
  const reload = () => { setData(undefined); retry((n) => n + 1); };
  useEffect(() => {
    let current = true;
    void api.detail(id).then((value) => { if (current) setData(value); }, () => { if (current) setData(null); });
    return () => { current = false; };
  }, [api, id, attempt]);
  if (data) return <LoadedDetail key={attempt} api={api} data={data} back={back} reload={reload} replace={setData} />;
  return <>
    <AuthAction label="Volver a cuentas" action={back} />
    {data === null ? <><Copy role="alert">No pudimos cargar la cuenta.</Copy><AuthAction label="Reintentar" action={reload} /></> : <Copy>Cargando cuenta…</Copy>}
  </>;
}

const editFields = ["name", "institution", "maskedNumber", "description"] as const;
type MetadataDraft = Partial<Record<typeof editFields[number], string> & { includeInNetWorth: boolean }>;
function LoadedDetail({ api, data, back, reload, replace }: { api: Accounts; data: AccountDetail; back: () => void; reload: () => void; replace: (data: AccountDetail) => void }) {
  const { account, editable, confirmed, pending, available, reconciled, equivalent } = data;
  const colors = paletteFor(useColorScheme());
  const [mode, setMode] = useState<"detail" | "edit" | "close">("detail");
  const [draft, setDraft] = useState<MetadataDraft>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; conflict: boolean }>();
  const lock = useRef(false);
  const changeMode = (next: typeof mode) => { setMode(next); setFailure(undefined); setDraft({}); };
  const original: MetadataDraft = { name: account.name, ...Object.fromEntries(account.metadata), includeInNetWorth: editable?.includeInNetWorth };
  const changes: MetadataDraft = Object.fromEntries(Object.entries(draft).filter(([key, value]) => (original[key as keyof MetadataDraft] ?? "") !== value));
  async function refreshConflict() {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const latest = await api.detail(account.id);
      setDraft(changes);
      replace(latest);
      setFailure(undefined);
    } catch { setFailure({ conflict: true, message: "No pudimos recargar la cuenta. Vuelve a intentarlo." }); }
    finally { lock.current = false; setBusy(false); }
  }
  async function mutate(command: "edit" | "status" | "close") {
    if (!editable || failure?.conflict || lock.current) return;
    lock.current = true; setBusy(true); setFailure(undefined);
    try {
      if (command === "close") await api.close(account.id, editable.etag, mode === "close");
      else await api.update(account.id, editable.etag, command === "edit" ? changes : { status: account.status === "active" ? "archived" : "active" });
      reload();
    } catch (error) {
      const status = error instanceof TransportError && error.kind === "http" ? error.status : undefined;
      setFailure({ conflict: status === 412, message: status === 412 ? "La cuenta cambió. Recarga sus datos antes de volver a intentarlo."
        : error instanceof InvalidDraft ? error.message
        : command !== "close" ? "No pudimos actualizar la cuenta. Vuelve a intentarlo."
        : status === 409 ? "No pudimos cerrar la cuenta. Revisa su estado y los movimientos pendientes."
        : "No pudimos cerrar la cuenta. Vuelve a intentarlo." });
    } finally { lock.current = false; setBusy(false); }
  }
  const blocked = busy || failure?.conflict;
  const carry = draft.includeInNetWorth ?? editable?.includeInNetWorth;
  return <>
    <AuthAction label="Volver a cuentas" action={back} disabled={busy} />
    <Copy role="header">{account.name}</Copy><Copy>{types[account.type]} · {statuses[account.status]} · {account.currency}</Copy>
    {account.metadata.map(([key, value]) => <Copy key={key}>{value}</Copy>)}
    <Copy>Saldo confirmado: {confirmed}</Copy><Copy>Saldo pendiente: {pending}</Copy><Copy>Saldo disponible: {available}</Copy><Copy>Saldo conciliado: {reconciled}</Copy>
    <Copy>Equivalente en moneda base: {equivalent}</Copy><Copy>Saldo al {data.asOf}</Copy>
    <Copy>Tasa: {data.rate} · {data.rateDate} · {data.rateSource}</Copy>
    {editable && (mode === "edit" ? <>
      <Copy role="header">Editar cuenta</Copy>
      {editFields.map((key) => <View key={key}>
        <Copy>{fields[key]}</Copy><TextInput accessibilityLabel={fields[key]} value={draft[key] ?? original[key] ?? ""} onChangeText={(value) => setDraft((old) => ({ ...old, [key]: value }))} editable={!blocked} style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} />
      </View>)}
      <AuthAction label="Incluir en el patrimonio" selected={carry} action={() => setDraft((old) => ({ ...old, includeInNetWorth: !carry }))} disabled={blocked} />
      <AuthAction label="Guardar cambios" action={() => void mutate("edit")} disabled={blocked || !Object.keys(changes).length} />
      <AuthAction label="Cancelar edición" action={() => changeMode("detail")} disabled={blocked} />
    </> : mode === "close" ? <>
      <Copy>¿Cerrar la cuenta {account.name}? No puedes reabrirla. Cerrar la cuenta no elimina sus movimientos.</Copy>
      <AuthAction label="Confirmar cierre" action={() => void mutate("close")} disabled={blocked} />
      <AuthAction label="Cancelar cierre" action={() => changeMode("detail")} disabled={blocked} />
    </> : <>
      <AuthAction label="Editar cuenta" action={() => changeMode("edit")} disabled={blocked} />
      <AuthAction label={account.status === "active" ? "Archivar cuenta" : "Reactivar cuenta"} action={() => void mutate("status")} disabled={blocked} />
      <AuthAction label="Cerrar cuenta" action={() => changeMode("close")} disabled={blocked} />
    </>)}
    {failure && <Copy role="alert">{failure.message}</Copy>}
    {failure?.conflict && <AuthAction label="Recargar cuenta" action={() => void refreshConflict()} disabled={busy} />}
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
    </> : panel === "create" ? <Create api={api} open={open} back={() => show("list")} /> : <Detail key={panel.id} api={api} id={panel.id} back={() => show("list")} />}
  </AuthPanel>;
}
