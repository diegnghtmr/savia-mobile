import type { ColorSchemeName } from "react-native";

interface Palette { accent: string; canvas: string; disabled: string; disabledInk: string; ink: string; muted: string }

const LIGHT: Palette = { accent: "#1F6A4A", canvas: "#F5F2E9", disabled: "#D7D2C5", disabledInk: "#625F58", ink: "#18251F", muted: "#55635C" };
const DARK: Palette = { accent: "#75D3A7", canvas: "#101713", disabled: "#303A34", disabledInk: "#AAB4AE", ink: "#EFF6F1", muted: "#B8C4BD" };

export function paletteFor(scheme: ColorSchemeName): Palette { return scheme === "dark" ? DARK : LIGHT; }
