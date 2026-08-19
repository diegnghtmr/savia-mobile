import type { ColorSchemeName } from "react-native";

interface Palette { action: string; canvas: string; disabled: string; muted: string; raised: string; text: string }

const LIGHT: Palette = { action: "#075A9C", canvas: "#F8F5EF", disabled: "#4F5C67", muted: "#53606D", raised: "#F1ECE3", text: "#20252B" };
const DARK: Palette = { action: "#8DCCFF", canvas: "#17212B", disabled: "#BCC8D0", muted: "#C5D0D8", raised: "#293844", text: "#F7F3EA" };

export function paletteFor(scheme: ColorSchemeName): Palette { return scheme === "dark" ? DARK : LIGHT; }
