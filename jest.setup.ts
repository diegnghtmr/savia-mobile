import { jest } from "@jest/globals";

jest.mock("expo-router", () => ({
  Stack: Object.assign(({ children }: { children?: unknown }) => children ?? null, {
    Screen: () => null,
  }),
}));

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  SafeAreaView: require("react-native").View,
}));
