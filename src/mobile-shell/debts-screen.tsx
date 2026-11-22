import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import { splitFields, type DebtPayments } from "../foundation/debt-payments";
import { debtStatuses, type Debt, type Debts } from "../foundation/debts";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";
import { confirmPendingLabel, usePendingWrite } from "./use-pending-write";

function Copy({ children, role }: { children: ReactNode; role?: "header" | "alert" }) {
  const colors = paletteFor(useColorScheme());
  return <Text accessibilityRole={role} accessibilityLiveRegion={role === "alert" ? "polite" : undefined} style={{ color: colors.text, fontSize: role === "header" ? 26 : undefined }}>{children}</Text>;
}
function Terms({ debt }: { debt: Debt }) {
  return <><Copy>Saldo pendiente: {debt.balance}</Copy><Copy>Tasa anual: {debt.annualRate}</Copy>
    <Copy>Pago mínimo: {debt.minimum ?? "No informado"}</Copy><Copy>Estado: {debtStatuses[debt.status]}</Copy></>;
}

function Projection({ api, debt }: { api: Debts; debt: Debt }) {
  const [result, setResult] = useState<Awaited<ReturnType<Debts["projection"]>>>(), [busy, setBusy] = useState(false), [error, fail] = useState(false);
  async function check() {
    setBusy(true); fail(false);
    try { setResult(await api.projection(debt.id, debt.currency)); }
    catch { fail(true); }
    finally { setBusy(false); }
  }
  if (result === null) return <Copy role="alert">Proyección no disponible</Copy>;
  if (!result) return <>{error && <Copy role="alert">No pudimos cargar la proyección.</Copy>}
    <AuthAction label={busy ? "Consultando proyección…" : "Ver proyección"} action={() => void check()} disabled={busy} /></>;
  return <>
    <Copy role="header">Proyección con pago mínimo</Copy><Copy>Fecha de cálculo: {result.asOf}</Copy>
    <Copy>Saldo inicial: {result.starting}</Copy><Copy>Interés total: {result.interest}</Copy><Copy>Costo total: {result.cost}</Copy>
    <Copy>Fecha estimada de liquidación: {result.payoff}</Copy>
    {result.schedule.map((row, index) => <View key={`${row.due}:${index}`} style={{ gap: 4 }}>
      <Copy>{row.due} · Pago: {row.payment}</Copy><Copy>Capital: {row.principal} · Interés: {row.interest} · Saldo: {row.balance}</Copy>
    </View>)}
  </>;
}

function PaymentForm({ debt, payments, back, saved }: { debt: Debt; payments: DebtPayments; back: () => void; saved: () => void }) {
  const colors = paletteFor(useColorScheme()), pending = usePendingWrite();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Awaited<ReturnType<DebtPayments["loadAccounts"]>>>();
  const [error, fail] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    void payments.loadAccounts().then((rows) => { if (active) setChoices(rows.filter((row) => row.currency === debt.currency)); }, () => { if (active) fail(true); });
    return () => { active = false; };
  }, [payments, debt.currency, attempt]);
  const change = (field: string, value: string) => { pending.clear(); setDraft((old) => ({ ...old, [field]: value })); };
  const fields = { totalAmount: "Importe total", date: "Fecha (AAAA-MM-DD, UTC)", ...splitFields };
  return <AuthPanel>
    <Copy role="header">Pago de {debt.name}</Copy><Copy>Moneda: {debt.currency}</Copy>
    <AuthAction label="Volver a la deuda" action={back} disabled={pending.busy} />
    {error ? <><Copy role="alert">No pudimos cargar las cuentas.</Copy><AuthAction label="Recargar cuentas" action={() => { fail(false); retry((old) => old + 1); }} /></>
      : !choices ? <Copy>Cargando cuentas…</Copy> : !choices.length ? <Copy>No hay cuentas disponibles en {debt.currency}.</Copy> : null}
    {choices?.map(({ id, name, currency }) => <AuthAction key={id} label={`Cuenta: ${name} (${currency})`} selected={id === draft.accountId}
      disabled={pending.busy} action={() => change("accountId", id)} />)}
    <Copy>Sin desglose, todo el pago se aplica a capital. Si indicas un desglose, sus importes deben sumar el total.</Copy>
    {Object.entries(fields).map(([field, label]) => <View key={field}><Copy>{label}</Copy>
      <TextInput accessibilityLabel={label} value={draft[field] ?? ""} onChangeText={(value) => change(field, value)} editable={!pending.busy} autoCorrect={false}
        style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} />
    </View>)}
    {pending.error && <Copy role="alert">{pending.error}</Copy>}
    {pending.confirm && <AuthAction label={confirmPendingLabel} action={pending.confirm} disabled={pending.busy} />}
    <AuthAction label="Guardar pago" disabled={!draft.accountId || pending.busy || !!pending.confirm} action={() => void pending.run(async (confirmation) => {
      const input = Object.fromEntries(Object.entries(draft).filter(([key, value]) => !Object.hasOwn(splitFields, key) || value.trim()));
      await payments.pay(debt.id, debt.currency, input, confirmation);
      saved();
    }, "No pudimos guardar el pago. Vuelve a intentarlo.")} />
  </AuthPanel>;
}

function Detail({ api, id, back, pay }: { api: Debts; id: string; back: () => void; pay?: (debt: Debt) => void }) {
  const [debt, setDebt] = useState<Debt | null>();
  const [error, fail] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    void api.detail(id).then((row) => { if (active) setDebt(row); }, () => { if (active) fail(true); });
    return () => { active = false; };
  }, [api, id, attempt]);
  return <AuthPanel>
    <AuthAction label="Volver a deudas" action={back} />
    {error ? <><Copy role="alert">No pudimos cargar la deuda.</Copy><AuthAction label="Reintentar" action={() => { fail(false); retry((old) => old + 1); }} /></>
      : debt === null ? <Copy>No encontramos la deuda.</Copy> : !debt ? <Copy>Cargando deuda…</Copy> : <>
        <Copy role="header">{debt.name}</Copy><Terms debt={debt} /><Copy>Capital inicial: {debt.principal}</Copy>
        {debt.rateType && <Copy>Tipo de tasa: {debt.rateType === "fixed" ? "Fija" : "Variable"}</Copy>}
        {debt.nextPaymentAt && <Copy>Próximo pago: {debt.nextPaymentAt}</Copy>}
        {pay && <AuthAction label="Registrar pago" action={() => pay(debt)} />}
        <Projection api={api} debt={debt} />
      </>}
  </AuthPanel>;
}

export function DebtsScreen({ api, payments, back }: { api: Debts; payments?: DebtPayments; back: () => void }) {
  const [paying, setPaying] = useState<Debt>();
  const needsRefresh = useRef(false);
  const [id, setId] = useState<string>(), [items, setItems] = useState<Debt[]>([]), [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(false);
  const sequence = useRef(0), seen = useRef(new Set<string>()), retry = useRef<() => void>(undefined);
  async function load(cursor?: string) {
    const ticket = ++sequence.current;
    setBusy(true); setError(false);
    if (!cursor) { setItems([]); setNext(null); seen.current.clear(); }
    try {
      const page = await api.list(cursor ? { cursor } : {});
      if (ticket !== sequence.current) return;
      if (cursor && (page.items.some((row) => items.some((item) => item.id === row.id)) || (page.nextCursor && seen.current.has(page.nextCursor)))) throw new TypeError();
      if (cursor) seen.current.add(cursor);
      setItems([...(cursor ? items : []), ...page.items]); setNext(page.nextCursor);
    } catch { if (ticket === sequence.current) { retry.current = () => void load(cursor); setError(true); } }
    finally { if (ticket === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { ++sequence.current; }; }, [api]);
  if (paying && payments) return <PaymentForm debt={paying} payments={payments} back={() => setPaying(undefined)} saved={() => {
    needsRefresh.current = true; setPaying(undefined);
  }} />;
  if (id) return <Detail key={id} api={api} id={id} pay={payments ? setPaying : undefined} back={() => {
    setId(undefined);
    if (needsRefresh.current) { needsRefresh.current = false; void load(); }
  }} />;
  return <AuthPanel>
    <Copy role="header">Deudas</Copy><AuthAction label="Volver al resumen" action={back} />
    {busy && <Copy>Cargando deudas…</Copy>}
    {error && <><Copy role="alert">No pudimos cargar las deudas.</Copy><AuthAction label="Reintentar" action={() => retry.current?.()} /></>}
    {!busy && !error && !items.length && <Copy>No hay deudas.</Copy>}
    {items.map((debt) => <View key={debt.id} style={{ gap: 4 }}><AuthAction label={debt.name} action={() => setId(debt.id)} /><Terms debt={debt} /></View>)}
    {next && !error && <AuthAction label="Cargar más" action={() => void load(next)} disabled={busy} />}
  </AuthPanel>;
}
