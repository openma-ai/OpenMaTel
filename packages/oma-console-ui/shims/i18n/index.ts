/**
 * English-only i18n shim.
 *
 * The console ships a full context/provider and lazily loads zh-CN. OpenMaTel
 * only needs the English dictionary, so this module reuses the console's
 * vendored `en.ts` verbatim and exposes the same `useI18n` shape.
 */

import type { ReactNode } from "react";

import { en } from "@/i18n/en";
import type { Locale, Messages } from "@/i18n/types";

export type { Locale, Messages } from "@/i18n/types";

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Messages;
}

const value: I18nContextValue = {
  locale: "en",
  setLocale: () => {
    // Only English is bundled.
  },
  t: en,
};

export function useI18n(): I18nContextValue {
  return value;
}

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  return children;
}

export const AVAILABLE_LOCALES: { value: Locale; label: string; flag: string }[] = [
  { value: "en", label: "English", flag: "EN" },
];
