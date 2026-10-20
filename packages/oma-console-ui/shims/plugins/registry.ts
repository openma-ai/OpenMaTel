// Console plugin registry shim.
//
// OpenMaTel has no hosted-only extensions, so the sidebar and route table see
// the same empty registry that a self-hosted OpenMA install sees.

import type { ReactNode, ComponentType } from "react";

export interface PluginNavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

export interface PluginNavGroup {
  label: string;
  items: PluginNavItem[];
}

export interface PluginRoute {
  path: string;
  element: ReactNode;
}

export interface ConsolePlugin {
  id: string;
  routes?: PluginRoute[];
  navGroups?: PluginNavGroup[];
}

export const consolePlugins: ConsolePlugin[] = [];
