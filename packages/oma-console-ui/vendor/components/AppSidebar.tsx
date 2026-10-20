import type { ComponentType } from "react";
import { NavLink, useLocation } from "react-router";
import { useScrollFade } from "@/hooks/useScrollFade";

import { TenantSwitcher } from "./TenantSwitcher";
import { UserProfile } from "./UserProfile";
import { SessionsIcon } from "./icons";
import { consolePlugins } from "../plugins/registry";
import { useI18n } from "../i18n";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

function useNavGroups(): NavGroup[] {
  const { t } = useI18n();
  return [
    {
      label: t.nav.managedAgents,
      items: [{ to: "/sessions", label: t.nav.sessions, icon: SessionsIcon }],
    },
  ];
}

export function AppSidebar() {
  const navFade = useScrollFade<HTMLElement>();
  const { pathname } = useLocation();
  const { t } = useI18n();
  const navGroups = [
    ...useNavGroups(),
    ...consolePlugins.flatMap((plugin) => plugin.navGroups ?? []),
  ];

  return (
    <aside className="console-sidebar" aria-label="Workspace navigation" data-sidebar="sidebar">
      <div className="console-sidebar-tenant">
        <TenantSwitcher />
      </div>

      <nav ref={navFade.ref} className={`console-sidebar-nav console-scroll-fade ${navFade.className}`} aria-label="Console">
        {navGroups.map((group, groupIndex) => (
          <section className="console-sidebar-group" key={group.label}>
            {groupIndex > 0 && (
              <div className="console-sidebar-group-label" data-sidebar-track="label">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = item.end
                ? pathname === item.to
                : pathname === item.to || pathname.startsWith(`${item.to}/`);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="console-sidebar-row"
                  data-active={active || undefined}
                  aria-current={active ? "page" : undefined}
                >
                  <span data-sidebar-slot data-sidebar-track="icon">
                    <item.icon className="size-4" />
                  </span>
                  <span data-sidebar-track="label">{item.label}</span>
                </NavLink>
              );
            })}
          </section>
        ))}
      </nav>

      <footer className="console-sidebar-footer">
        <UserProfile />
      </footer>
    </aside>
  );
}
