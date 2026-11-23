import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import type { FundWrites } from "../foundation/fund-writes";
import { fundStatuses, type Fund, type FundDetail, type Funds } from "../foundation/funds";
import { InvalidDraft } from "../foundation/identity-draft";
import { TransportError } from "../foundation/transport";
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

type FormMode = { kind: "create" } | { kind: "contribute" | "withdraw"; fund: Fund } | { kind: "edit"; fund: FundDetail };
const targetInput = (fund?: FundDetail | null) => fund?.target.split(" ")[0] ?? "";
const hasDetail = (fund: Fund | FundDetail | null): fund is FundDetail => !!fund && "etag" in fund;

function FundForm({ mode, api, writes, back, saved }: { mode: FormMode; api: Funds; writes: FundWrites; back: () => void; saved: (id: string) => void }) {
  const colors = paletteFor(useColorScheme());
  const pending = usePendingWrite();
  const fund = mode.kind === "create" ? null : mode.fund, withdrawal = mode.kind === "withdraw", contribution = mode.kind === "contribute";
  const [edit, setEdit] = useState<FundDetail | null>(mode.kind === "edit" ? mode.fund : null);
  const [name, setName] = useState(edit?.name ?? ""), [currency, setCurrency] = useState(""), [amount, setAmount] = useState(targetInput(edit)),
    [date, setDate] = useState(edit?.targetDate ?? ""), [account, setAccount] = useState(edit?.linkedAccountId ?? ""), [notes, setNotes] = useState(edit?.objective ?? ""),
    [responsible, setResponsible] = useState(edit?.responsible.join(", ") ?? "");
  const title = edit ? "Editar fondo" : withdrawal ? `Retiro de ${fund?.name}` : contribution ? `Aporte a ${fund?.name}` : "Nuevo fondo";
  const submit = edit ? "Guardar cambios del fondo" : withdrawal ? "Registrar retiro" : contribution ? "Registrar aporte" : "Crear fondo";
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
  const accounts = choices?.filter((row) => !fund || !!edit || row.currency === fund.currency);
  return <AuthPanel>
    <Copy role="header">{title}</Copy>
    <AuthAction label={fund ? "Volver al fondo" : "Volver a fondos"} action={back} disabled={pending.busy} />
    {(!fund || edit) && field("Nombre", name, setName)}
    {fund ? <Copy>Moneda: {fund.currency}</Copy> : field("Moneda (ej. COP)", currency, setCurrency)}
    {field(withdrawal ? "Importe del retiro" : contribution ? "Importe del aporte" : "Importe objetivo", amount, setAmount)}
    {!withdrawal && field(contribution ? "Fecha (AAAA-MM-DD, UTC)" : "Fecha objetivo (AAAA-MM-DD)", date, setDate)}
    {(fund || edit) && field(withdrawal ? "Motivo del retiro" : contribution ? "Notas (opcional)" : "Objetivo (opcional)", notes, setNotes)}
    {edit && field("IDs de miembros responsables (separados por comas)", responsible, setResponsible)}
    <Copy>{withdrawal ? "Cuenta de destino" : contribution ? "Cuenta del aporte" : "Cuenta asociada (opcional)"}</Copy>
    {error ? <><Copy role="alert">No pudimos cargar las cuentas.</Copy><AuthAction label="Recargar cuentas" action={() => { fail(false); retry((old) => old + 1); }} /></>
      : !accounts ? <Copy>Cargando cuentas…</Copy> : !accounts.length ? <Copy>No hay cuentas disponibles.</Copy> : null}
    {!contribution && !withdrawal && <AuthAction label="Sin cuenta asociada" selected={!account} disabled={pending.busy} action={() => change(setAccount, "")} />}
    {accounts?.map(({ id, name, currency: code }) => <AuthAction key={id} label={`Cuenta: ${name} (${code})`} selected={id === account}
      disabled={pending.busy} action={() => change(setAccount, id)} />)}
    {pending.error && <Copy role="alert">{pending.error}</Copy>}
    {pending.confirm && <AuthAction label={confirmPendingLabel} action={pending.confirm} disabled={pending.busy} />}
    <AuthAction label={submit} disabled={pending.busy || !!pending.confirm || ((contribution || withdrawal) && !account)} action={() => void pending.run(async (confirmation) => {
      if (edit) {
        const body = { ...(name !== edit.name && { name }), ...(amount !== targetInput(edit) && { targetAmount: amount }),
          ...(notes !== (edit.objective ?? "") && { objective: notes.trim() || null }),
          ...(date !== (edit.targetDate ?? "") && { targetDate: date || null }),
          ...(account !== (edit.linkedAccountId ?? "") && { linkedAccountId: account || null }),
          ...(responsible !== edit.responsible.join(", ") && { responsibleMemberIds: responsible.trim() ? responsible.split(",").map((id) => id.trim()) : [] }) };
        try { await writes.update(edit.id, edit.currency, edit.etag, body, confirmation); }
        catch (error) {
          if (!(error instanceof TransportError && error.status === 412)) throw error;
          const fresh = await api.detail(edit.id);
          if (!hasDetail(fresh)) throw new InvalidDraft("No pudimos obtener los datos actualizados. Vuelve al fondo antes de editarlo.");
          setEdit(fresh); setName(fresh.name); setAmount(targetInput(fresh)); setDate(fresh.targetDate ?? "");
          setNotes(fresh.objective ?? ""); setAccount(fresh.linkedAccountId ?? ""); setResponsible(fresh.responsible.join(", "));
          throw new InvalidDraft("El fondo cambió. Revisa los datos actualizados.");
        }
        saved(edit.id);
      } else if (fund) {
        if (withdrawal) await writes.withdraw(fund.id, fund.currency, { accountId: account, amount, reason: notes }, confirmation);
        else await writes.contribute(fund.id, fund.currency, { accountId: account, amount, date, notes }, confirmation);
        saved(fund.id);
      } else saved(await writes.create({ name, currency, targetAmount: amount, targetDate: date || null, linkedAccountId: account || null }, confirmation));
    }, "No pudimos guardar. Vuelve a intentarlo.")} />
  </AuthPanel>;
}

function Detail({ api, id, back, openForm }: { api: Funds; id: string; back: () => void; openForm?: (mode: FormMode) => void }) {
  const [fund, setFund] = useState<Fund | FundDetail | null>();
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
        {openForm && <AuthAction label="Agregar aporte" action={() => openForm({ kind: "contribute", fund })} />}
        {hasDetail(fund) && <>
          {fund.objective && <Copy>Objetivo: {fund.objective}</Copy>}
          {openForm && <><AuthAction label="Editar fondo" action={() => openForm({ kind: "edit", fund })} />
            <AuthAction label="Retirar del fondo" action={() => openForm({ kind: "withdraw", fund })} /></>}
        </>}
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
  if (form && writes) return <FundForm mode={form} api={view.api().api} writes={view.api().writes ?? writes} back={() => { view.move(); setForm(undefined); }} saved={(fundId) => {
    view.move(); needsRefresh.current = true; setId(fundId); setForm(undefined);
  }} />;
  if (id) return <Detail key={id} api={view.api().api} id={id} back={() => {
    view.move(); setId(undefined);
    if (needsRefresh.current) { needsRefresh.current = false; void load(); }
  }} openForm={writes ? (mode) => { view.move(); setForm(mode); } : undefined} />;
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
