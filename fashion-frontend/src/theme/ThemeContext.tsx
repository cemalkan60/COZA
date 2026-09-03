import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";

import { storage } from "@/src/utils/storage";
import {
  darkColors,
  lightColors,
  chartPaletteDark,
  chartPaletteLight,
  spacing,
  radius,
  fontSize,
  ThemeColors,
} from "./tokens";

type Mode = "dark" | "light";

type ThemeValue = {
  mode: Mode;
  colors: ThemeColors;
  chartPalette: string[];
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  toggle: () => void;
  ready: boolean;
};

const THEME_KEY = "coza.theme.mode";
const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: React.PropsWithChildren) {
  const system = useColorScheme();
  const [mode, setMode] = useState<Mode>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await storage.getItem<string>(THEME_KEY, "");
      if (saved === "dark" || saved === "light") {
        setMode(saved);
      } else {
        setMode(system === "light" ? "light" : "dark");
      }
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    setMode((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      storage.setItem(THEME_KEY, next);
      return next;
    });
  };

  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      colors: mode === "dark" ? darkColors : lightColors,
      chartPalette: mode === "dark" ? chartPaletteDark : chartPaletteLight,
      spacing,
      radius,
      fontSize,
      toggle,
      ready,
    }),
    [mode, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
