import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet, useColorScheme, useWindowDimensions } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File as LocalFile } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import Index, { HomeScreen, SaviaMobile } from "../src/app/index";
import NotFoundScreen from "../src/app/+not-found";
import { InvalidDraft } from "../src/foundation/identity-draft";
import { createImports } from "../src/foundation/imports";
import { createReceipts } from "../src/foundation/receipts";
import { createTransport } from "../src/foundation/transport";
import { createInbox } from "../src/foundation/notification-inbox";
import { createNotificationPreferences } from "../src/foundation/notification-preferences";

jest.mock("../src/foundation/accounts", () => ({ createAccounts: jest.fn(() => ({})) }));
jest.mock("../src/foundation/analytics", () => ({ createAnalytics: jest.fn() }));
jest.mock("../src/foundation/auth", () => ({ getAuth: jest.fn() }));
jest.mock("../src/foundation/budgets", () => ({ createBudgets: jest.fn() }));
jest.mock("../src/foundation/budget-writes", () => ({ createBudgetWrites: jest.fn() }));
jest.mock("../src/foundation/debt-payments", () => ({ createDebtPayments: jest.fn() }));
jest.mock("../src/foundation/debts", () => ({ createDebts: jest.fn() }));
jest.mock("../src/foundation/forecasts", () => ({ createForecasts: jest.fn() }));
jest.mock("../src/foundation/receipts", () => ({ ...jest.requireActual("../src/foundation/receipts"), createReceipts: jest.fn(() => ({})) }));
jest.mock("../src/foundation/notification-inbox", () => ({ createInbox: jest.fn() }));
jest.mock("../src/foundation/notification-preferences", () => ({ createNotificationPreferences: jest.fn() }));
jest.mock("../src/foundation/receipt-confirmations", () => ({ createReceiptConfirmations: jest.fn() }));
jest.mock("../src/foundation/scenarios", () => ({ createScenarios: jest.fn() }));
jest.mock("../src/foundation/funds", () => ({ ...jest.requireActual("../src/foundation/funds"), createFunds: jest.fn() }));
jest.mock("../src/foundation/fund-writes", () => ({ createFundWrites: jest.fn() }));
jest.mock("../src/foundation/imports", () => ({ ...jest.requireActual("../src/foundation/imports"), createImports: jest.fn() }));
jest.mock("../src/foundation/import-commits", () => ({ createImportCommits: jest.fn() }));
jest.mock("../src/foundation/identity", () => ({ createIdentity: jest.fn() }));
jest.mock("../src/foundation/offline-cache", () => ({ createOffline: jest.fn(() => {
  const active = { id: "abca0000-0000-4000-8000-000000000001", name: "Casa" };
  return { identity: { bootstrap: async () => ({ profileId: "abca0000-0000-4000-8000-000000000002", active, items: [active] }) },
    scope: jest.fn(), outbox: () => ({ list: async () => [], subscribe: () => () => {}, sync: async () => {} }) };
}) }));
jest.mock("../src/foundation/transactions", () => ({ createTransactions: jest.fn(() => ({})) }));
jest.mock("../src/foundation/transfers", () => ({ createTransfers: jest.fn() }));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({}));
jest.mock("expo-document-picker", () => ({ getDocumentAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ requestCameraPermissionsAsync: jest.fn(), requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-file-system", () => ({ Paths: { cache: { uri: "file:///private/cache/" } }, File: jest.fn() }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("../src/foundation/transport", () => ({ ...jest.requireActual("../src/foundation/transport"), createTransport: jest.fn() }));

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({ default: jest.fn(() => "light") }));
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ default: jest.fn(() => ({ fontScale: 1, height: 640, scale: 1, width: 320 })) }));

const colorScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const dimensions = useWindowDimensions as jest.MockedFunction<typeof useWindowDimensions>;

const LIGHT_ROLES = { action: "#075A9C", canvas: "#F8F5EF", disabled: "#4F5C67", muted: "#53606D", raised: "#F1ECE3", text: "#20252B" } as const;
const DARK_ROLES = { action: "#8DCCFF", canvas: "#17212B", disabled: "#BCC8D0", muted: "#C5D0D8", raised: "#293844", text: "#F7F3EA" } as const;
const styleOf = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style);

beforeEach(() => { colorScheme.mockReturnValue("light"); dimensions.mockReturnValue({ fontScale: 1, height: 640, scale: 1, width: 320 }); });

test("renders the same truthful Spanish state repeatedly", async () => {
  const first = await render(<HomeScreen />);
  expect(first.getByText("Tu dinero, con calma")).toBeTruthy();
  await first.unmount();
  await render(<HomeScreen />);
  expect(screen.getByText("Tu dinero, con calma")).toBeTruthy();
  expect(screen.queryByText(/[$€£]|\d+[.,]\d{2}/)).toBeNull();
});

test("keeps the finance action disabled and inert", async () => {
  await render(<HomeScreen />);
  const action = screen.getByRole("button", { name: "Registrar movimiento no disponible" });
  expect(action.props.accessibilityState).toEqual({ disabled: true });
  fireEvent.press(action);
  expect(screen.queryByText(/éxito|guardado|enviado/i)).toBeNull();
});

test("starts a new movement from the authenticated summary", async () => {
  const register = jest.fn();
  await render(<HomeScreen registerMovement={register} />);
  await fireEvent.press(screen.getByRole("button", { name: "Registrar movimiento" }));
  expect(register).toHaveBeenCalledTimes(1);
});

test("opens analytics and dashboard without changing the other workspace actions", async () => {
  const accounts = jest.fn(), transactions = jest.fn(), transfers = jest.fn(), budgets = jest.fn(), funds = jest.fn(), debts = jest.fn(), dashboard = jest.fn(), analytics = jest.fn();
  await render(<HomeScreen openAccounts={accounts} openTransactions={transactions} openTransfers={transfers} openBudgets={budgets} openFunds={funds} openDebts={debts} openDashboard={dashboard} openAnalytics={analytics} />);
  await fireEvent.press(screen.getByRole("button", { name: "Cuentas" }));
  expect(accounts).toHaveBeenCalledTimes(1); expect(transactions).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Movimientos" }));
  expect(accounts).toHaveBeenCalledTimes(1); expect(transactions).toHaveBeenCalledTimes(1); expect(transfers).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Transferencias" }));
  expect(transfers).toHaveBeenCalledTimes(1); expect(budgets).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Presupuestos" }));
  expect(funds).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Fondos" }));
  expect(debts).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Deudas" }));
  expect(dashboard).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Resumen financiero" }));
  expect(analytics).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Analítica" }));
  expect(analytics).toHaveBeenCalledTimes(1); expect(dashboard).toHaveBeenCalledTimes(1); expect(debts).toHaveBeenCalledTimes(1); expect(funds).toHaveBeenCalledTimes(1);
  expect(budgets).toHaveBeenCalledTimes(1); expect(accounts).toHaveBeenCalledTimes(1);
  expect(transactions).toHaveBeenCalledTimes(1); expect(transfers).toHaveBeenCalledTimes(1);
});

test("opens forecasts and scenarios from the workspace home", async () => {
  const forecast = jest.fn(), scenarios = jest.fn();
  await render(<HomeScreen openForecasts={forecast} openScenarios={scenarios} />);
  await fireEvent.press(screen.getByRole("button", { name: "Pronósticos" }));
  expect(forecast).toHaveBeenCalledTimes(1); expect(scenarios).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Escenarios" }));
  expect(scenarios).toHaveBeenCalledTimes(1);
});

test("opens statement imports from the workspace home", async () => {
  const open = jest.fn();
  await render(<HomeScreen openImports={open} />);
  await fireEvent.press(screen.getByRole("button", { name: "Importar extractos" }));
  expect(open).toHaveBeenCalledTimes(1);
});

test("opens receipts from the workspace home", async () => {
  const open = jest.fn(); await render(<HomeScreen openReceipts={open} />);
  await fireEvent.press(screen.getByRole("button", { name: "Recibos" }));
  expect(open).toHaveBeenCalledTimes(1);
});

const pressPicker = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
const pickerLimit = 5 * 1024 * 1024;
const cancel = { canceled: true, assets: null } as const;
const permission = { granted: true, canAskAgain: true, expires: "never", status: "granted" } as Awaited<ReturnType<typeof ImagePicker.requestCameraPermissionsAsync>>;
const receiptUri = "file:///private/cache/ImagePicker/cb8e9033-5ec0-43f9-8253-5ee243d70c68.png";
const receiptAsset = { uri: receiptUri, width: 10, height: 10, fileName: "recibo.png", mimeType: "image/png", fileSize: 4 };

function localBlob(blob: Blob) {
  const request = { status: 0, response: blob, onload: () => {}, open: jest.fn(), send: jest.fn((): void => request.onload()) };
  const create = jest.fn(() => request);
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: create });
  return { request, create };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(cancel);
  jest.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue(permission);
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue(permission);
  jest.mocked(ImagePicker.launchCameraAsync).mockResolvedValue(cancel);
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(cancel);
});
const originalLocalReader = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
afterEach(() => {
  if (originalLocalReader) Object.defineProperty(globalThis, "XMLHttpRequest", originalLocalReader);
  else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
});

test("the default route picks one CSV without copying it, rejects a byte over the limit, and uploads only on submit", async () => {
  const uri = "content://documents/extracto", asset = { uri, name: "extracto.csv", lastModified: 0, size: pickerLimit };
  const blob = new Blob([new Uint8Array(pickerLimit)], { type: "text/csv" }), { create, request } = localBlob(blob);
  const upload = jest.fn().mockRejectedValue(new InvalidDraft("Archivo recibido por la prueba."));
  jest.mocked(createImports).mockReturnValue({ upload, detail: jest.fn() });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({ canceled: false, assets: [{ ...asset, size: pickerLimit + 1 }] })
    .mockResolvedValueOnce({ canceled: false, assets: [{ ...asset, uri: "https://files.invalid/extracto.csv" }] })
    .mockResolvedValueOnce({ canceled: false, assets: [asset] });
  await render(<Index />);
  await pressPicker("Importar extractos");
  expect(DocumentPicker.getDocumentAsync).not.toHaveBeenCalled();
  await pressPicker("Elegir extracto");
  expect(await screen.findByText("Elige un archivo CSV de hasta 5 MiB.")).toBeTruthy();
  expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledWith({ type: ["text/csv", "application/csv", "application/vnd.ms-excel"], copyToCacheDirectory: false, multiple: false, base64: false });
  await pressPicker("Elegir extracto");
  expect(await screen.findByText("No pudimos abrir el selector de archivos.")).toBeTruthy();
  expect(create).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Subir para analizar" })).toBeNull();
  await pressPicker("Elegir extracto");
  expect(await screen.findByText(asset.name)).toBeTruthy();
  expect(request.open).toHaveBeenCalledWith("GET", uri); expect(upload).not.toHaveBeenCalled();
  await pressPicker("Subir para analizar");
  expect(await screen.findByText("Archivo recibido por la prueba.")).toBeTruthy();
  expect(upload).toHaveBeenCalledWith({ name: asset.name, blob });
  await pressPicker("Elegir extracto");
  await waitFor(() => expect(screen.queryByText(asset.name)).toBeNull());
  expect(request.open).toHaveBeenCalledTimes(1); expect(upload).toHaveBeenCalledTimes(1);
});

test.each([
  ["Tomar foto", "Activa el permiso de cámara en los ajustes para tomar una foto del recibo.", ImagePicker.requestCameraPermissionsAsync],
  ["Elegir de la galería", "Activa el permiso de fotos en los ajustes para elegir una imagen del recibo.", ImagePicker.requestMediaLibraryPermissionsAsync],
])("the default receipt route handles denial on demand for %s", async (action, message, requestPermission) => {
  jest.mocked(requestPermission).mockResolvedValueOnce({ ...permission, granted: false });
  await render(<Index />);
  await pressPicker("Recibos");
  expect(ImagePicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
  expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  await pressPicker(action);
  expect(await screen.findByText(message)).toBeTruthy();
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled(); expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Subir recibo" })).toBeNull(); expect(createTransport).not.toHaveBeenCalled();
});

test.each([
  ["Tomar foto", ImagePicker.requestCameraPermissionsAsync, ImagePicker.launchCameraAsync, ImagePicker.launchImageLibraryAsync],
  ["Elegir de la galería", ImagePicker.requestMediaLibraryPermissionsAsync, ImagePicker.launchImageLibraryAsync, ImagePicker.launchCameraAsync],
])("the default receipt route keeps only the in-memory image when using %s", async (action, requestPermission, launch, otherLaunch) => {
  const blob = new Blob(["body"], { type: "image/png" }), { request, create } = localBlob(blob);
  const remove = jest.fn(), upload = jest.fn().mockRejectedValue(new InvalidDraft("Imagen recibida por la prueba."));
  jest.mocked(LocalFile).mockImplementation(() => ({ delete: remove } as unknown as LocalFile));
  jest.mocked(createReceipts).mockReturnValue({ upload, detail: jest.fn() });
  jest.mocked(launch).mockResolvedValueOnce({ canceled: false, assets: [{ ...receiptAsset, fileSize: pickerLimit + 1 }] })
    .mockResolvedValueOnce({ canceled: false, assets: [receiptAsset] });
  await render(<Index />);
  await pressPicker("Recibos");
  await pressPicker(action);
  expect(await screen.findByText("Elige una imagen JPEG, PNG o WebP de hasta 5 MiB.")).toBeTruthy();
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: false, base64: false, exif: false }));
  expect(jest.mocked(requestPermission).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(launch).mock.invocationCallOrder[0]);
  expect(create).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledTimes(1);
  await pressPicker(action);
  expect(await screen.findByText("recibo.png")).toBeTruthy();
  expect(request.open).toHaveBeenCalledWith("GET", receiptUri);
  expect(otherLaunch).not.toHaveBeenCalled(); expect(LocalFile).toHaveBeenCalledWith(receiptUri);
  expect(remove).toHaveBeenCalledTimes(2); expect(upload).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
  await pressPicker("Subir recibo");
  expect(await screen.findByText("Imagen recibida por la prueba.")).toBeTruthy();
  expect(upload).toHaveBeenCalledWith({ name: "recibo.png", blob }, undefined);
});

test("navigates from the workspace to the inbox and settings and passes the optional push source on demand", async () => {
  const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
  const load = jest.fn().mockRejectedValue(new InvalidDraft("Preferencias de notificaciones no disponibles."));
  const register = jest.fn().mockRejectedValue(new InvalidDraft("Registro de notificaciones push no disponible."));
  const registration = { expoPushToken: "ExpoPushToken[fixture]", platform: "ios" as const, appVersion: "1.0.0" };
  const pushTokenSource = jest.fn().mockResolvedValue(registration);
  jest.mocked(createInbox).mockReturnValue({ list, mark: jest.fn() });
  jest.mocked(createNotificationPreferences).mockReturnValue({ load, save: jest.fn(), register });
  await render(<SaviaMobile pushTokenSource={pushTokenSource} />);
  const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
  await press("Notificaciones");
  expect(await screen.findByText("No hay notificaciones.")).toBeTruthy();
  expect(list).toHaveBeenCalledTimes(1); expect(load).not.toHaveBeenCalled();
  await press("Preferencias de notificaciones");
  expect(await screen.findByText("Preferencias de notificaciones no disponibles.")).toBeTruthy();
  expect(pushTokenSource).not.toHaveBeenCalled();
  await press("Registrar este dispositivo");
  expect(await screen.findByText("Registro de notificaciones push no disponible.")).toBeTruthy();
  expect(pushTokenSource).toHaveBeenCalledTimes(1); expect(register).toHaveBeenCalledWith(registration);
  await press("Volver a notificaciones");
  expect(await screen.findByText("No hay notificaciones.")).toBeTruthy();
  await press("Volver al resumen");
  expect(await screen.findByText("Tu dinero, con calma")).toBeTruthy();
});

test("exposes semantic heading, order, and 44px target", async () => {
  await render(<HomeScreen />);
  expect(screen.getByText("Tu dinero, con calma").parent?.props.accessibilityRole).toBe("header");
  expect(screen.getByRole("button").props.style).toEqual(expect.arrayContaining([expect.objectContaining({ minHeight: 44, minWidth: 44 })]));
});

test("supports narrow width and 200 percent text scale", async () => {
  dimensions.mockReturnValue({ fontScale: 2, height: 640, scale: 1, width: 320 });
  await render(<HomeScreen />);
  expect(screen.getByTestId("viewport-320-2")).toBeTruthy();
});

test.each([["light", LIGHT_ROLES], ["dark", DARK_ROLES]])("binds %s palette roles to certified contrast pairs (canvas 001/049, text 001/049, muted 004/052, action 011/059, raised fill 038/086, disabled label 038/086)", async (scheme, roles) => {
  colorScheme.mockReturnValue(scheme as "light" | "dark");
  await render(<HomeScreen />);
  expect(styleOf(screen.getByTestId("canvas"))).toEqual(expect.objectContaining({ backgroundColor: roles.canvas }));
  expect(styleOf(screen.getByText("Tu dinero, con calma"))).toEqual(expect.objectContaining({ color: roles.text }));
  expect(styleOf(screen.getByText("Todavía no hay información financiera disponible."))).toEqual(expect.objectContaining({ color: roles.muted }));
  expect(styleOf(screen.getByText("Savia"))).toEqual(expect.objectContaining({ color: roles.action }));
  expect(styleOf(screen.getByRole("button", { name: "Registrar movimiento no disponible" }))).toEqual(expect.objectContaining({ backgroundColor: roles.raised }));
  expect(styleOf(screen.getByText("Registrar movimiento"))).toEqual(expect.objectContaining({ color: roles.disabled }));
});

test("updates semantic palette when system appearance changes", async () => {
  const view = await render(<HomeScreen />);
  expect(styleOf(screen.getByText("Tu dinero, con calma"))).toEqual(expect.objectContaining({ color: LIGHT_ROLES.text }));
  colorScheme.mockReturnValue("dark");
  await view.rerender(<HomeScreen />);
  expect(styleOf(screen.getByText("Tu dinero, con calma"))).toEqual(expect.objectContaining({ color: DARK_ROLES.text }));
});

test("closes unknown routes without finance behavior", async () => {
  await render(<NotFoundScreen />);
  expect(screen.getByText("Ruta no disponible").parent?.props.accessibilityRole).toBe("alert");
});

test("performs no runtime transport or persistence", async () => {
  const traps = ["fetch", "XMLHttpRequest", "WebSocket", "localStorage"] as const;
  const previous = traps.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of traps) Object.defineProperty(globalThis, name, { configurable: true, value: () => { throw new Error(name); } });
  await expect(render(<HomeScreen />)).resolves.toBeTruthy();
  for (const [name, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete (globalThis as Record<string, unknown>)[name];
});
