import { useState } from "react";
import type { ImportCommits } from "../foundation/import-commits";
import { importStatuses, validateStatement, type ImportJob, type Imports, type StatementFile, type StatementFileSource } from "../foundation/imports";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ImportCommitForm } from "./import-commit-form";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

export function ImportsScreen({ api, back, source, commits }: { api: Imports; back: () => void; source?: StatementFileSource; commits?: ImportCommits }) {
  const [file, setFile] = useState<StatementFile>(), [job, setJob] = useState<ImportJob>();
  const [id, setId] = useState("");
  const write = usePendingWrite();
  const open = (value: ImportJob) => { setJob(value); setId(value.id); };
  const detail = (id: string) => void write.run(async () => { setJob(undefined); open(await api.detail(id)); }, "No pudimos consultar la importación.");
  return <AuthPanel>
    <ReportText role="header">Importar extractos</ReportText><AuthAction label="Volver al resumen" action={back} />
    <ReportText>CSV de hasta 5 MiB. QIF y OFX todavía no están disponibles en el servidor.</ReportText>
    {source ? <AuthAction label="Elegir extracto" disabled={write.busy} action={() => void write.run(async () => {
      setFile(undefined); const selected = await source(); if (selected) setFile(validateStatement(selected));
    }, "No pudimos abrir el selector de archivos.")} /> : <ReportText>Selector de archivos no disponible en esta instalación.</ReportText>}
    {file && <><ReportText>{file.name}</ReportText><AuthAction label="Subir para analizar" disabled={write.busy} action={() => void write.run(async () => {
      setJob(undefined); open(await api.upload(file)); setFile(undefined);
    }, "No pudimos subir el extracto. Inténtalo con conexión.")} /></>}
    <PlanningField label="Identificador de la importación" value={id} change={setId} busy={write.busy} />
    <AuthAction label="Consultar importación" disabled={write.busy} action={() => detail(id)} />
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {job && <><ReportText role="header">{importStatuses[job.status]}</ReportText><ReportText>{job.fileName}</ReportText>
      <ReportText>Identificador: {job.id}</ReportText>
      {job.counts.map(({ label, count }) => <ReportText key={label}>{label}: {count === null ? "No informado" : count}</ReportText>)}
      <ReportText>El servidor no muestra las filas individuales.</ReportText>
      <AuthAction label="Actualizar estado" disabled={write.busy} action={() => detail(job.id)} />
      {commits && (job.status === "awaiting_mapping" || job.status === "awaiting_confirmation") && (job.sourceColumns.length
        ? <ImportCommitForm key={job.id} job={job} writes={commits} onComplete={() => setJob((current) => current?.id === job.id ? { ...current, status: "completed" } : current)} />
        : <ReportText role="alert">El servidor no informó las columnas de la importación.</ReportText>)}
    </>}
  </AuthPanel>;
}
