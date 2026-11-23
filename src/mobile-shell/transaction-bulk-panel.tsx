import { useEffect, useState } from "react";
import { bulkConflict, bulkSingles, maxBulkTargets, type BulkAction, type BulkTransactions } from "../foundation/transaction-bulk";
import { InvalidDraft } from "../foundation/identity-draft";
import type { Transactions } from "../foundation/transactions";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { usePendingWrite } from "./use-pending-write";

const modes = { ...bulkSingles, categorize: "Categorizar", tag: "Agregar etiquetas", setPayee: "Asignar contraparte",
  convertImported: "Convertir importados", setExtraordinary: "Marcar como extraordinarios", clearExtraordinary: "Quitar clasificación extraordinaria" } as const;
type Mode = keyof typeof modes;
type Row = Awaited<ReturnType<Transactions["list"]>>["items"][number];
type Batch = { rows: Row[]; action: BulkAction; label: string };
const quantity = (count: number) => `${count} ${count === 1 ? "movimiento" : "movimientos"}`;
const lookup = { categorize: "categories", tag: "tags", setPayee: "payees" } as const;

export function TransactionBulkPanel({ api, items, back, finish, more, loading }: { api: BulkTransactions; items: Row[]; back: () => void;
  finish: (notice: string, conflict?: true) => void; more?: () => void; loading: boolean }) {
  const [selected, setSelected] = useState(new Map<string, Row>()), [mode, setMode] = useState<Mode>();
  const [choices, setChoices] = useState<Awaited<ReturnType<BulkTransactions["options"]>>>();
  const [value, setValue] = useState<string | null>(), [tags, setTags] = useState<string[]>([]), [batch, setBatch] = useState<Batch>();
  const { run, busy, error, confirm, clear } = usePendingWrite();
  const catalog = mode && Object.hasOwn(lookup, mode) ? lookup[mode as keyof typeof lookup] : undefined;
  useEffect(() => {
    if (catalog && !choices) void run(async () => setChoices(await api.options()), "No pudimos cargar las opciones del lote.");
  }, [catalog, api]);
  const change = (next: Mode) => { clear(); setMode(next); setValue(undefined); setTags([]); };
  const review = () => void run(async () => {
    if (!mode || !selected.size) throw new InvalidDraft("Selecciona los movimientos y una acción.");
    let label: string = modes[mode], action: BulkAction;
    switch (mode) {
      case "convertImported":
        if (value !== "income" && value !== "expense") throw new InvalidDraft("Selecciona Ingreso o Gasto.");
        action = { type: mode, targetType: value }; label += value === "income" ? ": Ingreso" : ": Gasto"; break;
      case "categorize": case "setPayee": {
        if (value === undefined || (value !== null && !choices?.[lookup[mode]].has(value))) throw new InvalidDraft("Selecciona una opción del catálogo.");
        action = mode === "categorize" ? { type: mode, categoryId: value } : { type: mode, payeeId: value };
        label += `: ${value === null ? mode === "categorize" ? "Sin categoría" : "Sin contraparte" : choices?.[lookup[mode]].get(value)}`; break;
      }
      case "tag":
        if (!tags.length || !tags.every((tag) => choices?.tags.has(tag))) throw new InvalidDraft("Selecciona al menos una etiqueta.");
        action = { type: mode, tagIds: tags }; label += `: ${tags.map((tag) => choices?.tags.get(tag)).join(", ")}`; break;
      case "setExtraordinary": case "clearExtraordinary": action = { type: "setExtraordinary", extraordinary: mode === "setExtraordinary" }; break;
      default: action = { type: mode };
    }
    setBatch({ rows: [...selected.values()], label, action });
  });
  const apply = (reviewed: Batch) => void run(async (confirmation) => {
    try {
      const count = await api.apply(reviewed.rows.map(({ id, version }) => ({ id, expectedVersion: version! })), reviewed.action, confirmation);
      finish(count === 1 ? "1 movimiento actualizado." : `${count} movimientos actualizados.`);
    } catch (failure) {
      if (bulkConflict(failure)) finish("Los movimientos cambiaron. Revisa la lista actualizada.", true);
      else throw failure;
    }
  }, "No pudimos aplicar el lote.");
  return <AuthPanel>
    <ReportText role="header">{batch ? "Revisar acciones en lote" : "Acciones en lote"}</ReportText>
    {batch ? <>
      <ReportText>{batch.label}</ReportText>
      <ReportText>Se aplicarán todos los cambios juntos o no se aplicará ninguno.</ReportText>
      {batch.rows.map(({ id, title, status, amount }) => <ReportText key={id}>{title} · {status} · {amount}</ReportText>)}
      <AuthAction label={`Aplicar a ${quantity(batch.rows.length)}`} disabled={busy || !!confirm} action={() => apply(batch)} />
      <AuthAction label="Editar lote" disabled={busy} action={() => { clear(); setBatch(undefined); }} />
    </> : <>
      <ReportText>Seleccionados: {selected.size} de {maxBulkTargets}</ReportText>
      {items.map((row) => <AuthAction key={row.id} label={`Seleccionar: ${row.title}`} selected={selected.has(row.id)}
        disabled={busy || row.version === null || (!selected.has(row.id) && selected.size >= maxBulkTargets)} action={() => {
          clear(); setSelected((old) => { const next = new Map(old); if (!next.delete(row.id)) next.set(row.id, row); return next; });
        }} />)}
      {more && <AuthAction label="Cargar más movimientos" disabled={busy || loading} action={more} />}
      {Object.entries(modes).map(([key, label]) => <AuthAction key={key} label={label} selected={mode === key} disabled={busy} action={() => change(key as Mode)} />)}
      {mode === "convertImported" && <>
        <AuthAction label="Ingreso" selected={value === "income"} action={() => { clear(); setValue("income"); }} />
        <AuthAction label="Gasto" selected={value === "expense"} action={() => { clear(); setValue("expense"); }} />
      </>}
      {(mode === "categorize" || mode === "setPayee") && <AuthAction label={mode === "categorize" ? "Sin categoría" : "Sin contraparte"}
        selected={value === null} action={() => { clear(); setValue(null); }} />}
      {catalog && choices && [...choices[catalog]].map(([id, name]) => <AuthAction key={id} label={name} selected={mode === "tag" ? tags.includes(id) : value === id}
        action={() => { clear(); if (mode === "tag") setTags((old) => old.includes(id) ? old.filter((tag) => tag !== id) : [...old, id]); else setValue(id); }} />)}
      <AuthAction label="Revisar lote" disabled={busy || loading} action={review} />
    </>}
    {error && <ReportText role="alert">{error}</ReportText>}
    {confirm && <AuthAction label="Confirmar reintento" disabled={busy} action={confirm} />}
    <AuthAction label="Cancelar lote" disabled={busy} action={back} />
  </AuthPanel>;
}
