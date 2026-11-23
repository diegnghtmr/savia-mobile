import { isDay } from "./accounts";
import { ACTIVE_CURRENCIES } from "./currencies";
import { fundRecord } from "./funds";

export type FxRateUsed = Readonly<{
  baseCurrency: string; quoteCurrency: string; rate: string; rateDate: string; source: string;
  freshness: "fresh" | "stale" | "unknown";
}>;

export function parseFxRatesUsed(input: unknown): readonly FxRateUsed[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || !input.length) throw new TypeError("Invalid FX provenance");
  const seen = new Set<string>();
  return input.map((item: unknown): FxRateUsed => {
    const { baseCurrency, quoteCurrency, rate, rateDate, source, freshness } = fundRecord(item);
    if (typeof baseCurrency !== "string" || typeof quoteCurrency !== "string" || baseCurrency === quoteCurrency ||
      !ACTIVE_CURRENCIES.has(baseCurrency) || !ACTIVE_CURRENCIES.has(quoteCurrency) || typeof rate !== "string" ||
      !/^\d+(?:\.\d+)?$/.test(rate) || !/[1-9]/.test(rate) || typeof rateDate !== "string" || !isDay(rateDate) ||
      typeof source !== "string" || !source.trim() || (freshness !== "fresh" && freshness !== "stale" && freshness !== "unknown")) {
      throw new TypeError("Invalid FX provenance");
    }
    const value: FxRateUsed = { baseCurrency, quoteCurrency, rate, rateDate, source, freshness };
    const key = JSON.stringify(value);
    if (seen.has(key)) throw new TypeError("Duplicate FX provenance");
    seen.add(key);
    return value;
  });
}
