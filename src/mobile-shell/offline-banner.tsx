import { Text, useColorScheme } from "react-native";
import { paletteFor } from "./tokens";

export function OfflineBanner({ savedAt }: { savedAt: number | null }) {
  const colors = paletteFor(useColorScheme());
  return savedAt === null ? null : <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.text, backgroundColor: colors.raised, padding: 12 }}>
    {`Sin conexión — datos guardados el ${new Date(savedAt).toLocaleString("es-CO")}`}
  </Text>;
}
