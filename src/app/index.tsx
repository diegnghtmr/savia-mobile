import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { paletteFor } from "../mobile-shell/tokens";

export default function HomeScreen() {
  const colors = paletteFor(useColorScheme());
  const { fontScale, width } = useWindowDimensions();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.canvas }]}>
      <ScrollView contentContainerStyle={styles.content} accessibilityLabel="Resumen diario" testID={`viewport-${width}-${fontScale}`}>
        <View accessibilityRole="header">
          <Text style={[styles.eyebrow, { color: colors.accent }]}>Savia</Text>
          <Text style={[styles.title, { color: colors.ink }]}>Tu dinero, con calma</Text>
        </View>
        <Text style={[styles.body, { color: colors.muted }]}>Todavía no hay información financiera disponible.</Text>
        <Text style={[styles.body, { color: colors.ink }]}>Cuando exista una fuente autorizada, vas a verla acá.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Registrar movimiento no disponible" accessibilityState={{ disabled: true }} disabled style={[styles.action, { backgroundColor: colors.disabled }]}>
          <Text style={{ color: colors.disabledInk }}>Registrar movimiento</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { flexGrow: 1, gap: 16, justifyContent: "center", padding: 24 },
  eyebrow: { fontSize: 16, fontWeight: "700" },
  title: { fontSize: 32, fontWeight: "700" },
  body: { fontSize: 18, lineHeight: 28 },
  action: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 16 },
});
