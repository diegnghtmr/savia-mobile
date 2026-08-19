import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, useColorScheme, useWindowDimensions } from "react-native";
import HomeScreen from "../src/app/index";
import NotFoundScreen from "../src/app/+not-found";

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
