import { StyleSheet, Text, View } from "react-native";

export default function NotFoundScreen() {
  return (
    <View style={styles.root} accessibilityRole="alert">
      <Text style={styles.title}>Ruta no disponible</Text>
      <Text>Esta versión de Savia tiene una sola pantalla.</Text>
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, gap: 12, justifyContent: "center", padding: 24 }, title: { fontSize: 28, fontWeight: "700" } });
