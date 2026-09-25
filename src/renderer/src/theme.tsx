import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

export type ThemeId = "original" | "paper" | "kitty";

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

const THEME_KEY = "orbit.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function appearanceForTheme(theme: ThemeId): "dark" | "light" {
  return theme === "paper" ? "light" : "dark";
}

function storedTheme(): ThemeId {
  const value = window.localStorage.getItem(THEME_KEY);
  if (value === "paper" || value === "kitty") return value;
  return "original";
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [theme, setTheme] = useState<ThemeId>(storedTheme);

  useLayoutEffect(() => {
    if (theme === "original") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
    // Keep the native appearance (macOS window vibrancy and native chrome) on
    // the theme's side of light/dark; a light system appearance would
    // otherwise wash the transparent glass profiles out with a near-white
    // material. The main process applies this to `nativeTheme.themeSource`.
    void window.openshell?.setAppearance?.(appearanceForTheme(theme))?.catch(() => {});
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}

export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
