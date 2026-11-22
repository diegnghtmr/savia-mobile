import { randomUUID } from "expo-crypto";
import { isDay, money, type ScopedRequest } from "./accounts";
import { fundRecord } from "./funds";
import { InvalidDraft } from "./identity-draft";
import { jobReceipt } from "./job-receipt";
import { uuid } from "./workspace-context";

export const forecastStatuses = { queued: "Pronóstico en cola", processing: "Pronóstico en proceso", completed: "Pronóstico listo", failed: "Falló el pronóstico" } as const;
export const confidenceLevels = { low: "baja", medium: "media", high: "alta" } as const;
const path = "/v1/forecasts", type = "balance_forecast";
function parseForecast(value: unknown, id: string) {
  const { id: actual, status, generatedAt, confidence, assumptions, series } = fundRecord(value);
  if (uuid(actual) !== id || typeof status !== "string" || !Object.hasOwn(forecastStatuses, status) ||
    typeof confidence !== "string" || !Object.hasOwn(confidenceLevels, confidence) || typeof generatedAt !== "string" ||
    !Number.isFinite(Date.parse(generatedAt)) || !Array.isArray(assumptions) || !assumptions.every((item): item is string => typeof item === "string") ||
    !Array.isArray(series)) throw new TypeError();
  let previous = "", currency: string | undefined;
  const points = series.map((value) => {
    const row = fundRecord(value), { date } = row, expected = money(row.expected, currency);
    currency ??= fundRecord(row.expected).currency as string;
    if (typeof date !== "string" || !isDay(date) || date <= previous) throw new TypeError();
    previous = date;
    return { date, expected, lower: money(row.lowerBound, currency), upper: money(row.upperBound, currency) };
  });
  return { id, status: status as keyof typeof forecastStatuses, generatedAt, confidence: confidence as keyof typeof confidenceLevels, assumptions, points };
}
export function createForecasts(request: ScopedRequest, workspace: string) {
  const scope = uuid(workspace) ?? "";
  function identifier(raw: unknown) {
    const id = uuid(raw);
    if (!id || !scope) throw new InvalidDraft("Pronóstico no válido.");
    return id;
  }
  const keys = new Map<number, string>();
  return {
    async start(raw: unknown) {
      if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 730 || !scope) throw new InvalidDraft("Revisa el horizonte del pronóstico.");
      const horizonDays = Number(raw), key = keys.get(horizonDays) ?? randomUUID();
      keys.set(horizonDays, key);
      const job = jobReceipt(await request(scope, `${path}/balance`, { method: "POST", body: { horizonDays }, idempotencyKey: key, successStatus: 202 }), type);
      keys.delete(horizonDays);
      return job;
    },
    async job(raw: unknown) {
      const id = identifier(raw);
      return jobReceipt(await request(scope, `/v1/jobs/${id}`, { successStatus: 200 }), type, id);
    },
    async detail(raw: unknown) {
      const id = identifier(raw);
      return parseForecast(await request(scope, `${path}/${id}`, { successStatus: 200 }), id);
    },
  };
}
export type Forecasts = ReturnType<typeof createForecasts>;
