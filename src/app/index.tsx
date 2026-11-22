import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useState } from "react";
import { createAccounts } from "../foundation/accounts";
import { getAuth } from "../foundation/auth";
import { createIdentity } from "../foundation/identity";
import { createTransactions } from "../foundation/transactions";
import { createTransport } from "../foundation/transport";
import { AccountsScreen } from "../mobile-shell/accounts-screen";
import { AuthAction, AuthGate } from "../mobile-shell/auth-gate";
import { paletteFor } from "../mobile-shell/tokens";
import { TransactionsScreen } from "../mobile-shell/transactions-screen";

const transport = () => createTransport({ sessions: { read: () => getAuth().readSession() } });
const identity = createIdentity((operation) => transport().withSession(operation));

export default function Index() {
  return <AuthGate auth={getAuth} identity={identity} home={({ id }) => <WorkspaceHome key={id} id={id} />} />;
}

function WorkspaceHome({ id }: { id: string }) {
  const [route, show] = useState<"home" | "accounts" | "transactions">("home");
  const [apis] = useState(() => {
    const scoped: ReturnType<typeof createTransport>["requestInWorkspace"] = (...args) => transport().requestInWorkspace(...args);
    return { accounts: createAccounts(scoped, id), transactions: createTransactions(scoped, id) };
  });
  const back = () => show("home");
  if (route === "accounts") return <AccountsScreen api={apis.accounts} back={back} />;
  if (route === "transactions") return <TransactionsScreen api={apis.transactions} back={back} />;
  return <HomeScreen openAccounts={() => show("accounts")} openTransactions={() => show("transactions")} />;
}

export function HomeScreen({ openAccounts, openTransactions }: { openAccounts?: () => void; openTransactions?: () => void } = {}) {
  const colors = paletteFor(useColorScheme());
  const { fontScale, width } = useWindowDimensions();
  return (
    <SafeAreaView testID="canvas" style={[styles.safe, { backgroundColor: colors.canvas }]}>
      <ScrollView contentContainerStyle={styles.content} accessibilityLabel="Resumen diario" testID={`viewport-${width}-${fontScale}`}>
        <View accessibilityRole="header">
          <Text style={[styles.eyebrow, { color: colors.action }]}>Savia</Text>
          <Text style={[styles.title, { color: colors.text }]}>Tu dinero, con calma</Text>
        </View>
        <Text style={[styles.body, { color: colors.muted }]}>Todavía no hay información financiera disponible.</Text>
        <Text style={[styles.body, { color: colors.text }]}>Cuando exista una fuente autorizada, vas a verla acá.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Registrar movimiento no disponible" accessibilityState={{ disabled: true }} disabled style={[styles.action, { backgroundColor: colors.raised }]}>
          <Text style={{ color: colors.disabled }}>Registrar movimiento</Text>
        </Pressable>
        {openAccounts && <AuthAction label="Cuentas" action={openAccounts} />}
        {openTransactions && <AuthAction label="Movimientos" action={openTransactions} />}
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
