import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import type { AllocationDraft, BudgetWrites } from "../foundation/budget-writes";
import { methods, rollover, type BudgetDetail, type BudgetFilters, type Budgets } from "../foundation/budgets";
import { InvalidDraft } from "../foundation/identity-draft";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";
import { confirmPendingLabel, usePendingWrite } from "./use-pending-write";

function Copy({ children, role }: { children: ReactNode; role?: "header" | "alert" }) {
  const colors = paletteFor(useColorScheme());
  return <Text accessibilityRole={role} accessibilityLiveRegion={role === "alert" ? "polite" : undefined} style={{ color: colors.text, fontSize: role === "header" ? 26 : undefined }}>{children}</Text>;
}

function Field({ label, value, change, disabled }: { label: string; value: string; change: (value: string) => void; disabled: boolean }) {
  const colors = paletteFor(useColorScheme());
  return <View><Copy>{label}</Copy><TextInput accessibilityLabel={label} value={value} onChangeText={change} editable={!disabled} autoCorrect={false}
    style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} /></View>;
}

type Edit = { mode: "create"; source?: BudgetDetail } | { mode: "metadata" | "allocations"; budget: BudgetDetail; etag: string };

function AllocationSummary({ rows, names }: { rows: BudgetDetail["allocations"]; names?: Map<string, string> }) {
  const name = (id: string) => names?.get(id) ?? `Categoría ${id}`;
  return rows.length === 0 ? <Copy>Sin asignaciones.</Copy> : rows.map((row) => <View key={row.categoryId} style={{ gap: 4 }}>
    <Copy>{name(row.categoryId)}</Copy><Copy>Planeado: {row.planned}</Copy><Copy>Ejecutado: {row.actual}</Copy><Copy>Disponible: {row.available}</Copy>
    <Copy>Utilizado: {row.used}</Copy><Copy>Arrastre: {rollover[row.policy]}{row.target ? `: ${row.policy === "to_category" ? name(row.target) : row.target}` : ""}</Copy>
  </View>);
}

function Detail({ api, id, edit, back }: { api: Budgets; id: string; edit?: (values: Edit) => void; back: () => void }) {
  const [data, setData] = useState<BudgetDetail | null>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let current = true;
    void api.detail(id).then((value) => { if (current) setData(value); }, () => { if (current) setData(null); });
    return () => { current = false; };
  }, [api, id, attempt]);
  return <AuthPanel>
    <AuthAction label="Volver a presupuestos" action={back} />
    {data === null ? <><Copy role="alert">No pudimos cargar el presupuesto.</Copy><AuthAction label="Reintentar" action={() => { setData(undefined); retry((old) => old + 1); }} /></>
      : !data ? <Copy>Cargando presupuesto…</Copy> : <>
        <Copy role="header">{data.name}</Copy><Copy>{data.periodStart} – {data.periodEnd} · {methods[data.method]} · {data.currency}</Copy>
        {edit && <AuthAction label="Copiar a un nuevo presupuesto" action={() => edit({ mode: "create", source: data })} />}
        {edit && data.etag && <>
          <AuthAction label="Editar presupuesto" action={() => edit({ mode: "metadata", budget: data, etag: data.etag! })} />
          <AuthAction label="Editar asignaciones" action={() => edit({ mode: "allocations", budget: data, etag: data.etag! })} />
        </>}
        <Copy role="header">Asignaciones por categoría</Copy>
        <AllocationSummary rows={data.allocations} names={data.names} />
      </>}
  </AuthPanel>;
}

const conflict = "El presupuesto cambió. Vuelve al detalle antes de editarlo.";

function AllocationFields({ api, rows, change, blocked, retry }: { api: Budgets; rows: AllocationDraft[]; change: (rows: AllocationDraft[]) => void; blocked: boolean; retry: number }) {
  const [names, setNames] = useState<Map<string, string> | null>();
  const policies = (Object.keys(rollover) as (keyof typeof rollover)[]).filter((key) => key !== "to_fund");
  useEffect(() => {
    let current = true;
    void api.categories().then((items) => { if (current) setNames(items); }, () => { if (current) setNames(null); });
    return () => { current = false; };
  }, [api, retry]);
  const patch = (id: string, value: Partial<AllocationDraft>) => change(rows.map((row) => row.categoryId === id ? { ...row, ...value } : row));
  return <>
    {!names && <Copy role={names === null ? "alert" : undefined}>{names === null ? "No pudimos cargar las categorías." : "Cargando categorías…"}</Copy>}
    {rows.map(({ categoryId, planned, rolloverPolicy, rolloverTargetId }) => {
      const name = names?.get(categoryId) ?? categoryId;
      return <View key={categoryId} style={{ gap: 4 }}>
        <Copy role="header">{name}</Copy>
        <Field label={`Planeado: ${name}`} value={planned} change={(value) => patch(categoryId, { planned: value })} disabled={blocked} />
        {policies.map((key) => <AuthAction key={key} label={`${name}: ${rollover[key]}`} disabled={blocked} selected={key === rolloverPolicy}
          action={() => change(rows.map((row) => row.categoryId !== categoryId ? row : { categoryId, planned, rolloverPolicy: key }))} />)}
        {rolloverPolicy === "to_category" && [...(names ?? [])].map(([id, label]) => <AuthAction key={id} label={`Destino de ${name}: ${label}`} selected={rolloverTargetId === id}
          disabled={blocked} action={() => patch(categoryId, { rolloverTargetId: id })} />)}
        <AuthAction label={`Quitar asignación: ${name}`} disabled={blocked} action={() => change(rows.filter((row) => row.categoryId !== categoryId))} />
      </View>;
    })}
    {[...(names ?? [])].filter(([id]) => !rows.some((row) => row.categoryId === id)).map(([id, label]) => <AuthAction key={id} label={`Agregar asignación: ${label}`}
      disabled={blocked} action={() => change([...rows, { categoryId: id, planned: "", rolloverPolicy: "none" }])} />)}
  </>;
}

function Editor({ api, writes, edit, back, done }: { api: Budgets; writes: BudgetWrites; edit: Edit; back: () => void; done: (id: string) => void }) {
  const source = edit.mode === "create" ? edit.source : edit.budget;
  const [name, setName] = useState(source?.name ?? ""), [method, setMethod] = useState(source?.method ?? "cash_flow");
  const [start, setStart] = useState(""), [end, setEnd] = useState(""), [retry, refresh] = useState(0);
  const [rows, setRows] = useState<AllocationDraft[]>(() => edit.mode === "allocations" ? edit.budget.allocations.map((row) => ({
    categoryId: row.categoryId, planned: row.planned.split(" ")[0].replace("−", "-"), rolloverPolicy: row.policy, ...(row.target && { rolloverTargetId: row.target }),
  })) : []);
  const { run, busy, error, confirm } = usePendingWrite(conflict);
  const blocked = busy || !!confirm || error === conflict;
  function save() {
    void run(async (confirmation) => {
      // Keep the version captured on entry even if the server has changed or the prior reply was lost.
      if (edit.mode === "create") done(await writes.create({ name, method, periodStart: start, periodEnd: end, ...(edit.source && { copyFromBudgetId: edit.source.id }) }, confirmation));
      else if (edit.mode === "metadata") done(await writes.update(edit.budget.id, edit.etag,
        { ...(name !== edit.budget.name && { name }), ...(method !== edit.budget.method && { method }) }, confirmation));
      else done(await writes.replace(edit.budget.id, edit.etag, edit.budget.currency, rows, confirmation));
    }, edit.mode === "allocations" ? "No pudimos guardar las asignaciones." : "No pudimos guardar el presupuesto.");
  }
  return <AuthPanel>
    <Copy role="header">{edit.mode === "allocations" ? "Editar asignaciones" : edit.mode === "metadata" ? "Editar presupuesto" : source ? "Copiar presupuesto" : "Nuevo presupuesto"}</Copy>
    {edit.mode === "allocations" ? <>
      <Copy>Moneda: {edit.budget.currency}</Copy>
      <AllocationFields api={api} rows={rows} change={setRows} blocked={blocked} retry={retry} />
      <AuthAction label="Recargar categorías" disabled={blocked} action={() => refresh((value) => value + 1)} />
      <Copy>Guardar reemplaza todas las asignaciones por las que aparecen aquí.</Copy>
    </> : <>
      <Field label="Nombre" value={name} change={setName} disabled={blocked} />
      {(Object.keys(methods) as (keyof typeof methods)[]).map((key) => <AuthAction key={key} label={methods[key]} selected={key === method} disabled={blocked} action={() => setMethod(key)} />)}
      {edit.mode === "create" && <>
        <Field label="Inicio (AAAA-MM-DD)" value={start} change={setStart} disabled={blocked} />
        <Field label="Fin (AAAA-MM-DD)" value={end} change={setEnd} disabled={blocked} />
      </>}
    </>}
    <AuthAction label={edit.mode === "create" ? "Crear presupuesto" : edit.mode === "metadata" ? "Guardar cambios" : "Reemplazar asignaciones"}
      disabled={blocked || (edit.mode === "metadata" && name === edit.budget.name && method === edit.budget.method)} action={save} />
    {error && <Copy role="alert">{error}</Copy>}
    {confirm && <AuthAction label={confirmPendingLabel} disabled={busy} action={confirm} />}
    <AuthAction label={source ? "Volver al detalle" : "Cancelar"} action={back} disabled={busy} />
  </AuthPanel>;
}

const fields = [["from", "Desde (AAAA-MM-DD)"], ["to", "Hasta (AAAA-MM-DD)"], ["limit", "Resultados por página (1–200)"]] as const;
type Page = Awaited<ReturnType<Budgets["list"]>>;
const empty: Page = { items: [], nextCursor: null };
export function BudgetsScreen({ api, writes, back }: { api: Budgets; writes?: BudgetWrites; back: () => void }) {
  const [id, setId] = useState<string>(), [edit, setEdit] = useState<Edit>();
  const [draft, setDraft] = useState<BudgetFilters>({ limit: "20" }), [applied, setApplied] = useState<BudgetFilters>({});
  const [page, setPage] = useState(empty), [busy, setBusy] = useState(true), [error, setError] = useState("");
  const sequence = useRef(0), seen = useRef(new Set<string>());
  const retry = useRef<() => void>(undefined);
  async function load(filters: BudgetFilters, cursor?: string) {
    const ticket = ++sequence.current;
    setBusy(true); setError("");
    if (!cursor) { setPage(empty); seen.current.clear(); }
    try {
      const result = await api.list({ ...filters, ...(cursor && { cursor }) });
      if (ticket !== sequence.current) return;
      if (cursor && (result.items.some(({ id }) => page.items.some((row) => row.id === id)) || (result.nextCursor && seen.current.has(result.nextCursor)))) throw new TypeError();
      if (cursor) seen.current.add(cursor);
      setPage({ items: [...(cursor ? page.items : []), ...result.items], nextCursor: result.nextCursor }); setApplied(filters);
    } catch (failure) {
      if (ticket !== sequence.current) return;
      retry.current = failure instanceof InvalidDraft ? undefined : () => void load(filters, cursor);
      setError(failure instanceof InvalidDraft ? failure.message : "No pudimos cargar los presupuestos.");
    } finally { if (ticket === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load({}); return () => { ++sequence.current; }; }, [api]);
  if (edit && writes) return <Editor api={api} writes={writes} edit={edit} back={() => setEdit(undefined)} done={(result) => {
    setEdit(undefined); setId(result); void load(applied);
  }} />;
  if (id) return <Detail key={id} api={api} id={id} edit={writes ? setEdit : undefined} back={() => setId(undefined)} />;
  return <AuthPanel>
    <Copy role="header">Presupuestos</Copy><AuthAction label="Volver al resumen" action={back} />
    {writes && <AuthAction label="Nuevo presupuesto" action={() => setEdit({ mode: "create" })} />}
    {fields.map(([key, label]) => <Field key={key} label={label} value={draft[key] ?? ""} change={(value) => setDraft((old) => ({ ...old, [key]: value }))} disabled={busy} />)}
    <AuthAction label="Filtrar presupuestos" action={() => void load(Object.fromEntries(Object.entries(draft).filter(([key, value]) => key === "limit" || value !== "")))} disabled={busy} />
    {busy && <Copy>Cargando presupuestos…</Copy>}
    {error && <><Copy role="alert">{error}</Copy>{retry.current && <AuthAction label="Reintentar" action={retry.current} />}</>}
    {!busy && !error && !page.items.length && <Copy>No hay presupuestos para estos filtros.</Copy>}
    {page.items.map((row) => <View key={row.id}><AuthAction label={row.name} action={() => setId(row.id)} />
      <Copy>{row.periodStart} – {row.periodEnd} · {methods[row.method]}</Copy>
      <AllocationSummary rows={row.allocations} /></View>)}
    {page.nextCursor && !error && <AuthAction label="Cargar más" action={() => void load(applied, page.nextCursor ?? undefined)} disabled={busy} />}
  </AuthPanel>;
}
