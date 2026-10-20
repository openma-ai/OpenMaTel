/**
 * The provider that injects the {@link ObsClient} and optional navigation.
 *
 * Keeping navigation in the provider lets the same components live in the
 * standalone SPA (history API), in an Electron window and in the openma
 * console (React Router) without importing a router dependency.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { ObsClient } from "./client.js";

/** Visual theme. `auto` follows `prefers-color-scheme`. */
export type ObsTheme = "auto" | "light" | "dark";

/** Value shared by every OpenMaTel component below a provider. */
export interface ObsContextValue {
  client: ObsClient;
  /** Navigate to an application path, e.g. `/sessions/ss_…`. */
  navigate: (href: string) => void;
  theme: ObsTheme;
}

const ObsContext = createContext<ObsContextValue | null>(null);

/** Props of {@link ObsProvider}. */
export interface ObsProviderProps {
  /** The injected data-access client. Required — there is no default store. */
  client: ObsClient;
  children?: ReactNode;
  /** Router integration. Defaults to a full page navigation. */
  navigate?: (href: string) => void;
  /** Theme override; light/dark by default follow the OS. */
  theme?: ObsTheme;
  /** Optional class name for the wrapper element. */
  className?: string;
}

const defaultNavigate = (href: string): void => {
  if (typeof window !== "undefined") window.location.assign(href);
};

/**
 * Provide OpenMaTel components with data access and navigation.
 *
 * The wrapper element carries the CSS variables of the package, so a host can
 * embed the component tree next to its own design system.
 */
export function ObsProvider({
  client,
  children,
  navigate = defaultNavigate,
  theme = "auto",
  className,
}: ObsProviderProps) {
  const value = useMemo<ObsContextValue>(
    () => ({ client, navigate, theme }),
    [client, navigate, theme],
  );

  return (
    <ObsContext.Provider value={value}>
      <div
        className={className === undefined ? "omt-root" : `omt-root ${className}`}
        data-theme={theme}
      >
        {children}
      </div>
    </ObsContext.Provider>
  );
}

/** Read the injected client, navigation and theme. */
export function useObs(): ObsContextValue {
  const value = useContext(ObsContext);
  if (value === null) {
    throw new Error("OpenMaTel components must be rendered inside <ObsProvider client={…}>");
  }
  return value;
}

/**
 * Like {@link useObs}, but returns `null` outside a provider.
 *
 * Components use it so they can also be rendered with an explicit `client`
 * prop (Storybook, an isolated test, an embedded shell).
 */
export function useObsOptional(): ObsContextValue | null {
  return useContext(ObsContext);
}
