import { Logo } from "@/components/Logo";

/**
 * Sidebar identity slot.
 *
 * Replaces the console's tenant switcher: OpenMaTel is single-user and local,
 * so the slot names the product and the one workspace that exists.
 */
export function TenantSwitcher() {
  return (
    <div className="console-sidebar-row console-sidebar-tenant-trigger">
      <span data-sidebar-slot data-sidebar-track="icon">
        <Logo size="sm" />
      </span>
      <div className="min-w-0 leading-tight" data-sidebar-track="label">
        <div className="truncate text-sm font-medium text-fg">OpenMaTel</div>
        <div className="text-xs uppercase tracking-wider text-fg-subtle">Local</div>
      </div>
    </div>
  );
}
