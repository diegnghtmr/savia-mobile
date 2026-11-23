import { useState } from "react";
import { catalogLabels, categoryKinds, type Catalog, type CatalogWrites } from "../foundation/catalog-writes";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

export function CatalogWritesScreen({ api, back }: { api: CatalogWrites; back: () => void }) {
  const [catalog, select] = useState<Catalog>();
  return <AuthPanel>
    {catalog ? <CatalogForm key={catalog} catalog={catalog} api={api} back={() => select(undefined)} /> : <>
      <ReportText role="header">Crear en catálogos</ReportText>
      <AuthAction label="Volver al resumen" action={back} />
      {(Object.keys(catalogLabels) as Catalog[]).map((key) => <AuthAction key={key} label={catalogLabels[key].form} action={() => select(key)} />)}
    </>}
  </AuthPanel>;
}

function CatalogForm({ catalog, api, back }: { catalog: Catalog; api: CatalogWrites; back: () => void }) {
  const [name, setName] = useState(""), [kind, setKind] = useState(""), [essential, setEssential] = useState(false), [saved, setSaved] = useState(false);
  const { run, busy, error, clear, confirm } = usePendingWrite();
  const labels = catalogLabels[catalog], category = catalog === "categories";
  const edit = (change: () => void) => { clear(); setSaved(false); change(); };
  const save = () => void run(async (confirmation) => {
    await api.create(catalog, category ? { name, kind, essential } : { name }, confirmation);
    setName(""); setKind(""); setEssential(false); setSaved(true);
  }, "No pudimos crear el elemento. Vuelve a intentarlo.");
  return <>
    <ReportText role="header">{labels.form}</ReportText>
    <AuthAction label="Volver a catálogos" disabled={busy} action={back} />
    {saved && <ReportText>{labels.saved}</ReportText>}
    <PlanningField label="Nombre" value={name} change={(value) => edit(() => setName(value))} busy={busy} />
    {category && <>
      <ReportText>Tipo de categoría</ReportText>
      {Object.entries(categoryKinds).map(([key, label]) => <AuthAction key={key} label={label} disabled={busy} selected={kind === key} action={() => edit(() => setKind(key))} />)}
      <AuthAction label="Esencial" disabled={busy} selected={essential} action={() => edit(() => setEssential(!essential))} />
    </>}
    <AuthAction label={labels.create} disabled={busy || !!confirm} action={save} />
    {error && <ReportText role="alert">{error}</ReportText>}
    {confirm && <AuthAction label="Confirmar reintento" disabled={busy} action={confirm} />}
  </>;
}
