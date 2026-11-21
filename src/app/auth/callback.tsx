import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Text, useColorScheme } from "react-native";
import { getAuth } from "../../foundation/auth";
import { AuthAction, AuthPanel } from "../../mobile-shell/auth-gate";
import { paletteFor } from "../../mobile-shell/tokens";

export default function AuthCallback() {
  const { code } = useLocalSearchParams<{ code?: string | string[] }>();
  const colors = paletteFor(useColorScheme());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      if (typeof code !== "string") throw new Error("Missing auth code");
      return getAuth().exchangeCode(code);
    }).then(() => { if (active) router.replace("/"); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [code]);
  return <AuthPanel>
    <Text accessibilityRole={failed ? "alert" : "header"} style={{ color: colors.text }}>{failed ? "No pudimos confirmar el enlace." : "Confirmando tu cuenta…"}</Text>
    {failed && <AuthAction label="Volver a iniciar sesión" action={() => router.replace("/")} />}
  </AuthPanel>;
}
