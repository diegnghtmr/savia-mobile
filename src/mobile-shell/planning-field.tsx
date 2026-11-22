import { TextInput, useColorScheme, View } from "react-native";
import { ReportText } from "./period-report";
import { paletteFor } from "./tokens";

export function PlanningField({ label, value, change, busy }: { label: string; value: string; change: (value: string) => void; busy: boolean }) {
  const colors = paletteFor(useColorScheme());
  return <View><ReportText>{label}</ReportText><TextInput accessibilityLabel={label} value={value} onChangeText={change} editable={!busy}
    autoCorrect={false} style={{ minHeight: 44, padding: 12, color: colors.text, backgroundColor: colors.raised }} /></View>;
}
