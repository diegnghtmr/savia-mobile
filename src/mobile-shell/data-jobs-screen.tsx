import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { backupForbidden, exportFormats, inProgress, jobStatuses, reportFormats, reportPresets, resources, type DataJob, type DataJobs, type JobDraft, type JobKind, type ReportSelection } from "../foundation/data-jobs";
import { AuthAction, AuthPanel } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

const pollInterval = 2000, maxPolls = 12;
const labels = { report: "Ejecutar informes", export: "Exportar datos", backup: "Copia completa" } as const;
const createLabels = { report: "Generar informe", export: "Crear exportación", backup: "Crear copia completa" } as const;

export function DataJobsScreen({ api, back }: { api: DataJobs; back: () => void }) {
  const [kind, setKind] = useState<JobKind>("report");
  return <AuthPanel>
    <ReportText role="header">Informes y exportaciones</ReportText>
    <AuthAction label="Volver al resumen" action={back} />
    {Object.entries(labels).map(([key, label]) => <AuthAction key={key} label={label} disabled={key === kind} action={() => setKind(key as JobKind)} />)}
    <JobPanel key={kind} api={api} kind={kind} />
  </AuthPanel>;
}

function JobPanel({ api, kind }: { api: DataJobs; kind: JobKind }) {
  const [job, setJob] = useState<DataJob>(), [owner, setOwner] = useState<boolean>();
  const [page, setPage] = useState<Awaited<ReturnType<DataJobs["definitions"]>>>();
  const [report, selectReport] = useState<ReportSelection>(), [format, setFormat] = useState(kind === "report" ? "pdf" : "csv");
  const [resource, setResource] = useState("all"), [from, setFrom] = useState(""), [to, setTo] = useState("");
  const { busy, error, run, confirm, clear } = usePendingWrite();
  const live = useRef(false), polls = useRef(0);

  const load = (cursor?: string) => void run(async () => {
    const result = await api.definitions(cursor);
    if (live.current) setPage(result);
  }, "No pudimos cargar los informes.");
  const checkOwner = () => void run(async () => {
    const allowed = await api.isOwner();
    if (live.current) setOwner(allowed);
  }, "No pudimos verificar quién administra el espacio.");
  useEffect(() => {
    live.current = true;
    if (kind === "report") load();
    if (kind === "backup") checkOwner();
    return () => { live.current = false; };
  }, [api, kind]);

  const refresh = (current: DataJob) => void run(async () => {
    const result = await api.status(current);
    if (live.current) setJob(result);
  }, "No pudimos actualizar el estado del trabajo.");
  useEffect(() => {
    if (!job || busy || error || !inProgress(job) || polls.current >= maxPolls) return;
    const timer = setTimeout(() => { polls.current++; refresh(job); }, pollInterval);
    return () => clearTimeout(timer);
  }, [job, busy, error]);

  const start = () => {
    const draft: JobDraft | undefined = kind === "report" ? report && { kind, ...report, format }
      : kind === "export" ? { kind, format, resource, from, to } : { kind };
    if (!draft) return;
    void run(async (confirmation) => {
      const result = await api.start(draft, confirmation);
      if (live.current) { polls.current = 0; setJob(result); }
    }, "No pudimos iniciar el trabajo.");
  };
  const download = (current: DataJob) => void run(async () => {
    const { openURL } = require("expo-linking") as typeof import("expo-linking");
    const link = await api.download(current);
    if (live.current) await openURL(link);
  }, "No pudimos abrir la descarga.");
  const newJob = () => { clear(); setJob(undefined); };
  const formats = kind === "report" ? reportFormats : exportFormats;
  const choices = (values: Record<string, string>, current: string, change: (key: string) => void) => Object.entries(values).map(([key, label]) =>
    <AuthAction key={key} label={label} disabled={busy || current === key} action={() => { clear(); change(key); }} />);

  return <View>
    {error && <ReportText role="alert">{error}</ReportText>}
    {confirm && <AuthAction label="Confirmar reintento" disabled={busy} action={confirm} />}
    {job ? <>
      <ReportText>{jobStatuses[job.status]}</ReportText>
      {inProgress(job) && <AuthAction label="Actualizar estado" disabled={busy} action={() => refresh(job)} />}
      {job.status === "completed" && <AuthAction label="Descargar archivo" disabled={busy} action={() => download(job)} />}
      {!inProgress(job) && <AuthAction label="Preparar otro trabajo" disabled={busy} action={newJob} />}
    </> : <>
      {kind === "report" && <>
        {!page && <AuthAction label="Cargar informes" disabled={busy} action={() => load()} />}
        {page && !page.items.length && <ReportText>No hay informes guardados.</ReportText>}
        {page?.items.map(({ id, name }) => <AuthAction key={id} label={`Informe: ${name}`} disabled={busy || id === report?.definitionId} action={() => { clear(); selectReport({ definitionId: id }); }} />)}
        {page?.next && <AuthAction label="Cargar más informes" disabled={busy} action={() => load(page.next!)} />}
        <ReportText>Preajustes de informes</ReportText>
        {choices(reportPresets, report?.preset ?? "", (preset) => selectReport({ preset }))}
      </>}
      {kind !== "backup" && choices(formats, format, setFormat)}
      {kind === "export" && <>
        {choices(resources, resource, setResource)}
        <PlanningField label="Desde (AAAA-MM-DD)" value={from} change={(value) => { clear(); setFrom(value); }} busy={busy} />
        <PlanningField label="Hasta (AAAA-MM-DD)" value={to} change={(value) => { clear(); setTo(value); }} busy={busy} />
      </>}
      {kind === "backup" && owner === false && <ReportText>{backupForbidden}</ReportText>}
      {kind === "backup" && owner === undefined && <AuthAction label="Verificar permiso" disabled={busy} action={checkOwner} />}
      {(kind !== "backup" || owner === true) && <AuthAction label={createLabels[kind]} disabled={busy || (kind === "report" && !report)} action={start} />}
    </>}
  </View>;
}
