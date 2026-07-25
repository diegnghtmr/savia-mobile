import { fireEvent, render, screen } from "@testing-library/react-native";
import { useColorScheme, useWindowDimensions } from "react-native";
import HomeScreen from "../src/app/index";
import NotFoundScreen from "../src/app/+not-found";

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({ default: jest.fn(() => "light") }));
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ default: jest.fn(() => ({ fontScale: 1, height: 640, scale: 1, width: 320 })) }));

const colorScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const dimensions = useWindowDimensions as jest.MockedFunction<typeof useWindowDimensions>;

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

test("updates semantic palette when system appearance changes", async () => {
  const view = await render(<HomeScreen />);
  colorScheme.mockReturnValue("dark");
  await view.rerender(<HomeScreen />);
  expect(screen.getByText("Tu dinero, con calma").props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: "#EFF6F1" })]));
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
