import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMemo, useRef, useState } from "react";
import { createAccess } from "../foundation/access";
import { createAccounts, type ScopedRequest } from "../foundation/accounts";
import { createAICredentials } from "../foundation/ai-credentials";
import { createAnalytics } from "../foundation/analytics";
import { createAssistant } from "../foundation/assistant";
import { getAuth } from "../foundation/auth";
import { createBudgetWrites } from "../foundation/budget-writes";
import { createBudgets } from "../foundation/budgets";
import { createCatalogWrites } from "../foundation/catalog-writes";
import { createDashboardPreferences } from "../foundation/dashboard-preferences";
import { createDataJobs } from "../foundation/data-jobs";
import { createDebtPayments } from "../foundation/debt-payments";
import { createDebts } from "../foundation/debts";
import { createForecasts } from "../foundation/forecasts";
import { createFundWrites } from "../foundation/fund-writes";
import { createFunds } from "../foundation/funds";
import { createIdentity } from "../foundation/identity";
import { createImportCommits } from "../foundation/import-commits";
import { createImports, type StatementFileSource } from "../foundation/imports";
import { createMembers } from "../foundation/members";
import { createInbox } from "../foundation/notification-inbox";
import { createNotificationPreferences, type PushTokenSource } from "../foundation/notification-preferences";
import { createOffline } from "../foundation/offline-cache";
import { memoryPendingJournal } from "../foundation/pending-submission";
import { createReceiptConfirmations } from "../foundation/receipt-confirmations";
import { createReceipts, type ReceiptImageSource } from "../foundation/receipts";
import { createRecurringRules } from "../foundation/recurring-rules";
import { createScenarios } from "../foundation/scenarios";
import { createSessions } from "../foundation/sessions";
import { createSubscriptions } from "../foundation/subscriptions";
import { createBulkTransactions } from "../foundation/transaction-bulk";
import { createTransactions } from "../foundation/transactions";
import { createTransfers } from "../foundation/transfers";
import { createTransport } from "../foundation/transport";
import { AccessScreen } from "../mobile-shell/access-screen";
import { AccountsScreen } from "../mobile-shell/accounts-screen";
import { AICredentialsScreen } from "../mobile-shell/ai-credentials-screen";
import { AnalyticsScreen } from "../mobile-shell/analytics-screen";
import { AssistantScreen } from "../mobile-shell/assistant-screen";
import { AuthAction, AuthGate } from "../mobile-shell/auth-gate";
import { BudgetsScreen } from "../mobile-shell/budgets-screen";
import { CatalogWritesScreen } from "../mobile-shell/catalog-writes-screen";
import { DashboardScreen } from "../mobile-shell/dashboard-screen";
import { DataJobsScreen } from "../mobile-shell/data-jobs-screen";
import { DebtsScreen } from "../mobile-shell/debts-screen";
import { defaultStatementSource } from "../mobile-shell/document-picker-source";
import { ForecastsScreen } from "../mobile-shell/forecasts-screen";
import { FundsScreen } from "../mobile-shell/funds-screen";
import { defaultReceiptSource } from "../mobile-shell/image-picker-source";
import { ImportsScreen } from "../mobile-shell/imports-screen";
import { MembersScreen } from "../mobile-shell/members-screen";
import { NotificationInbox } from "../mobile-shell/notification-inbox";
import { NotificationSettings } from "../mobile-shell/notification-settings";
import { OfflineBanner } from "../mobile-shell/offline-banner";
import { OutboxPanel } from "../mobile-shell/outbox-panel";
import { defaultPushTokenSource } from "../mobile-shell/push-token-source";
import { ReceiptsScreen } from "../mobile-shell/receipts-screen";
import { RecurringRulesScreen } from "../mobile-shell/recurring-rules-screen";
import { ScenariosScreen } from "../mobile-shell/scenarios-screen";
import { SessionsScreen } from "../mobile-shell/sessions-screen";
import { SubscriptionsScreen } from "../mobile-shell/subscriptions-screen";
import { paletteFor } from "../mobile-shell/tokens";
import { TransactionsScreen } from "../mobile-shell/transactions-screen";
import { TransfersScreen } from "../mobile-shell/transfers-screen";

const transport = () => createTransport({ sessions: { read: () => getAuth().readSession() } });
const offline = createOffline(createIdentity((operation) => transport().withSession(operation)), () => getAuth().localPrincipal?.() ?? Promise.resolve(null));

export default function Index() {
  return <SaviaMobile statementSource={defaultStatementSource} imageSource={defaultReceiptSource} pushTokenSource={defaultPushTokenSource} />;
}

type Sources = { statementSource?: StatementFileSource; imageSource?: ReceiptImageSource; pushTokenSource?: PushTokenSource };
export function SaviaMobile(sources: Sources) {
  return <AuthGate auth={getAuth} identity={offline.identity} signOut={offline.signOut}
    home={({ id }, profile, signOutAll) => <WorkspaceHome key={`${profile}:${id}`} id={id} profile={profile} signOutAll={signOutAll} {...sources} />} />;
}

type Route = "home" | "accounts" | "transactions" | "new-transaction" | "transfers" | "budgets" | "funds" | "debts" | "dashboard" | "analytics" | "forecasts" | "scenarios" | "imports" | "receipts" | "notifications" | "notification-settings" | "assistant" | "ai-credentials" | "access" | "members" | "subscriptions" | "recurring-rules" | "data-jobs" | "catalog-writes" | "sessions";
const workspaceRequest: ScopedRequest = (...args) => transport().requestInWorkspace(...args);
function WorkspaceHome({ id, profile, signOutAll, statementSource, imageSource, pushTokenSource }: { id: string; profile: string; signOutAll: () => Promise<void> } & Sources) {
  const latest = useRef(0);
  const [{ route, generation }, navigate] = useState<{ route: Route; generation: number }>({ route: "home", generation: 0 });
  const [snapshot, setSnapshot] = useState<{ generation: number; at: number | null }>();
  const show = (route: Route) => navigate({ route, generation: ++latest.current });
  const background = useMemo(() => offline.scope(profile, id, workspaceRequest, () => {}), [profile, id]);
  const box = useMemo(() => offline.outbox(profile, id, background), [profile, id, background]);
  const accountWrites = useMemo(() => createAccounts(background, id), [background, id]);
  const dataJobs = useMemo(() => createDataJobs(background, id), [background, id]);
  const catalogWrites = useMemo(() => createCatalogWrites(background, id), [background, id]);
  const sessions = useMemo(() => createSessions(background, id), [background, id]);
  const preferences = useMemo(() => createDashboardPreferences(background, id), [background, id]);
  const bulk = useMemo(() => createBulkTransactions(background, id,
    createTransactions((expected, path, options) => background(expected, path, { ...options, onlineOnly: true }), id).formOptions), [background, id]);
  const [fundJournal] = useState(memoryPendingJournal);
  const apis = useMemo(() => {
    const publish = (at: number | null, merge = false) => {
      if (latest.current !== generation) return;
      setSnapshot((old) => ({ generation, at: at !== null && merge && old?.generation === generation ? Math.min(old.at ?? at, at) : at }));
    };
    let visible = 0;
    const scopeFor = (owner: number) => offline.scope(profile, id, workspaceRequest,
      (at) => { if (visible === owner) publish(at, true); }, () => { if (visible === owner) publish(null); });
    const scoped = scopeFor(0);
    const views = <T,>(make: (request: ScopedRequest) => T) => () => {
      ++visible; publish(null); return make(scopeFor(visible));
    };
    async function reportBatch<T>(read: (scope: ScopedRequest) => Promise<T>) {
      let oldest: number | null = null;
      const scope = offline.scope(profile, id, workspaceRequest, (at) => { oldest = Math.min(oldest ?? at, at); });
      const result = await read(scope);
      publish(oldest);
      return result;
    }
    const queued = (reads: ScopedRequest): ScopedRequest => (expected, path, options) => (options?.method ?? "GET") === "GET"
      ? reads(expected, path, options) : box.request(expected, path, options);
    const tx = (request: ScopedRequest) => createTransactions(queued(request), id);
    const transactions = tx(scoped), receipts = createReceipts(scoped, id);
    const accounts = (request: ScopedRequest) => {
      const { list, detail } = createAccounts(request, id);
      return { ...accountWrites, list, detail };
    };
    const budgets = (request: ScopedRequest) => createBudgets(request, id, () => tx(request).options("categories"));
    const funds = (request: ScopedRequest) => ({ api: createFunds(request, id, request), writes: createFundWrites(request, id, tx(request).transferAccounts, fundJournal) });
    const debts = (request: ScopedRequest) => ({ api: createDebts(request, id), payments: createDebtPayments(request, id, tx(request).transferAccounts) });
    return { accounts: accounts(scoped), accountViews: views(accounts), transactions, transactionViews: views(tx),
      transfers: createTransfers(queued(scoped), id, transactions.transferAccounts), budgets: budgets(scoped), budgetViews: views(budgets), budgetWrites: createBudgetWrites(scoped, id),
      funds: funds(scoped), fundViews: views(funds), debts: debts(scoped), debtViews: views(debts), analytics: createAnalytics(scoped, id, reportBatch), forecasts: createForecasts(scoped, id), scenarios: createScenarios(scoped, id),
      subscriptions: createSubscriptions(scoped, id), recurringRules: createRecurringRules(scoped, id),
      receipts, receiptConfirmations: createReceiptConfirmations(scoped, id, receipts.detail, transactions.transferAccounts),
      inbox: createInbox(scoped, id), notificationPreferences: createNotificationPreferences(scoped, id), assistant: createAssistant(scoped, id), aiCredentials: createAICredentials(scoped, id), access: createAccess(scoped, id), members: createMembers(scoped, id),
      imports: createImports(scoped, id), importCommits: createImportCommits(scoped, id, transactions.transferAccounts) };
  }, [accountWrites, box, profile, id, generation, fundJournal]);
  const back = () => show("home");
  return <><OfflineBanner savedAt={snapshot?.generation === generation ? snapshot.at : null} /><OutboxPanel box={box} />{route === "accounts" ? <AccountsScreen api={apis.accounts} nextView={apis.accountViews} back={back} />
    : route === "transactions" || route === "new-transaction" ? <TransactionsScreen api={apis.transactions} bulk={bulk} nextView={apis.transactionViews} back={back} startCreating={route === "new-transaction"} />
    : route === "transfers" ? <TransfersScreen api={apis.transfers} back={back} />
    : route === "budgets" ? <BudgetsScreen api={apis.budgets} nextView={apis.budgetViews} writes={apis.budgetWrites} back={back} />
    : route === "funds" ? <FundsScreen {...apis.funds} nextView={apis.fundViews} back={back} />
    : route === "debts" ? <DebtsScreen {...apis.debts} nextView={apis.debtViews} back={back} />
    : route === "dashboard" ? <DashboardScreen api={apis.analytics} preferences={preferences} back={back}
      links={{ account_balances: () => show("accounts"), alerts: () => show("notifications"), reconciliation_status: () => show("transactions") }} />
    : route === "analytics" ? <AnalyticsScreen api={apis.analytics} back={back} />
    : route === "forecasts" ? <ForecastsScreen api={apis.forecasts} back={back} />
    : route === "scenarios" ? <ScenariosScreen api={apis.scenarios} back={back} />
    : route === "imports" ? <ImportsScreen api={apis.imports} commits={apis.importCommits} source={statementSource} back={back} />
    : route === "receipts" ? <ReceiptsScreen api={apis.receipts} confirmations={apis.receiptConfirmations} source={imageSource} back={back} />
    : route === "notifications" ? <NotificationInbox api={apis.inbox} back={back} preferences={() => show("notification-settings")} />
    : route === "notification-settings" ? <NotificationSettings api={apis.notificationPreferences} tokenSource={pushTokenSource} back={() => show("notifications")} />
    : route === "assistant" ? <AssistantScreen api={apis.assistant} back={back} />
    : route === "ai-credentials" ? <AICredentialsScreen api={apis.aiCredentials} back={back} />
    : route === "access" ? <AccessScreen api={apis.access} back={back} />
    : route === "members" ? <MembersScreen api={apis.members} back={back} />
    : route === "subscriptions" ? <SubscriptionsScreen api={apis.subscriptions} back={back} />
    : route === "recurring-rules" ? <RecurringRulesScreen api={apis.recurringRules} back={back} />
    : route === "data-jobs" ? <DataJobsScreen api={dataJobs} back={back} />
    : route === "catalog-writes" ? <CatalogWritesScreen api={catalogWrites} back={back} />
    : route === "sessions" ? <SessionsScreen api={sessions} back={back} signOutAll={signOutAll} />
    : <HomeScreen openSessions={() => show("sessions")} openCatalogWrites={() => show("catalog-writes")} openDataJobs={() => show("data-jobs")} openAccounts={() => show("accounts")} openTransactions={() => show("transactions")} registerMovement={() => show("new-transaction")} openTransfers={() => show("transfers")} openBudgets={() => show("budgets")} openFunds={() => show("funds")} openDebts={() => show("debts")} openDashboard={() => show("dashboard")} openAnalytics={() => show("analytics")} openForecasts={() => show("forecasts")} openScenarios={() => show("scenarios")} openImports={() => show("imports")} openReceipts={() => show("receipts")} openNotifications={() => show("notifications")} openAssistant={() => show("assistant")} openAICredentials={() => show("ai-credentials")} openAccess={() => show("access")} openMembers={() => show("members")} openSubscriptions={() => show("subscriptions")} openRecurringRules={() => show("recurring-rules")} />}</>;
}

type HomeActions = { openAccounts?: () => void; openTransactions?: () => void; registerMovement?: () => void; openTransfers?: () => void; openBudgets?: () => void; openFunds?: () => void; openDebts?: () => void; openDashboard?: () => void; openAnalytics?: () => void; openForecasts?: () => void; openScenarios?: () => void; openImports?: () => void; openReceipts?: () => void; openNotifications?: () => void; openAssistant?: () => void; openAICredentials?: () => void; openAccess?: () => void; openMembers?: () => void; openSubscriptions?: () => void; openRecurringRules?: () => void; openDataJobs?: () => void; openCatalogWrites?: () => void; openSessions?: () => void };
export function HomeScreen({ openAccounts, openTransactions, registerMovement, openTransfers, openBudgets, openFunds, openDebts, openDashboard, openAnalytics, openForecasts, openScenarios, openImports, openReceipts, openNotifications, openAssistant, openAICredentials, openAccess, openMembers, openSubscriptions, openRecurringRules, openDataJobs, openCatalogWrites, openSessions }: HomeActions = {}) {
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
        {openCatalogWrites && <AuthAction label="Crear en catálogos" action={openCatalogWrites} />}
        {openSubscriptions && <AuthAction label="Suscripciones detectadas" action={openSubscriptions} />}
        {openRecurringRules && <AuthAction label="Reglas recurrentes" action={openRecurringRules} />}
        {openTransfers && <AuthAction label="Transferencias" action={openTransfers} />}
        {openBudgets && <AuthAction label="Presupuestos" action={openBudgets} />}
        {openFunds && <AuthAction label="Fondos" action={openFunds} />}
        {openDebts && <AuthAction label="Deudas" action={openDebts} />}
        {openDataJobs && <AuthAction label="Informes y exportaciones" action={openDataJobs} />}
        {openImports && <AuthAction label="Importar extractos" action={openImports} />}
        {openReceipts && <AuthAction label="Recibos" action={openReceipts} />}
        {openNotifications && <AuthAction label="Notificaciones" action={openNotifications} />}
        {openAssistant && <AuthAction label="Asistente" action={openAssistant} />}
        {openAICredentials && <AuthAction label="Credenciales de IA" action={openAICredentials} />}
        {openAccess && <AuthAction label="Accesos de MCP y CLI" action={openAccess} />}
        {openMembers && <AuthAction label="Miembros del espacio" action={openMembers} />}
        {openSessions && <AuthAction label="Sesiones" action={openSessions} />}
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
