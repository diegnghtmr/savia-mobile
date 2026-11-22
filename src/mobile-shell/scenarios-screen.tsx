import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { assumptionFields, assumptionNames, type AssumptionType, type Scenario, type Scenarios } from "../foundation/scenarios";
import { AuthAction, AuthPanel } from "./auth-gate";
import { FxFreshness, ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

type Comparison = Awaited<ReturnType<Scenarios["run"]>>;
const labels = ["Base", "Proyección", "Diferencia"];
const loadError = "No pudimos cargar los escenarios.";
export function ScenariosScreen({ api, back }: { api: Scenarios; back: () => void }) {
  const [rows, setRows] = useState<Scenario[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [selected, select] = useState<Scenario>(), [simulation, setSimulation] = useState<Comparison>();
  const [create, setCreate] = useState(false), [name, setName] = useState(""), [description, setDescription] = useState("");
  const [type, setType] = useState<AssumptionType>("purchase"), [draft, setDraft] = useState<Record<string, string>>({});
  const [assumptions, setAssumptions] = useState<Array<{ type: AssumptionType; values: Record<string, string> }>>([]);
  const seen = useRef(new Set<string>()), write = usePendingWrite();
  async function list(after?: string) {
    if (!after) { seen.current.clear(); setRows([]); setCursor(null); }
    const page = await api.list(after ? { cursor: after } : {});
    if (page.nextCursor && seen.current.has(page.nextCursor)) { setCursor(null); throw new TypeError(); }
    if (page.nextCursor) seen.current.add(page.nextCursor);
    setRows((old) => after ? [...old, ...page.items.filter((row) => !old.some(({ id }) => id === row.id))] : page.items);
    setCursor(page.nextCursor);
  }
  useEffect(() => { void write.run(() => list(), loadError); }, [api]);
  const close = () => { select(undefined); setSimulation(undefined); write.clear(); };
  const clearForm = () => { setCreate(false); setName(""); setDescription(""); setDraft({}); setAssumptions([]); write.clear(); };
  const addAssumption = () => { setAssumptions((old) => [...old, { type, values: draft }]); setDraft({}); };
  return <AuthPanel>
    <ReportText role="header">Escenarios</ReportText><AuthAction label="Volver al resumen" action={back} />
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {selected ? <>
      <AuthAction label="Volver a escenarios" disabled={write.busy} action={close} /><ReportText role="header">{selected.name}</ReportText>
      {selected.description && <ReportText>{selected.description}</ReportText>}
      {selected.assumptions.map(({ type, value }, index) => <ReportText key={index}>{assumptionNames[type]}: {Object.entries(value)
        .filter(([, entry]) => typeof entry === "string" || typeof entry === "number").map(([key, entry]) =>
          `${(assumptionFields[type] as Record<string, string>)[key] ?? key}: ${String(entry)}`).join(" · ")}</ReportText>)}
      <ReportText>La API no permite editar escenarios guardados.</ReportText>
      <AuthAction label="Simular escenario" disabled={write.busy} action={() => void write.run(async () => {
        setSimulation(undefined); setSimulation(await api.run(selected.id));
      }, "No pudimos simular el escenario.")} />
      {simulation && <><ReportText>{simulation.status === "failed" ? "No se pudo aplicar el escenario." : "Simulación completada"}</ReportText><FxFreshness />
        {simulation.figures.map((figures, index) => <View key={labels[index]}><ReportText role="header">{labels[index]}</ReportText>
          {figures.map(({ label, value }) => <ReportText key={label}>{label}: {value}</ReportText>)}</View>)}
        {simulation.risks.map((risk, index) => <ReportText key={index}>{risk}</ReportText>)}</>}
    </> : create ? <>
      <AuthAction label="Cancelar" action={clearForm} disabled={write.busy} />
      <PlanningField label="Nombre del escenario" value={name} change={setName} busy={write.busy} />
      <PlanningField label="Descripción (opcional)" value={description} change={setDescription} busy={write.busy} />
      <ReportText>Supuestos añadidos: {assumptions.length}</ReportText>
      {assumptions.map(({ type }, index) => <AuthAction key={index} label={`Quitar supuesto ${index + 1}: ${assumptionNames[type]}`} disabled={write.busy}
        action={() => setAssumptions((old) => old.filter((_, i) => i !== index))} />)}
      {(Object.keys(assumptionNames) as AssumptionType[]).map((choice) => <AuthAction key={choice} label={assumptionNames[choice]} selected={choice === type}
        disabled={write.busy} action={() => { setType(choice); setDraft({}); }} />)}
      {Object.entries(assumptionFields[type]).map(([key, label]) => <PlanningField key={key} label={label} value={draft[key] ?? ""}
        change={(value) => setDraft((old) => ({ ...old, [key]: value }))} busy={write.busy} />)}
      <AuthAction label="Añadir otro supuesto" disabled={write.busy || !Object.values(draft).some(Boolean)} action={addAssumption} />
      <AuthAction label="Guardar escenario" disabled={write.busy} action={() => void write.run(async () => {
        const entries = assumptions.map(({ type, values }) => ({ type, ...values }));
        if (Object.values(draft).some(Boolean)) entries.push({ type, ...draft });
        const row = await api.create({ name, description, assumptions: entries });
        setRows((old) => [row, ...old.filter(({ id }) => id !== row.id)]); clearForm(); select(row);
      }, "No pudimos guardar el escenario.")} />
    </> : <>
      <AuthAction label="Nuevo escenario" disabled={write.busy} action={() => { setCreate(true); write.clear(); }} />
      <AuthAction label="Actualizar escenarios" disabled={write.busy} action={() => void write.run(() => list(), loadError)} />
      {!write.busy && !write.error && !rows.length && <ReportText>No hay escenarios guardados.</ReportText>}
      {rows.map((row) => <AuthAction key={row.id} label={row.name} disabled={write.busy} action={() => { write.clear(); select(row); }} />)}
      {cursor && <AuthAction label="Cargar más" disabled={write.busy} action={() => void write.run(() => list(cursor), loadError)} />}
    </>}
  </AuthPanel>;
}
