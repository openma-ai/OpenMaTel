/**
 * Class-based light/dark theme, copied from the console's `lib/theme.ts`.
 *
 * `system` follows `prefers-color-scheme`; an explicit choice is persisted in
 * localStorage. The `dark` class is toggled on `<html>`, which is what the
 * vendored `index.css` (`@custom-variant dark`) and `@openma/common` tokens
 * expect.
 */

import { useCallback, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

function storedTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Storage can be unavailable in private mode; system is a safe default.
  }
  return "system";
}

function getEffective(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function apply(effective: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", effective === "dark");
  document.documentElement.style.colorScheme = effective;
}

/** Apply the stored (or system) theme before React renders, avoiding a flash. */
export function applyInitialTheme(): void {
  apply(getEffective(storedTheme()));
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(storedTheme);

  const effective = getEffective(theme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A failed persistence write must not prevent the visual change.
    }
    apply(getEffective(next));
  }, []);

  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (): void => apply(getEffective("system"));
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme]);

  useEffect(() => {
    apply(effective);
  }, [effective]);

  return { theme, effective, setTheme } as const;
}
