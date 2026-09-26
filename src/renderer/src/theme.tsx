import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { APPEARANCES, appearanceForId, type AppearanceId } from "./appearances";

export type ThemeId = AppearanceId;
export { APPEARANCES };

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

const THEME_KEY = "orbit.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function storedTheme(): ThemeId {
  const value = window.localStorage.getItem(THEME_KEY);
  const stored = APPEARANCES.find((appearance) => appearance.id === value);
  if (stored) return stored.id;
  if (value === "paper") return "papertrail";
  return "prism";
}

function applyAppearance(theme: ThemeId): void {
  const { colors, scheme } = appearanceForId(theme);
  const root = document.documentElement;
  const accentMix = (amount: number): string => `color-mix(in srgb, ${colors.accent} ${amount}%, transparent)`;
  const variables: Record<string, string> = {
    "--bg": colors.base,
    "--bg-panel": colors.pane,
    "--bg-inset": colors.tab,
    "--bg-elev": colors.card,
    "--bg-active-pill": colors.selected,
    "--bg-hover": accentMix(7),
    "--bg-active": accentMix(16),
    "--panel-surface-color": colors.pane,
    "--panel-float-color": colors.agent,
    "--panel-surface-image": "none",
    "--panel-surface-size": "auto",
    "--panel-surface-repeat": "no-repeat",
    "--workspace-background": `radial-gradient(ellipse at 66% 15%, ${colors.glow} 0, transparent 44%), ${colors.base}`,
    "--rail-surface": colors.rail,
    "--top-surface": colors.top,
    "--editor-surface": colors.editor,
    "--terminal-surface": colors.console,
    "--status-surface": colors.status,
    "--agent-bg-base": colors.agent,
    "--agent-bg-deep": colors.base,
    "--agent-bg-layer": colors.card,
    "--agent-bg-hover": accentMix(7),
    "--agent-bg-active": accentMix(13),
    "--agent-border-muted": colors.lineSoft,
    "--agent-border-base": colors.line,
    "--agent-border-strong": colors.lineStrong,
    "--agent-chat-ink": colors.muted,
    "--agent-composer-background": colors.compose,
    "--agent-composer-border": `color-mix(in srgb, ${colors.accent} 48%, ${colors.line})`,
    "--agent-composer-shadow": colors.composeShadow,
    "--agent-composer-focus-border": colors.accent,
    "--agent-composer-focus-shadow": `0 8px 26px rgba(0,0,0,.28), 0 0 0 3px ${accentMix(15)}`,
    "--agent-send-background": `linear-gradient(160deg, ${colors.accent}, color-mix(in srgb, ${colors.accent} 78%, ${colors.base}))`,
    "--agent-send-hover": `linear-gradient(160deg, color-mix(in srgb, ${colors.accent} 84%, white), ${colors.accent})`,
    "--agent-send-color": colors.sendInk,
    "--agent-send-shadow": `0 5px 16px ${accentMix(30)}`,
    "--agent-send-hover-shadow": `0 6px 20px ${accentMix(40)}`,
    "--text": colors.ink,
    "--text-dim": colors.muted,
    "--text-faint": colors.faint,
    "--text-base": colors.ink,
    "--text-weak": colors.faint,
    "--accent": colors.accent,
    "--accent-hover": `color-mix(in srgb, ${colors.accent} 84%, white)`,
    "--accent-dim": accentMix(18),
    "--accent-tint": accentMix(10),
    "--green": colors.good,
    "--red": colors.danger,
    "--yellow": colors.syntaxString,
    "--sky": colors.syntaxFunction,
    "--border": colors.line,
    "--border-strong": colors.lineStrong,
    "--border-subtle": colors.lineSoft,
    "--fg": colors.ink,
    "--bg-raised": colors.card,
    "--interactive-hover": accentMix(7),
    "--on-accent": colors.sendInk,
    "--danger": colors.danger,
    "--danger-bg": `color-mix(in srgb, ${colors.danger} 14%, transparent)`,
    "--streaming-ink": colors.accent
  };
  if (theme === "kitty") Object.assign(variables, {
    "--bg": "transparent",
    "--workspace-background": "transparent",
    "--panel-surface-color": "rgba(2, 2, 4, 0.08)",
    "--panel-float-color": "rgba(14, 18, 28, 0.44)",
    "--panel-surface-image": "radial-gradient(900px 580px at 100% 0%, rgba(0, 162, 206, 0.10), transparent 66%), linear-gradient(135deg, rgba(67, 36, 43, 0.20), transparent 46%)",
    "--panel-surface-size": "cover",
    "--agent-bg-base": "rgba(2, 2, 4, 0.38)",
    "--agent-bg-deep": "rgba(2, 2, 4, 0.18)",
    "--agent-bg-layer": "rgba(52, 58, 85, 0.38)",
    "--agent-composer-background": "linear-gradient(118deg, rgba(0, 162, 206, 0.10), transparent 36%), linear-gradient(300deg, rgba(67, 36, 43, 0.15), transparent 44%), rgba(14, 18, 28, 0.34)",
    "--agent-composer-border": "rgba(0, 162, 206, 0.32)",
    "--agent-composer-shadow": "0 7px 24px rgba(0, 0, 0, 0.38), inset 0 1px rgba(231, 231, 238, 0.06)",
    "--agent-composer-focus-border": "rgba(0, 162, 206, 0.64)",
    "--agent-composer-focus-shadow": "0 8px 26px rgba(0, 0, 0, 0.42), 0 0 0 3px rgba(0, 162, 206, 0.12)"
  });
  if (theme === "original") Object.assign(variables, {
    "--workspace-background": colors.base,
    "--agent-composer-background": "linear-gradient(118deg, rgba(148, 174, 151, 0.045), transparent 34%), linear-gradient(300deg, rgba(196, 181, 154, 0.03), transparent 42%), #262220",
    "--agent-composer-border": "rgba(148, 174, 151, 0.18)",
    "--agent-composer-shadow": "0 4px 16px rgba(0, 0, 0, 0.28), 0 0 16px rgba(148, 174, 151, 0.025)"
  });
  root.dataset.theme = theme;
  root.style.colorScheme = scheme;
  for (const [property, color] of Object.entries(variables)) root.style.setProperty(property, color);
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [theme, setTheme] = useState<ThemeId>(storedTheme);

  useLayoutEffect(() => {
    const appearance = appearanceForId(theme);
    applyAppearance(theme);
    window.localStorage.setItem(THEME_KEY, theme);
    // Keep the native appearance (macOS window vibrancy and native chrome) on
    // the theme's side of light/dark; a light system appearance would
    // otherwise wash the transparent glass profiles out with a near-white
    // material. The main process applies this to `nativeTheme.themeSource`.
    void window.openshell?.setAppearance?.(appearance.scheme)?.catch(() => {});
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
