import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import type { FundWrites } from "../foundation/fund-writes";
import { fundStatuses, type Fund, type Funds } from "../foundation/funds";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";
import { useVisibleApi } from "./use-visible-api";
import { confirmPendingLabel, usePendingWrite } from "./use-pending-write";

function Copy({ children, role }: { children: ReactNode; role?: "header" | "alert" }) {
  const colors = paletteFor(useColorScheme());
  return <Text accessibilityRole={role} accessibilityLiveRegion={role === "alert" ? "polite" : undefined} style={{ color: colors.text, fontSize: role === "header" ? 26 : undefined }}>{children}</Text>;
}

function Totals({ fund }: { fund: Fund }) {
  return <><Copy>Meta: {fund.target}</Copy><Copy>Ahorrado: {fund.saved}</Copy><Copy>Falta: {fund.remaining}</Copy><Copy>Progreso: {fund.progress}</Copy></>;
}

type FormMode = { kind: "create" } | { kind: "contribute"; fund: Fund };

function FundForm({ mode, writes, back, saved }: { mode: FormMode; writes: FundWrites; back: () => void; saved: (id: string) => void }) {
  const colors = paletteFor(useColorScheme());
  const pending = usePendingWrite();
  const fund = mode.kind === "contribute" ? mode.fund : null;
  const [name, setName] = useState(""), [currency, setCurrency] = useState(""), [amount, setAmount] = useState(""),
    [date, setDate] = useState(""), [account, setAccount] = useState(""), [notes, setNotes] = useState("");
  const [choices, setChoices] = useState<Awaited<ReturnType<FundWrites["loadAccounts"]>>>();
  const [error, fail] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    void writes.loadAccounts().then((rows) => { if (active) setChoices(rows); }, () => { if (active) fail(true); });
    return () => { active = false; };
  }, [writes, attempt]);
  const change = (set: (value: string) => void, value: string) => { pending.clear(); set(value); };
  const field = (label: string, value: string, set: (value: string) => void) => <View><Copy>{label}</Copy>
    <TextInput accessibilityLabel={label} value={value} onChangeText={(next) => change(set, next)} editable={!pending.busy} autoCorrect={false}
      style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} />
  </View>;
  const accounts = choices?.filter((row) => !fund || row.currency === fund.currency);
  return <AuthPanel>
    <Copy role="header">{fund ? `Aporte a ${fund.name}` : "Nuevo fondo"}</Copy>
    <AuthAction label={fund ? "Volver al fondo" : "Volver a fondos"} action={back} disabled={pending.busy} />
    {fund ? <Copy>Moneda: {fund.currency}</Copy> : <>{field("Nombre", name, setName)}{field("Moneda (ej. COP)", currency, setCurrency)}</>}
    {field(fund ? "Importe del aporte" : "Importe objetivo", amount, setAmount)}
    {field(fund ? "Fecha (AAAA-MM-DD, UTC)" : "Fecha objetivo (AAAA-MM-DD)", date, setDate)}
    {fund && field("Notas (opcional)", notes, setNotes)}
    <Copy>{fund ? "Cuenta del aporte" : "Cuenta asociada (opcional)"}</Copy>
    {error ? <><Copy role="alert">No pudimos cargar las cuentas.</Copy><AuthAction label="Recargar cuentas" action={() => { fail(false); retry((old) => old + 1); }} /></>
      : !accounts ? <Copy>Cargando cuentas…</Copy> : !accounts.length ? <Copy>No hay cuentas disponibles.</Copy> : null}
    {!fund && <AuthAction label="Sin cuenta asociada" selected={!account} disabled={pending.busy} action={() => change(setAccount, "")} />}
    {accounts?.map(({ id, name, currency: code }) => <AuthAction key={id} label={`Cuenta: ${name} (${code})`} selected={id === account}
      disabled={pending.busy} action={() => change(setAccount, id)} />)}
    {pending.error && <Copy role="alert">{pending.error}</Copy>}
    {pending.confirm && <AuthAction label={confirmPendingLabel} action={pending.confirm} disabled={pending.busy} />}
    <AuthAction label={fund ? "Registrar aporte" : "Crear fondo"} disabled={pending.busy || !!pending.confirm || (!!fund && !account)} action={() => void pending.run(async (confirmation) => {
      if (fund) {
        await writes.contribute(fund.id, fund.currency, { accountId: account, amount, date, notes }, confirmation);
        saved(fund.id);
      } else saved(await writes.create({ name, currency, targetAmount: amount, targetDate: date || null, linkedAccountId: account || null }, confirmation));
    }, "No pudimos guardar. Vuelve a intentarlo.")} />
  </AuthPanel>;
}

function Detail({ api, id, back, contribute }: { api: Funds; id: string; back: () => void; contribute?: (fund: Fund) => void }) {
  const [fund, setFund] = useState<Fund | null>();
  const [error, fail] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    void api.detail(id).then((row) => { if (active) setFund(row); }, () => { if (active) fail(true); });
    return () => { active = false; };
  }, [api, id, attempt]);
  return <AuthPanel>
    <AuthAction label="Volver a fondos" action={back} />
    {error ? <><Copy role="alert">No pudimos cargar el fondo.</Copy><AuthAction label="Reintentar" action={() => { fail(false); retry((old) => old + 1); }} /></>
      : fund === null ? <Copy>No encontramos el fondo.</Copy> : !fund ? <Copy>Cargando fondo…</Copy> : <>
        <Copy role="header">{fund.name}</Copy><Copy>{fundStatuses[fund.status]}</Copy>
        <Totals fund={fund} />
        {fund.targetDate && <Copy>Fecha objetivo: {fund.targetDate}</Copy>}
        {fund.recommended && <Copy>Aporte mensual recomendado: {fund.recommended}</Copy>}
        {contribute && <AuthAction label="Agregar aporte" action={() => contribute(fund)} />}
      </>}
  </AuthPanel>;
}

export function FundsScreen({ api, writes, back, nextView }: { api: Funds; writes?: FundWrites; back: () => void; nextView?: () => { api: Funds; writes?: FundWrites } }) {
  const view = useVisibleApi({ api, writes }, nextView);
  const [form, setForm] = useState<FormMode>();
  const needsRefresh = useRef(false);
  const [id, setId] = useState<string>(), [items, setItems] = useState<Fund[]>([]), [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(false);
  const sequence = useRef(0), seen = useRef(new Set<string>()), retry = useRef<() => void>(undefined);
  async function load(cursor?: string) {
    const ticket = ++sequence.current;
    setBusy(true); setError(false);
    if (!cursor) { setItems([]); setNext(null); seen.current.clear(); }
    try {
      const page = await view.api().api.list(cursor ? { cursor } : {});
      if (ticket !== sequence.current) return;
      if (cursor && (page.items.some((row) => items.some(({ id }) => id === row.id)) || (page.nextCursor && seen.current.has(page.nextCursor)))) throw new TypeError();
      if (cursor) seen.current.add(cursor);
      setItems([...(cursor ? items : []), ...page.items]); setNext(page.nextCursor);
    } catch {
      if (ticket === sequence.current) { retry.current = () => void load(cursor); setError(true); }
    } finally { if (ticket === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { ++sequence.current; }; }, [api]);
  if (form && writes) return <FundForm mode={form} writes={view.api().writes ?? writes} back={() => { view.move(); setForm(undefined); }} saved={(fundId) => {
    view.move(); needsRefresh.current = true; setId(fundId); setForm(undefined);
  }} />;
  if (id) return <Detail key={id} api={view.api().api} id={id} back={() => {
    view.move(); setId(undefined);
    if (needsRefresh.current) { needsRefresh.current = false; void load(); }
  }} contribute={writes ? (fund) => { view.move(); setForm({ kind: "contribute", fund }); } : undefined} />;
  return <AuthPanel>
    <Copy role="header">Fondos</Copy><AuthAction label="Volver al resumen" action={back} />
    {writes && <AuthAction label="Nuevo fondo" action={() => { view.move(); setForm({ kind: "create" }); }} />}
    {busy && <Copy>Cargando fondos…</Copy>}
    {error && <><Copy role="alert">No pudimos cargar los fondos.</Copy><AuthAction label="Reintentar" action={() => retry.current?.()} /></>}
    {!busy && !error && !items.length && <Copy>No hay fondos.</Copy>}
    {items.map((fund) => <View key={fund.id} style={{ gap: 4 }}><AuthAction label={fund.name} action={() => { view.move(); setId(fund.id); }} />
      <Copy>{fundStatuses[fund.status]}</Copy><Totals fund={fund} /></View>)}
    {next && !error && <AuthAction label="Cargar más" action={() => void load(next)} disabled={busy} />}
  </AuthPanel>;
}
