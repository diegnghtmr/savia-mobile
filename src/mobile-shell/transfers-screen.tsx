import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import { InvalidDraft } from "../foundation/identity-draft";
import type { RateFilters, TransferDraft, TransferMode, Transfers } from "../foundation/transfers";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";
import { confirmPendingLabel, usePendingWrite } from "./use-pending-write";

function Copy({ children, role }: { children: ReactNode; role?: "header" | "alert" }) {
  const colors = paletteFor(useColorScheme());
  return <Text accessibilityRole={role} accessibilityLiveRegion={role === "alert" ? "polite" : undefined} style={{ color: colors.text, fontSize: role === "header" ? 26 : undefined }}>{children}</Text>;
}

function Field({ label, value, change, busy }: { label: string; value: string; change: (value: string) => void; busy: boolean }) {
  const colors = paletteFor(useColorScheme());
  return <View><Copy>{label}</Copy><TextInput accessibilityLabel={label} value={value} onChangeText={change} editable={!busy} autoCorrect={false}
    style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} /></View>;
}

const filters = [["baseCurrency", "Moneda base"], ["quoteCurrency", "Moneda cotizada"], ["from", "Desde (AAAA-MM-DD)"], ["to", "Hasta (AAAA-MM-DD)"]] as const;
function Rates({ api }: { api: Transfers }) {
  const [draft, setDraft] = useState<RateFilters>({});
  const [rates, setRates] = useState<Awaited<ReturnType<Transfers["rates"]>>>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(true);
  const sequence = useRef(0);
  async function load(input: RateFilters) {
    const operation = ++sequence.current;
    setBusy(true); setError(""); setRates([]);
    try { const rows = await api.rates(input); if (operation === sequence.current) setRates(rows); }
    catch (failure) { if (operation === sequence.current) setError(failure instanceof InvalidDraft ? failure.message : "No pudimos cargar las tasas."); }
    finally { if (operation === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load({}); return () => { ++sequence.current; }; }, [api]);
  return <>
    <Copy role="header">Tasas de cambio</Copy>
    {filters.map(([key, label]) => <Field key={key} label={label} value={draft[key] ?? ""} busy={busy} change={(value) => setDraft((old) => ({ ...old, [key]: value }))} />)}
    <AuthAction label="Filtrar tasas" disabled={busy} action={() => void load(Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== "")))} />
    {busy ? <Copy>Cargando tasas…</Copy> : error ? <Copy role="alert">{error}</Copy> : rates.length === 0 ? <Copy>No hay tasas para estos filtros.</Copy> :
      rates.map(({ id, baseCurrency, quoteCurrency, rate, source, manual, effectiveAt, stale, ageHours }) => <View key={id} style={{ gap: 4 }}>
        <Copy>1 {baseCurrency} = {rate} {quoteCurrency}</Copy><Copy>Fuente: {source}{manual ? " (manual)" : ""}</Copy>
        <Copy>Vigente desde: {effectiveAt}</Copy><Copy>Estado: {stale === null ? "No disponible" : stale ? "Desactualizada" : "Vigente"}</Copy>
        <Copy>Antigüedad: {ageHours === null ? "No disponible" : `${String(ageHours).replace(".", ",")} h`}</Copy>
      </View>)}
  </>;
}

type Choices = Awaited<ReturnType<Transfers["loadAccounts"]>>;
const modes = { transfer: "Misma moneda", exchange: "Cambio de moneda", rates: "Tasas de cambio" } as const;
function TransferForm({ mode, accounts, busy, submit }: { mode: TransferMode; accounts: Choices; busy: boolean; submit: (draft: TransferDraft, complete: () => void) => void }) {
  const [draft, setDraft] = useState<TransferDraft>({});
  const set = (field: keyof TransferDraft, value: string) => setDraft((old) => ({ ...old, [field]: value }));
  const field = (key: keyof TransferDraft, label: string) => <Field label={label} value={draft[key] ?? ""} busy={busy} change={(value) => set(key, value)} />;
  const picker = (key: "sourceAccountId" | "destinationAccountId", label: string) => <>
    <Copy>{label}</Copy>
    {accounts.map(({ id, name, currency }) => <AuthAction key={id} label={`${label}: ${name} (${currency})`} action={() => set(key, id)} selected={draft[key] === id} disabled={busy} />)}
  </>;
  return <>
    <Copy>{mode === "transfer" ? "Elige dos cuentas distintas de la misma moneda." : "Elige dos cuentas de monedas distintas. Escribe el importe recibido y la tasa aplicada."}</Copy>
    {picker("sourceAccountId", "Origen")}{picker("destinationAccountId", "Destino")}{field("amount", "Importe enviado")}
    {mode === "exchange" && <>{field("received", "Importe recibido")}{field("executedRate", "Tasa ejecutada")}</>}
    {field("date", "Fecha (AAAA-MM-DD, UTC)")}{field("description", "Descripción (opcional)")}
    <AuthAction label={mode === "transfer" ? "Registrar transferencia" : "Registrar cambio"} disabled={busy} action={() => submit(draft, () => setDraft({}))} />
  </>;
}

export function TransfersScreen({ api, back }: { api: Transfers; back: () => void }) {
  const [mode, select] = useState<keyof typeof modes>("transfer");
  const [accounts, setAccounts] = useState<Choices | null>();
  const [attempt, retry] = useState(0);
  const { run, busy, error, confirm, clear } = usePendingWrite();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let current = true;
    void api.loadAccounts().then((value) => { if (current) setAccounts(value); }, () => { if (current) setAccounts(null); });
    return () => { current = false; };
  }, [api, attempt]);
  function submit(draft: TransferDraft, complete: () => void) {
    void run(async (confirmation) => {
      setNotice("");
      await api.submit(mode, draft, confirmation);
      complete();
      setNotice(mode === "transfer" ? "Transferencia registrada." : "Cambio de moneda registrado.");
    }, "No pudimos registrar la operación. Vuelve a intentarlo.");
  }
  return <AuthPanel>
    <Copy role="header">Transferencias</Copy><AuthAction label="Volver al resumen" action={back} disabled={busy} />
    {(Object.keys(modes) as (keyof typeof modes)[]).map((key) => <AuthAction key={key} label={modes[key]} selected={mode === key} disabled={busy}
      action={() => { select(key); clear(); setNotice(""); }} />)}
    {mode === "rates" ? <Rates api={api} /> : accounts === null ? <>
      <Copy role="alert">No pudimos cargar las cuentas.</Copy><AuthAction label="Reintentar" action={() => { setAccounts(undefined); retry((n) => n + 1); }} />
    </> : !accounts ? <Copy>Cargando cuentas…</Copy> : accounts.length < 2 ? <Copy>Necesitas dos cuentas para registrar esta operación.</Copy>
      : <TransferForm key={mode} mode={mode} accounts={accounts} busy={busy || !!confirm} submit={submit} />}
    {error && <Copy role="alert">{error}</Copy>}{notice && <Copy>{notice}</Copy>}
    {confirm && <AuthAction label={confirmPendingLabel} action={confirm} disabled={busy} />}
  </AuthPanel>;
}
