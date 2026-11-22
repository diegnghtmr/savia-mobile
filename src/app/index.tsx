import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useState } from "react";
import { createAccounts, type ScopedRequest } from "../foundation/accounts";
import { createAnalytics } from "../foundation/analytics";
import { getAuth } from "../foundation/auth";
import { createBudgetWrites } from "../foundation/budget-writes";
import { createBudgets } from "../foundation/budgets";
import { createDebtPayments } from "../foundation/debt-payments";
import { createDebts } from "../foundation/debts";
import { createFundWrites } from "../foundation/fund-writes";
import { createFunds } from "../foundation/funds";
import { createIdentity } from "../foundation/identity";
import { createOffline } from "../foundation/offline-cache";
import { createTransactions } from "../foundation/transactions";
import { createTransfers } from "../foundation/transfers";
import { createTransport } from "../foundation/transport";
import { AccountsScreen } from "../mobile-shell/accounts-screen";
import { AnalyticsScreen } from "../mobile-shell/analytics-screen";
import { AuthAction, AuthGate } from "../mobile-shell/auth-gate";
import { BudgetsScreen } from "../mobile-shell/budgets-screen";
import { DashboardScreen } from "../mobile-shell/dashboard-screen";
import { DebtsScreen } from "../mobile-shell/debts-screen";
import { FundsScreen } from "../mobile-shell/funds-screen";
import { OfflineBanner } from "../mobile-shell/offline-banner";
import { OutboxPanel } from "../mobile-shell/outbox-panel";
import { paletteFor } from "../mobile-shell/tokens";
import { TransactionsScreen } from "../mobile-shell/transactions-screen";
import { TransfersScreen } from "../mobile-shell/transfers-screen";

const transport = () => createTransport({ sessions: { read: () => getAuth().readSession() } });
const offline = createOffline(createIdentity((operation) => transport().withSession(operation)), () => getAuth().localPrincipal?.() ?? Promise.resolve(null));

export default function Index() {
  return <AuthGate auth={getAuth} identity={offline.identity} signOut={offline.signOut}
    home={({ id }, profile) => <WorkspaceHome key={`${profile}:${id}`} id={id} profile={profile} />} />;
}

function WorkspaceHome({ id, profile }: { id: string; profile: string }) {
  const [route, show] = useState<"home" | "accounts" | "transactions" | "new-transaction" | "transfers" | "budgets" | "funds" | "debts" | "dashboard" | "analytics">("home");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [apis] = useState(() => {
    const request: ScopedRequest = (...args) => transport().requestInWorkspace(...args);
    const scoped = offline.scope(profile, id, request, (at) => setSavedAt((old) => Math.min(old ?? at, at)), () => setSavedAt(null));
    async function reportBatch<T>(read: (scope: ScopedRequest) => Promise<T>) {
      let oldest: number | null = null;
      const scope = offline.scope(profile, id, request, (at) => { oldest = Math.min(oldest ?? at, at); });
      const result = await read(scope);
      setSavedAt(oldest);
      return result;
    }
    const box = offline.outbox(profile, id, scoped), transactions = createTransactions(box.request, id);
    return { box, accounts: createAccounts(scoped, id), transactions, transfers: createTransfers(box.request, id, transactions.transferAccounts),
      budgets: createBudgets(scoped, id, () => transactions.options("categories")), budgetWrites: createBudgetWrites(scoped, id),
      funds: createFunds(scoped, id), fundWrites: createFundWrites(scoped, id, transactions.transferAccounts),
      debts: createDebts(scoped, id), debtPayments: createDebtPayments(scoped, id, transactions.transferAccounts), analytics: createAnalytics(scoped, id, reportBatch) };
  });
  const back = () => show("home");
  return <><OfflineBanner savedAt={savedAt} /><OutboxPanel box={apis.box} />{route === "accounts" ? <AccountsScreen api={apis.accounts} back={back} />
    : route === "transactions" || route === "new-transaction" ? <TransactionsScreen api={apis.transactions} back={back} startCreating={route === "new-transaction"} />
    : route === "transfers" ? <TransfersScreen api={apis.transfers} back={back} />
    : route === "budgets" ? <BudgetsScreen api={apis.budgets} writes={apis.budgetWrites} back={back} />
    : route === "funds" ? <FundsScreen api={apis.funds} writes={apis.fundWrites} back={back} />
    : route === "debts" ? <DebtsScreen api={apis.debts} payments={apis.debtPayments} back={back} />
    : route === "dashboard" ? <DashboardScreen api={apis.analytics} back={back} />
    : route === "analytics" ? <AnalyticsScreen api={apis.analytics} back={back} />
    : <HomeScreen openAccounts={() => show("accounts")} openTransactions={() => show("transactions")} registerMovement={() => show("new-transaction")} openTransfers={() => show("transfers")} openBudgets={() => show("budgets")} openFunds={() => show("funds")} openDebts={() => show("debts")} openDashboard={() => show("dashboard")} openAnalytics={() => show("analytics")} />}</>;
}

type HomeActions = { openAccounts?: () => void; openTransactions?: () => void; registerMovement?: () => void; openTransfers?: () => void; openBudgets?: () => void; openFunds?: () => void; openDebts?: () => void; openDashboard?: () => void; openAnalytics?: () => void };
export function HomeScreen({ openAccounts, openTransactions, registerMovement, openTransfers, openBudgets, openFunds, openDebts, openDashboard, openAnalytics }: HomeActions = {}) {
  const colors = paletteFor(useColorScheme());
  const { fontScale, width } = useWindowDimensions();
  return (
    <SafeAreaView testID="canvas" style={[styles.safe, { backgroundColor: colors.canvas }]}>
      <ScrollView contentContainerStyle={styles.content} accessibilityLabel="Resumen diario" testID={`viewport-${width}-${fontScale}`}>
        <View accessibilityRole="header">
          <Text style={[styles.eyebrow, { color: colors.action }]}>Savia</Text>
          <Text style={[styles.title, { color: colors.text }]}>Tu dinero, con calma</Text>
        </View>
        {openDashboard ? <AuthAction label="Resumen financiero" action={openDashboard} /> : <>
          <Text style={[styles.body, { color: colors.muted }]}>Todavía no hay información financiera disponible.</Text>
          <Text style={[styles.body, { color: colors.text }]}>Cuando exista una fuente autorizada, vas a verla acá.</Text>
        </>}
        {openAnalytics && <AuthAction label="Analítica" action={openAnalytics} />}
        {registerMovement ? <AuthAction label="Registrar movimiento" action={registerMovement} /> :
          <Pressable accessibilityRole="button" accessibilityLabel="Registrar movimiento no disponible" accessibilityState={{ disabled: true }} disabled style={[styles.action, { backgroundColor: colors.raised }]}>
            <Text style={{ color: colors.disabled }}>Registrar movimiento</Text>
          </Pressable>}
        {openAccounts && <AuthAction label="Cuentas" action={openAccounts} />}
        {openTransactions && <AuthAction label="Movimientos" action={openTransactions} />}
        {openTransfers && <AuthAction label="Transferencias" action={openTransfers} />}
        {openBudgets && <AuthAction label="Presupuestos" action={openBudgets} />}
        {openFunds && <AuthAction label="Fondos" action={openFunds} />}
        {openDebts && <AuthAction label="Deudas" action={openDebts} />}
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
