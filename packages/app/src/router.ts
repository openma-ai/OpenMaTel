/**
 * A tiny history-API router.
 *
 * Two routes are all the SPA needs, so pulling in a router dependency would
 * be more surface than value: pushState on navigation, popstate for the back
 * and forward buttons.
 */

import { useCallback, useEffect, useState } from "react";

const currentPath = (): string =>
  typeof window === "undefined" ? "/" : window.location.pathname;

/** Keep the current pathname in state and expose a history-aware navigate. */
export function useHistoryRoute(): {
  path: string;
  navigate: (href: string) => void;
} {
  const [path, setPath] = useState<string>(currentPath);

  useEffect(() => {
    const sync = (): void => setPath(currentPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const navigate = useCallback((href: string) => {
    const url = new URL(href, window.location.href);
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) {
      window.history.pushState({}, "", next);
    }
    setPath(url.pathname);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  return { path, navigate };
}
