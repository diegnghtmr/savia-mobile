import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import { InvalidDraft } from "../foundation/identity-draft";
import { type Filters, type Transactions, statuses } from "../foundation/transactions";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";

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

function Detail({ api, id, back }: { api: Transactions; id: string; back: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<Transactions["detail"]>> | null>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let current = true;
    void api.detail(id).then((value) => { if (current) setData(value); }, () => { if (current) setData(null); });
    return () => { current = false; };
  }, [api, id, attempt]);
  return <>
    <AuthAction label="Volver a movimientos" action={back} />
    {data === null ? <><Copy role="alert">No pudimos cargar el movimiento.</Copy><AuthAction label="Reintentar" action={() => { setData(undefined); retry((n) => n + 1); }} /></>
      : !data ? <Copy>Cargando movimiento…</Copy> : <>
        <Copy role="header">{data.title}</Copy><Copy>{data.type} · {data.status}</Copy><Copy>{data.occurredAt}</Copy><Copy>{data.amount}</Copy>
        {data.equivalent && <Copy>Equivalente en moneda base: {data.equivalent}</Copy>}
        <Copy>Cuenta: {data.account}</Copy><Copy>Categoría: {data.category ?? "Sin categoría"}</Copy><Copy>Contraparte: {data.payee ?? "Sin contraparte"}</Copy>
        {data.tags.length > 0 && <Copy>Etiquetas: {data.tags.join(", ")}</Copy>}{data.notes && <Copy>{data.notes}</Copy>}
        {data.splits.length > 0 && <Copy>Divisiones</Copy>}
        {data.splits.map(({ category, amount, tags, notes }, index) => <View key={index}><Copy>{category} · {amount}</Copy>
          {tags.length > 0 && <Copy>{tags.join(", ")}</Copy>}{notes && <Copy>{notes}</Copy>}</View>)}
      </>}
  </>;
}

export function TransactionsScreen({ api, back }: { api: Transactions; back: () => void }) {
  const colors = paletteFor(useColorScheme());
  const [showFilters, toggleFilters] = useState(false);
  const [picker, setPicker] = useState<Selection>();
  const [selected, setSelected] = useState<Partial<Record<Selection, string>>>({});
  const [draft, setDraft] = useState<Filters>({ limit: "20" });
  const [applied, setApplied] = useState<Filters>({});
  const [visible, setVisible] = useState<string>();
  const [page, setPage] = useState(emptyPage);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0), seen = useRef(new Set<string>());
  const retry = useRef<() => void>(undefined);
  async function load(filters: Filters, cursor?: string) {
    const operation = ++sequence.current;
    setBusy(true); setError("");
    if (!cursor) setPage(emptyPage);
    try {
      const result = await api.list({ ...filters, ...(cursor && { cursor }) });
      if (sequence.current !== operation) return;
      if (cursor && (result.items.some(({ id }) => page.items.some((row) => row.id === id)) || (result.nextCursor && seen.current.has(result.nextCursor)))) throw new TypeError();
      if (cursor) seen.current.add(cursor); else seen.current.clear();
      setApplied(filters);
      setPage({ items: [...(cursor ? page.items : []), ...result.items], nextCursor: result.nextCursor });
    } catch (failure) {
      if (sequence.current !== operation) return;
      const invalid = failure instanceof InvalidDraft;
      retry.current = invalid ? undefined : () => void load(filters, cursor);
      setError(invalid ? failure.message : "No pudimos cargar los movimientos.");
    } finally { if (sequence.current === operation) setBusy(false); }
  }
  useEffect(() => { void load({}); return () => { ++sequence.current; }; }, [api]);
  function change(key: keyof Filters, value?: string) {
    setDraft((old) => { const next = { ...old }; if (value === undefined) delete next[key]; else next[key] = value; return next; });
  }
  if (visible) return <AuthPanel><Detail key={visible} api={api} id={visible} back={() => setVisible(undefined)} /></AuthPanel>;
  if (picker) return <AuthPanel><Picker api={api} field={picker} back={() => setPicker(undefined)} choose={(id, name) => {
    setSelected((old) => ({ ...old, [picker]: name })); change(picker, id); setPicker(undefined);
  }} /></AuthPanel>;
  return <AuthPanel>
    <Copy role="header">Movimientos</Copy><AuthAction label="Volver al resumen" action={back} />
    <AuthAction label="Filtros" selected={showFilters} action={() => toggleFilters(!showFilters)} />
    {showFilters && <>
      {(Object.keys(chooseLabel) as Selection[]).map((field) => <AuthAction key={field} label={selected[field] ? `${chooseLabel[field]}: ${selected[field]}` : chooseLabel[field]} action={() => setPicker(field)} disabled={busy} />)}
      <Copy>Estado del movimiento</Copy><AuthAction label="Todos" selected={!draft.status} action={() => change("status")} disabled={busy} />
      {Object.entries(statuses).map(([key, label]) => <AuthAction key={key} label={label} selected={draft.status === key} action={() => change("status", key)} disabled={busy} />)}
      {fields.map(([key, label]) => <View key={key}><Copy>{label}</Copy><TextInput accessibilityLabel={label} value={draft[key] ?? ""} editable={!busy}
        onChangeText={(text) => change(key, text === "" && key !== "limit" ? undefined : text)} style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} /></View>)}
      <AuthAction label="Aplicar filtros" disabled={busy} action={() => void load(draft)} />
    </>}
    {error && <><Copy role="alert">{error}</Copy>{retry.current && <AuthAction label="Reintentar" action={retry.current} disabled={busy} />}</>}
    {busy && <Copy>Cargando movimientos…</Copy>}
    {!busy && !error && !page.items.length && <Copy>No hay movimientos para estos filtros.</Copy>}
    {page.items.map(({ id, title, status, occurredAt, amount }) => <View key={id}><AuthAction label={title} action={() => setVisible(id)} />
      <Copy>{status} · {occurredAt} · {amount}</Copy></View>)}
    {page.nextCursor && !error && <AuthAction label="Cargar más" disabled={busy} action={() => void load(applied, page.nextCursor ?? undefined)} />}
  </AuthPanel>;
}
