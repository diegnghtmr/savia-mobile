import { useState } from "react";
import { columnNames, dateFormats, debitSigns, type ImportCommits, type Target } from "../foundation/import-commits";
import type { ImportJob } from "../foundation/imports";
import { AuthAction } from "./auth-gate";
import { ReportText } from "./period-report";
import { usePendingWrite } from "./use-pending-write";

const defaults = { date: ["date", "fecha", "occurred_at"], amount: ["amount", "amount_minor", "importe", "value"],
  description: ["description", "descripcion", "memo", "payee"] } as const;
function suggested(columns: readonly string[]) {
  return Object.fromEntries(Object.entries(defaults).flatMap(([target, aliases]) => {
    const matches = columns.filter((column) => aliases.some((alias) => alias === column.trim().toLowerCase()));
    return matches.length === 1 ? [[target, matches[0]]] : [];
  })) as Partial<Record<Target, string>>;
}
type Choices = Awaited<ReturnType<ImportCommits["loadAccounts"]>>;
export function ImportCommitForm({ job, writes, onComplete }: { job: ImportJob; writes: ImportCommits; onComplete: () => void }) {
  const [choices, setChoices] = useState<Choices>(), [account, setAccount] = useState<Choices[number]>();
  const [columns, setColumns] = useState(() => suggested(job.sourceColumns)), [choose, setChoose] = useState<Target>();
  const [dateFormat, setFormat] = useState<(typeof dateFormats)[number]>("YYYY-MM-DD");
  const [debitSign, setSign] = useState<keyof typeof debitSigns>("negative"), [skip, setSkip] = useState(true);
  const [reviewed, setReviewed] = useState<ReturnType<ImportCommits["review"]>>();
  const write = usePendingWrite(), label = "No pudimos confirmar la importación.";
  const commit = () => { if (reviewed) void write.run(async (approval) => {
    await writes.commit(job, reviewed, true, approval); onComplete();
  }, label); };
  const targets = (Object.keys(columnNames) as Target[]).filter((target) => target !== "debitCreditIndicator" || debitSign === "separate_column");
  const accountName = account ? `${account.name} (${account.currency})` : "";
  const unique = job.sourceColumns.filter((name) => name.trim() && job.sourceColumns.indexOf(name) === job.sourceColumns.lastIndexOf(name));
  return <>
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {reviewed ? <>
      <ReportText role="header">Revisión</ReportText><ReportText>Confirma la importación a {accountName}.</ReportText>
      {targets.map((target) => <ReportText key={target}>{columnNames[target]}: {columns[target]}</ReportText>)}
      <ReportText>Formato de fecha: {dateFormat}</ReportText><ReportText>{debitSigns[debitSign]}</ReportText>
      <ReportText>Omitir posibles duplicados: {skip ? "sí" : "no"}</ReportText>
      <AuthAction label="Volver a la asignación" disabled={write.busy} action={() => { setReviewed(undefined); write.clear(); }} />
      <AuthAction label="Confirmar importación" disabled={write.busy || !!write.confirm} action={commit} />
      {write.confirm && <AuthAction label="Confirmar reintento de importación" disabled={write.busy} action={write.confirm} />}
    </> : !choices ? <AuthAction label="Preparar importación" disabled={write.busy} action={() => void write.run(async () => {
      setChoices(await writes.loadAccounts());
    }, "No pudimos cargar las cuentas de destino.")} /> : <>
      <ReportText role="header">Cuenta de destino</ReportText>
      {!choices.length && <ReportText>No hay cuentas disponibles para importar.</ReportText>}
      {choices.map((row) => <AuthAction key={row.id} label={`Cuenta: ${row.name} (${row.currency})`} selected={account?.id === row.id}
        disabled={write.busy} action={() => setAccount(row)} />)}
      <ReportText role="header">Asignar columnas</ReportText><ReportText>Los importes deben estar en unidades menores de la cuenta.</ReportText>
      {targets.map((target) => <AuthAction key={target} label={`${columnNames[target]}: ${columns[target] ?? "Sin asignar"}`} selected={choose === target}
        disabled={write.busy} action={() => setChoose((old) => old === target ? undefined : target)} />)}
      {choose && unique.map((column) => <AuthAction key={column} label={`Usar columna: ${column}`} disabled={write.busy} action={() => {
        setColumns((old) => ({ ...old, [choose]: column })); setChoose(undefined);
      }} />)}
      {dateFormats.map((format) => <AuthAction key={format} label={`Fecha: ${format}`} selected={dateFormat === format} disabled={write.busy} action={() => setFormat(format)} />)}
      {(Object.keys(debitSigns) as (keyof typeof debitSigns)[]).map((sign) => <AuthAction key={sign} label={debitSigns[sign]} selected={sign === debitSign}
        disabled={write.busy} action={() => { setSign(sign); setChoose(undefined); }} />)}
      <AuthAction label="Omitir posibles duplicados" selected={skip} disabled={write.busy} action={() => setSkip(!skip)} />
      <AuthAction label="Revisar importación" disabled={write.busy} action={() => void write.run(async () => {
        const columnMapping = Object.fromEntries(targets.flatMap((target) => columns[target] === undefined ? [] : [[columns[target], target]]));
        setReviewed(writes.review(job, { accountId: account?.id, columnMapping, dateFormat, debitSign, skipDuplicateCandidates: skip }));
      }, label)} />
    </>}
  </>;
}
