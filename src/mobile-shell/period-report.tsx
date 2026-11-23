import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, TextInput, useColorScheme, View } from "react-native";
import type { ReportPeriod } from "../foundation/analytics";
import type { FxRateUsed } from "../foundation/fx-rates";
import { InvalidDraft } from "../foundation/identity-draft";
import { AuthAction, AuthPanel } from "./auth-gate";
import { paletteFor } from "./tokens";

export function ReportText({ children, role }: { children: ReactNode; role?: "header" | "alert" }) {
  const colors = paletteFor(useColorScheme());
  return <Text accessibilityRole={role} accessibilityLiveRegion={role === "alert" ? "polite" : undefined} style={{ color: colors.text, fontSize: role === "header" ? 22 : undefined }}>{children}</Text>;
}

const fxFreshness = { fresh: "Vigente", stale: "Desactualizada", unknown: "Desconocida" } as const;
export function FxFreshness({ rates, label = "Tipos de cambio aplicados", fallback = true }: {
  rates?: readonly FxRateUsed[]; label?: string; fallback?: boolean;
} = {}) {
  if (!rates) return fallback ? <ReportText>Vigencia de tipos de cambio: desconocida</ReportText> : null;
  return <View>
    <ReportText role="header">{label}</ReportText>
    {rates.map((rate) => <ReportText key={JSON.stringify(rate)}>
      {`${rate.baseCurrency} → ${rate.quoteCurrency} · ${rate.rate} · ${rate.rateDate} · ${rate.source} · ${fxFreshness[rate.freshness]}`}
    </ReportText>)}
  </View>;
}
function currentPeriod(): ReportPeriod {
  const to = new Date().toISOString().slice(0, 10);
  return { from: `${to.slice(0, 7)}-01`, to };
}
const fields = { from: "Desde (AAAA-MM-DD)", to: "Hasta (AAAA-MM-DD)" } as const;
export function PeriodReport<T>({ title, load, children, back, initial, toolbar, submit }: {
  title: string; load: (period: ReportPeriod) => Promise<T>; children: (result: T) => ReactNode; back: () => void;
  initial?: ReportPeriod; toolbar?: ReactNode | ((busy: boolean) => ReactNode); submit?: (period: ReportPeriod) => Promise<T>;
}) {
  const [first] = useState(() => initial ?? currentPeriod()), [draft, setDraft] = useState(first);
  const [result, setResult] = useState<{ period: ReportPeriod; value: T }>();
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const sequence = useRef(0), colors = paletteFor(useColorScheme());
  async function apply(period: ReportPeriod, read = load) {
    const ticket = ++sequence.current;
    setBusy(true); setError(""); setResult(undefined);
    try {
      const value = await read(period);
      if (ticket === sequence.current) setResult({ period, value });
    } catch (error) {
      if (ticket === sequence.current) setError(error instanceof InvalidDraft ? error.message : "No pudimos cargar el informe.");
    } finally { if (ticket === sequence.current) setBusy(false); }
  }
  useEffect(() => { void apply(first); return () => { ++sequence.current; }; }, [load, first]);
  return <AuthPanel>
    <ReportText role="header">{title}</ReportText><AuthAction label="Volver al resumen" action={back} />{typeof toolbar === "function" ? toolbar(busy) : toolbar}
    {(Object.keys(fields) as (keyof ReportPeriod)[]).map((key) => <View key={key}>
      <ReportText>{fields[key]}</ReportText><TextInput accessibilityLabel={fields[key]} value={draft[key]} autoCorrect={false} editable={!busy}
        onChangeText={(value) => setDraft((old) => ({ ...old, [key]: value }))} style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} />
    </View>)}
    <AuthAction label="Aplicar período" action={() => void apply(draft, submit)} disabled={busy} />
    {busy && <ReportText>Cargando informe…</ReportText>}
    {error && <ReportText role="alert">{error}</ReportText>}
    {result && <><ReportText>Período: {result.period.from} – {result.period.to}</ReportText>{children(result.value)}</>}
  </AuthPanel>;
}
