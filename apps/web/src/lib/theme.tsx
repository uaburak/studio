import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { storage } from "./storage.ts";

export type ThemePreference = "system" | "light" | "dark";
const KEY = "studio.theme";

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): "light" | "dark" {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const saved = storage.get(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = () => setPrefersDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(preference, prefersDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const value = useMemo<ThemeState>(
    () => ({
      preference,
      resolved,
      setPreference: (pref) => {
        storage.set(KEY, pref === "system" ? null : pref);
        setPreference(pref);
      },
    }),
    [preference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}
