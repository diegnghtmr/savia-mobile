import { useState } from "react";
import { View } from "react-native";
import { confidenceLevels, forecastStatuses, type Forecasts } from "../foundation/forecasts";
import { AuthAction, AuthPanel } from "./auth-gate";
import { FxFreshness, ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { usePendingWrite } from "./use-pending-write";

type Forecast = Awaited<ReturnType<Forecasts["detail"]>>;
type ForecastJob = Awaited<ReturnType<Forecasts["job"]>>;
const jobLabels = { queued: "Pronóstico en cola", processing: "Pronóstico en proceso", completed: "Pronóstico listo", failed: "Falló el pronóstico", cancelled: "Pronóstico cancelado", dead_letter: "Falló el pronóstico" } as const;
export function ForecastsScreen({ api, back }: { api: Forecasts; back: () => void }) {
  const [days, setDays] = useState("90"), [id, setId] = useState("");
  const [forecast, setForecast] = useState<Forecast>(), [job, setJob] = useState<ForecastJob>();
  const write = usePendingWrite();
  async function open(current: ForecastJob) {
    setJob(current);
    if (current.status === "completed" && current.result) setForecast(await api.detail(current.result));
  }
  const failure = "No pudimos cargar el pronóstico. Vuelve a intentarlo.";
  return <AuthPanel>
    <ReportText role="header">Pronósticos</ReportText><AuthAction label="Volver al resumen" action={back} />
    <PlanningField label="Horizonte (1 a 730 días)" value={days} change={setDays} busy={write.busy} />
    <AuthAction label="Calcular pronóstico" disabled={write.busy} action={() => void write.run(async () => {
      setForecast(undefined); setJob(undefined); await open(await api.start(days));
    }, failure)} />
    <PlanningField label="Identificador del pronóstico" value={id} change={setId} busy={write.busy} />
    <AuthAction label="Consultar pronóstico" disabled={write.busy} action={() => void write.run(async () => {
      setForecast(undefined); setJob(undefined); setForecast(await api.detail(id));
    }, failure)} />
    {job && !forecast && <><ReportText>{jobLabels[job.status]}</ReportText><AuthAction label="Actualizar pronóstico" disabled={write.busy}
      action={() => void write.run(async () => open(await api.job(job.id)), failure)} /></>}
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
    {forecast && <><ReportText>{forecastStatuses[forecast.status]}</ReportText><ReportText>Identificador: {forecast.id}</ReportText>
      <ReportText>Generado: {forecast.generatedAt}</ReportText><ReportText>Confianza: {confidenceLevels[forecast.confidence]}</ReportText><FxFreshness />
      {forecast.assumptions.map((assumption, index) => <ReportText key={index}>{assumption}</ReportText>)}
      {!forecast.points.length && <ReportText>No hay saldos proyectados.</ReportText>}
      {forecast.points.map((point) => <View key={point.date}><ReportText role="header">{point.date}</ReportText>
        <ReportText>Esperado: {point.expected}</ReportText><ReportText>Límite inferior: {point.lower}</ReportText>
        <ReportText>Límite superior: {point.upper}</ReportText></View>)}</>}
  </AuthPanel>;
}
