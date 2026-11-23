import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import { InvalidDraft } from "../foundation/identity-draft";
import type { BulkTransactions } from "../foundation/transaction-bulk";
import { type Filters, type LedgerDraft, type Transactions, statuses, types } from "../foundation/transactions";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";
import { TransactionBulkPanel } from "./transaction-bulk-panel";
import { useVisibleApi } from "./use-visible-api";
import { confirmPendingLabel, usePendingWrite } from "./use-pending-write";

function Copy({ children, role }: { children: ReactNode; role?: "header" | "alert" }) {
  const colors = paletteFor(useColorScheme());
  return <Text accessibilityRole={role} accessibilityLiveRegion={role === "alert" ? "polite" : undefined} style={{ color: colors.text, fontSize: role === "header" ? 26 : undefined }}>{children}</Text>;
}

type Selection = "accountId" | "categoryId";
const chooseLabel = { accountId: "Elegir cuenta", categoryId: "Elegir categoría" };
const fields = [["from", "Desde (AAAA-MM-DD)"], ["to", "Hasta (AAAA-MM-DD)"], ["query", "Buscar texto"], ["limit", "Resultados por página (1–200)"]] as const;
type Page = Awaited<ReturnType<Transactions["list"]>>;
const emptyPage: Page = { items: [], nextCursor: null };

function Picker({ api, field, choose, back }: { api: Transactions; field: Selection; choose: (id?: string, name?: string) => void; back: () => void }) {
  const [names, setNames] = useState<Map<string, string> | null>();
  useEffect(() => {
    let current = true;
    void api.options(field === "accountId" ? "accounts" : "categories").then((value) => { if (current) setNames(value); }, () => { if (current) setNames(null); });
    return () => { current = false; };
  }, [api, field]);
  return <>
    <Copy role="header">{chooseLabel[field]}</Copy><AuthAction label="Volver a filtros" action={back} />
    <AuthAction label="Quitar filtro" action={() => choose()} />
    {names === null ? <Copy role="alert">No pudimos cargar las opciones.</Copy> : !names ? <Copy>Cargando opciones…</Copy>
      : names.size === 0 ? <Copy>No hay opciones.</Copy> : Array.from(names, ([id, name]) => <AuthAction key={id} label={name} action={() => choose(id, name)} />)}
  </>;
}

function Field({ label, value, change, disabled }: { label: string; value: string; change: (value: string) => void; disabled: boolean }) {
  const colors = paletteFor(useColorScheme());
  return <View><Copy>{label}</Copy><TextInput accessibilityLabel={label} value={value} editable={!disabled} onChangeText={change}
    style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} /></View>;
}

const conflictMessage = "El movimiento cambió. Recarga sus datos antes de volver a intentarlo.";

function Editor({ api, baseline, blocked, cancelDisabled, save, back }: { api: Transactions; baseline?: LedgerDraft; blocked: boolean; cancelDisabled: boolean; save: (draft: LedgerDraft, form: object) => void; back: () => void }) {
  const creating = baseline === undefined;
  const form = useRef({});
  const [draft, setDraft] = useState<LedgerDraft>({});
  const [options, setOptions] = useState<Awaited<ReturnType<Transactions["formOptions"]>> | null>();
  useEffect(() => {
    let current = true;
    void api.formOptions(creating).then((value) => { if (current) setOptions(value); }, () => { if (current) setOptions(null); });
    return () => { current = false; };
  }, [api, creating]);
  const values = { ...baseline, ...draft };
  function choose<K extends keyof LedgerDraft>(key: K, value: LedgerDraft[K]) {
    setDraft((prev) => { const next = { ...prev, [key]: value }; if (JSON.stringify(value) === JSON.stringify(baseline?.[key])) delete next[key]; return next; });
  }
  const choices = (key: "type" | "accountId" | "categoryId" | "payeeId", title: string, names: Iterable<[string, string]>, empty?: string) => <>
    <Copy>{title}</Copy>{empty && <AuthAction label={empty} action={() => choose(key, null)} selected={!values[key]} disabled={blocked} />}
    {Array.from(names, ([id, name]) => <AuthAction key={id} label={name} action={() => choose(key, id)} selected={id === values[key]} disabled={blocked} />)}
  </>;
  return <>
    <Copy role="header">{creating ? "Nuevo movimiento" : "Editar movimiento"}</Copy>
    {options === null ? <Copy role="alert">No pudimos cargar las opciones del movimiento.</Copy> : !options ? <Copy>Cargando opciones…</Copy> : <>
      {creating && <>{choices("type", "Tipo", Object.entries(types))}{choices("accountId", "Cuenta", options.accounts)}
        <Field label="Importe" value={values.amount ?? ""} change={(text) => choose("amount", text)} disabled={blocked} /></>}
      <Field label="Fecha (AAAA-MM-DD, UTC)" value={values.date ?? ""} change={(text) => choose("date", text)} disabled={blocked} />
      <Field label="Descripción" value={values.description ?? ""} change={(text) => choose("description", text)} disabled={blocked} />
      {!creating && <AuthAction label="Extraordinario" selected={values.extraordinary === true} disabled={blocked}
        action={() => choose("extraordinary", values.extraordinary !== true)} />}
      {choices("categoryId", "Categoría", options.categories, "Sin categoría")}{choices("payeeId", "Contraparte", options.payees, "Sin contraparte")}
      <Copy>Etiquetas</Copy>{Array.from(options.tags, ([id, name]) => <AuthAction key={id} label={name} disabled={blocked} selected={values.tagIds?.includes(id) ?? false}
        action={() => { const tags = values.tagIds ?? []; choose("tagIds", tags.includes(id) ? tags.filter((tag) => tag !== id) : [...tags, id].sort()); }} />)}
      <AuthAction label={creating ? "Crear movimiento" : "Guardar cambios"} disabled={blocked || (!creating && !Object.keys(draft).length)} action={() => save(draft, form.current)} />
      {creating && <AuthAction label="Guardar borrador" disabled={blocked} action={() => save({ ...draft, status: "draft" }, form.current)} />}
    </>}
    <AuthAction label="Cancelar" disabled={cancelDisabled} action={back} />
  </>;
}

function Detail({ api, id, back, changed }: { api: Transactions; id: string; back: () => void; changed: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<Transactions["detail"]>> | null>();
  const [attempt, retry] = useState(0);
  const [mode, setMode] = useState<"edit" | "void">(), [reason, setReason] = useState("");
  const { run, busy, error, confirm, clear } = usePendingWrite(conflictMessage);
  const cancelDisabled = busy || error === conflictMessage;
  const blocked = cancelDisabled || !!confirm;
  const reload = () => { setData(undefined); retry((n) => n + 1); };
  const finish = () => { setMode(undefined); changed(); reload(); };
  const cancel = () => { setMode(undefined); setReason(""); clear(); };
  useEffect(() => {
    let current = true;
    void api.detail(id).then((value) => { if (current) setData(value); }, () => { if (current) setData(null); });
    return () => { current = false; };
  }, [api, id, attempt]);
  return <>
    <AuthAction label="Volver a movimientos" action={back} disabled={busy} />
    {data === null ? <><Copy role="alert">No pudimos cargar el movimiento.</Copy><AuthAction label="Reintentar" action={reload} /></>
      : !data ? <Copy>Cargando movimiento…</Copy> : <>
        <Copy role="header">{data.title}</Copy><Copy>{data.type} · {data.status}</Copy><Copy>{data.occurredAt}</Copy><Copy>{data.amount}</Copy>
        {data.extraordinary && <Copy>Movimiento extraordinario</Copy>}
        {data.equivalent && <Copy>Equivalente en moneda base: {data.equivalent}</Copy>}
        <Copy>Cuenta: {data.account}</Copy><Copy>Categoría: {data.category ?? "Sin categoría"}</Copy><Copy>Contraparte: {data.payee ?? "Sin contraparte"}</Copy>
        {data.tags.length > 0 && <Copy>Etiquetas: {data.tags.join(", ")}</Copy>}{data.notes && <Copy>{data.notes}</Copy>}
        {data.splits.length > 0 && <Copy>Divisiones</Copy>}
        {data.splits.map(({ category, amount, tags, notes }, index) => <View key={index}><Copy>{category} · {amount}</Copy>
          {tags.length > 0 && <Copy>{tags.join(", ")}</Copy>}{notes && <Copy>{notes}</Copy>}</View>)}
        {data.editable && (mode === "edit" ? <Editor api={api} baseline={data.editable.fields} blocked={blocked} cancelDisabled={cancelDisabled} back={cancel}
          save={(draft) => void run(async (confirmation) => { await api.update(id, data.editable!.etag, draft, confirmation); finish(); })} /> : mode === "void" && data.editable.canVoid ? <>
          <Copy role="header">Confirmar anulación</Copy><Copy>Se registrará una operación compensatoria; el movimiento no se elimina. Escribe un motivo de 3 a 500 caracteres.</Copy>
          <Field label="Motivo de anulación" value={reason} change={setReason} disabled={blocked} />
          <AuthAction label="Confirmar anulación" disabled={blocked} action={() => void run(async (confirmation) => { await api.void(id, data.editable!.etag, reason, true, confirmation); finish(); }, "No pudimos anular el movimiento. Vuelve a intentarlo.")} />
          <AuthAction label="Cancelar" disabled={cancelDisabled} action={cancel} />
        </> : <>
          <AuthAction label="Editar movimiento" disabled={busy} action={() => setMode("edit")} />
          {data.editable.canVoid && <AuthAction label="Anular movimiento" disabled={busy} action={() => { setReason(""); setMode("void"); }} />}
        </>)}
      </>}
    {error && <Copy role="alert">{error}</Copy>}
    {confirm && <AuthAction label={confirmPendingLabel} action={confirm} disabled={busy} />}
    {error === conflictMessage && <AuthAction label="Recargar movimiento" disabled={busy} action={() => void run(async () => {
      try { setData(await api.detail(id)); } catch { throw new InvalidDraft(conflictMessage); }
    })} />}
  </>;
}

export function TransactionsScreen({ api, bulk, back, startCreating = false, nextView }: { api: Transactions; bulk?: BulkTransactions; back: () => void; startCreating?: boolean; nextView?: () => Transactions }) {
  const view = useVisibleApi(api, nextView);
  const colors = paletteFor(useColorScheme());
  const [showFilters, toggleFilters] = useState(false);
  const [picker, setPicker] = useState<Selection>();
  const [selected, setSelected] = useState<Partial<Record<Selection, string>>>({});
  const [draft, setDraft] = useState<Filters>({ limit: "20" });
  const [applied, setApplied] = useState<Filters>({});
  const [visible, setVisible] = useState<string>();
  const [selecting, selectBulk] = useState(false), [bulkNotice, setBulkNotice] = useState<{ text: string; conflict?: true }>();
  const [creating, setCreating] = useState(startCreating);
  const create = (next: boolean) => { view.move(); setCreating(next); };
  const write = usePendingWrite(undefined, () => create(false));
  const changed = useRef(false);
  const [page, setPage] = useState(emptyPage);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0), seen = useRef(new Set<string>());
  const retry = useRef<() => void>(undefined);
  async function load(filters: Filters, cursor?: string, onlineOnly?: true) {
    const operation = ++sequence.current;
    setBusy(true); setError("");
    if (!cursor) setPage(emptyPage);
    try {
      const result = await view.api().list({ ...filters, ...(cursor && { cursor }) }, onlineOnly);
      if (sequence.current !== operation) return;
      if (cursor && (result.items.some(({ id }) => page.items.some((row) => row.id === id)) || (result.nextCursor && seen.current.has(result.nextCursor)))) throw new TypeError();
      if (cursor) seen.current.add(cursor); else seen.current.clear();
      setApplied(filters);
      setPage({ items: [...(cursor ? page.items : []), ...result.items], nextCursor: result.nextCursor });
    } catch (failure) {
      if (sequence.current !== operation) return;
      const invalid = failure instanceof InvalidDraft;
      retry.current = invalid ? undefined : () => void load(filters, cursor, onlineOnly);
      setError(invalid ? failure.message : "No pudimos cargar los movimientos.");
    } finally { if (sequence.current === operation) setBusy(false); }
  }
  useEffect(() => { void load({}); return () => { ++sequence.current; }; }, [api]);
  function change(key: keyof Filters, value?: string) {
    setDraft((old) => { const next = { ...old }; if (value === undefined) delete next[key]; else next[key] = value; return next; });
  }
  if (creating) return <AuthPanel>
    <Editor api={view.api()} blocked={write.busy || !!write.confirm} cancelDisabled={write.busy} back={() => { create(false); write.clear(); }} save={(draft, form) => void write.run(async (confirmation) => {
      await view.api().create(draft, confirmation, form); create(false); void load(applied);
    })} />
    {write.error && <Copy role="alert">{write.error}</Copy>}
    {write.confirm && <AuthAction label={confirmPendingLabel} action={write.confirm} disabled={write.busy} />}
  </AuthPanel>;
  if (visible) return <AuthPanel><Detail key={visible} api={view.api()} id={visible} changed={() => { changed.current = true; }} back={() => {
    view.move(); setVisible(undefined); if (changed.current) { changed.current = false; void load(applied); }
  }} /></AuthPanel>;
  if (picker) return <AuthPanel><Picker api={view.api()} field={picker} back={() => { view.move(); setPicker(undefined); }} choose={(id, name) => {
    view.move(); setSelected((old) => ({ ...old, [picker]: name })); change(picker, id); setPicker(undefined);
  }} /></AuthPanel>;
  if (bulk && selecting) return <TransactionBulkPanel api={bulk} items={page.items} back={() => selectBulk(false)} loading={busy}
    more={page.nextCursor && !error ? () => void load(applied, page.nextCursor!, true) : undefined} finish={(text, conflict) => {
      selectBulk(false); setBulkNotice({ text, conflict }); void load(applied, undefined, true);
    }} />;
  return <AuthPanel>
    <Copy role="header">Movimientos</Copy><AuthAction label="Volver al resumen" action={back} />
    <AuthAction label="Nuevo movimiento" action={() => { write.clear(); create(true); }} disabled={busy} />
    {bulk && page.items.some(({ version }) => version !== null) && <AuthAction label="Acciones en lote" disabled={busy} action={() => { setBulkNotice(undefined); selectBulk(true); }} />}
    {bulkNotice && <Copy role={bulkNotice.conflict ? "alert" : undefined}>{bulkNotice.text}</Copy>}
    {write.error && <Copy role="alert">{write.error}</Copy>}
    <AuthAction label="Filtros" selected={showFilters} action={() => toggleFilters(!showFilters)} />
    {showFilters && <>
      {(Object.keys(chooseLabel) as Selection[]).map((field) => <AuthAction key={field} label={selected[field] ? `${chooseLabel[field]}: ${selected[field]}` : chooseLabel[field]} action={() => { view.move(); setPicker(field); }} disabled={busy} />)}
      <Copy>Estado del movimiento</Copy><AuthAction label="Todos" selected={!draft.status} action={() => change("status")} disabled={busy} />
      {Object.entries(statuses).map(([key, label]) => <AuthAction key={key} label={label} selected={draft.status === key} action={() => change("status", key)} disabled={busy} />)}
      {fields.map(([key, label]) => <View key={key}><Copy>{label}</Copy><TextInput accessibilityLabel={label} value={draft[key] ?? ""} editable={!busy}
        onChangeText={(text) => change(key, text === "" && key !== "limit" ? undefined : text)} style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} /></View>)}
      <AuthAction label="Aplicar filtros" disabled={busy} action={() => void load(draft)} />
    </>}
    {error && <><Copy role="alert">{error}</Copy>{retry.current && <AuthAction label="Reintentar" action={retry.current} disabled={busy} />}</>}
    {busy && <Copy>Cargando movimientos…</Copy>}
    {!busy && !error && !page.items.length && <Copy>No hay movimientos para estos filtros.</Copy>}
    {page.items.map(({ id, title, status, occurredAt, amount }) => <View key={id}><AuthAction label={title} action={() => { view.move(); setVisible(id); }} />
      <Copy>{status} · {occurredAt} · {amount}</Copy></View>)}
    {page.nextCursor && !error && <AuthAction label="Cargar más" disabled={busy} action={() => void load(applied, page.nextCursor ?? undefined)} />}
  </AuthPanel>;
}
