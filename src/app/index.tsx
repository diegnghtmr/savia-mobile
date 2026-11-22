import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMemo, useRef, useState } from "react";
import { createAccounts, type ScopedRequest } from "../foundation/accounts";
import { createAnalytics } from "../foundation/analytics";
import { getAuth } from "../foundation/auth";
import { createBudgetWrites } from "../foundation/budget-writes";
import { createBudgets } from "../foundation/budgets";
import { createDebtPayments } from "../foundation/debt-payments";
import { createDebts } from "../foundation/debts";
import { createForecasts } from "../foundation/forecasts";
import { createFundWrites } from "../foundation/fund-writes";
import { createFunds } from "../foundation/funds";
import { createIdentity } from "../foundation/identity";
import { createImportCommits } from "../foundation/import-commits";
import { createImports, type StatementFileSource } from "../foundation/imports";
import { createOffline } from "../foundation/offline-cache";
import { createScenarios } from "../foundation/scenarios";
import { createTransactions } from "../foundation/transactions";
import { createTransfers } from "../foundation/transfers";
import { createTransport } from "../foundation/transport";
import { AccountsScreen } from "../mobile-shell/accounts-screen";
import { AnalyticsScreen } from "../mobile-shell/analytics-screen";
import { AuthAction, AuthGate } from "../mobile-shell/auth-gate";
import { BudgetsScreen } from "../mobile-shell/budgets-screen";
import { DashboardScreen } from "../mobile-shell/dashboard-screen";
import { DebtsScreen } from "../mobile-shell/debts-screen";
import { ForecastsScreen } from "../mobile-shell/forecasts-screen";
import { FundsScreen } from "../mobile-shell/funds-screen";
import { ImportsScreen } from "../mobile-shell/imports-screen";
import { OfflineBanner } from "../mobile-shell/offline-banner";
import { OutboxPanel } from "../mobile-shell/outbox-panel";
import { ScenariosScreen } from "../mobile-shell/scenarios-screen";
import { paletteFor } from "../mobile-shell/tokens";
import { TransactionsScreen } from "../mobile-shell/transactions-screen";
import { TransfersScreen } from "../mobile-shell/transfers-screen";

const transport = () => createTransport({ sessions: { read: () => getAuth().readSession() } });
const offline = createOffline(createIdentity((operation) => transport().withSession(operation)), () => getAuth().localPrincipal?.() ?? Promise.resolve(null));

export default function Index() { return <SaviaMobile />; }

export function SaviaMobile({ statementSource }: { statementSource?: StatementFileSource }) {
  return <AuthGate auth={getAuth} identity={offline.identity} signOut={offline.signOut}
    home={({ id }, profile) => <WorkspaceHome key={`${profile}:${id}`} id={id} profile={profile} statementSource={statementSource} />} />;
}

type Route = "home" | "accounts" | "transactions" | "new-transaction" | "transfers" | "budgets" | "funds" | "debts" | "dashboard" | "analytics" | "forecasts" | "scenarios" | "imports";
const workspaceRequest: ScopedRequest = (...args) => transport().requestInWorkspace(...args);
function WorkspaceHome({ id, profile, statementSource }: { id: string; profile: string; statementSource?: StatementFileSource }) {
  const latest = useRef(0);
  const [{ route, generation }, navigate] = useState<{ route: Route; generation: number }>({ route: "home", generation: 0 });
  const [snapshot, setSnapshot] = useState<{ generation: number; at: number | null }>();
  const show = (route: Route) => navigate({ route, generation: ++latest.current });
  const background = useMemo(() => offline.scope(profile, id, workspaceRequest, () => {}), [profile, id]);
  const box = useMemo(() => offline.outbox(profile, id, background), [profile, id, background]);
  const accountWrites = useMemo(() => createAccounts(background, id), [background, id]);
  const apis = useMemo(() => {
    const publish = (at: number | null, merge = false) => {
      if (latest.current !== generation) return;
      setSnapshot((old) => ({ generation, at: at !== null && merge && old?.generation === generation ? Math.min(old.at ?? at, at) : at }));
    };
    const scoped = offline.scope(profile, id, workspaceRequest, (at) => publish(at, true), () => publish(null));
    async function reportBatch<T>(read: (scope: ScopedRequest) => Promise<T>) {
      let oldest: number | null = null;
      const scope = offline.scope(profile, id, workspaceRequest, (at) => { oldest = Math.min(oldest ?? at, at); });
      const result = await read(scope);
      publish(oldest);
      return result;
    }
    const queued: ScopedRequest = (expected, path, options) => (options?.method ?? "GET") === "GET"
      ? scoped(expected, path, options) : box.request(expected, path, options);
    const transactions = createTransactions(queued, id);
    const { list, detail } = createAccounts(scoped, id);
    return { accounts: { ...accountWrites, list, detail }, transactions, transfers: createTransfers(queued, id, transactions.transferAccounts),
      budgets: createBudgets(scoped, id, () => transactions.options("categories")), budgetWrites: createBudgetWrites(scoped, id),
      funds: createFunds(scoped, id), fundWrites: createFundWrites(scoped, id, transactions.transferAccounts),
      debts: createDebts(scoped, id), debtPayments: createDebtPayments(scoped, id, transactions.transferAccounts), analytics: createAnalytics(scoped, id, reportBatch), forecasts: createForecasts(scoped, id), scenarios: createScenarios(scoped, id),
      imports: createImports(scoped, id), importCommits: createImportCommits(scoped, id, transactions.transferAccounts) };
  }, [accountWrites, box, profile, id, generation]);
  const back = () => show("home");
  return <><OfflineBanner savedAt={snapshot?.generation === generation ? snapshot.at : null} /><OutboxPanel box={box} />{route === "accounts" ? <AccountsScreen api={apis.accounts} back={back} />
    : route === "transactions" || route === "new-transaction" ? <TransactionsScreen api={apis.transactions} back={back} startCreating={route === "new-transaction"} />
    : route === "transfers" ? <TransfersScreen api={apis.transfers} back={back} />
    : route === "budgets" ? <BudgetsScreen api={apis.budgets} writes={apis.budgetWrites} back={back} />
    : route === "funds" ? <FundsScreen api={apis.funds} writes={apis.fundWrites} back={back} />
    : route === "debts" ? <DebtsScreen api={apis.debts} payments={apis.debtPayments} back={back} />
    : route === "dashboard" ? <DashboardScreen api={apis.analytics} back={back} />
    : route === "analytics" ? <AnalyticsScreen api={apis.analytics} back={back} />
    : route === "forecasts" ? <ForecastsScreen api={apis.forecasts} back={back} />
    : route === "scenarios" ? <ScenariosScreen api={apis.scenarios} back={back} />
    : route === "imports" ? <ImportsScreen api={apis.imports} commits={apis.importCommits} source={statementSource} back={back} />
    : <HomeScreen openAccounts={() => show("accounts")} openTransactions={() => show("transactions")} registerMovement={() => show("new-transaction")} openTransfers={() => show("transfers")} openBudgets={() => show("budgets")} openFunds={() => show("funds")} openDebts={() => show("debts")} openDashboard={() => show("dashboard")} openAnalytics={() => show("analytics")} openForecasts={() => show("forecasts")} openScenarios={() => show("scenarios")} openImports={() => show("imports")} />}</>;
}

type HomeActions = { openAccounts?: () => void; openTransactions?: () => void; registerMovement?: () => void; openTransfers?: () => void; openBudgets?: () => void; openFunds?: () => void; openDebts?: () => void; openDashboard?: () => void; openAnalytics?: () => void; openForecasts?: () => void; openScenarios?: () => void; openImports?: () => void };
export function HomeScreen({ openAccounts, openTransactions, registerMovement, openTransfers, openBudgets, openFunds, openDebts, openDashboard, openAnalytics, openForecasts, openScenarios, openImports }: HomeActions = {}) {
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
        {openForecasts && <AuthAction label="Pronósticos" action={openForecasts} />}
        {openScenarios && <AuthAction label="Escenarios" action={openScenarios} />}
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
        {openImports && <AuthAction label="Importar extractos" action={openImports} />}
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
