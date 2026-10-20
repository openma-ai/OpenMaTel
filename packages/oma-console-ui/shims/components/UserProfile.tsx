import { MoonIcon, SunIcon } from "lucide-react";

import { useTheme } from "../lib/theme";

/**
 * Sidebar footer identity.
 *
 * Replaces the console's account menu with the local workspace label and the
 * console's light/dark toggle (the vendored shell has no separate theme
 * control).
 */
export function UserProfile() {
  const { effective, setTheme } = useTheme();
  const next = effective === "dark" ? "light" : "dark";

  return (
    <div className="console-sidebar-row">
      <span data-sidebar-slot data-sidebar-track="icon">
        <span
          aria-hidden="true"
          className="inline-flex size-5 items-center justify-center rounded-md bg-brand-subtle font-mono text-[10px] font-bold text-brand"
        >
          L
        </span>
      </span>
      <div className="min-w-0 leading-tight" data-sidebar-track="label">
        <div className="truncate text-sm text-fg">Local</div>
        <div className="truncate text-xs text-fg-subtle">
          {effective === "dark" ? "Dark" : "Light"} theme
        </div>
      </div>
      <button
        type="button"
        className="console-sidebar-search"
        onClick={() => setTheme(next)}
        aria-label={`Switch to ${next} theme`}
        title={`Switch to ${next} theme`}
      >
        {effective === "dark" ? (
          <SunIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <MoonIcon className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
