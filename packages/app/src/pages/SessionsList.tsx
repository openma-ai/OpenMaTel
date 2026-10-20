import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import type { SessionStatus, SessionSummary } from "@openmatel/core";
import { formatCoverage, formatTokens } from "@openmatel/ui";

import { Badge, type StatusTone, StatusPill } from "@/components/Badge";
import { DataTable, type ColumnDef } from "@/components/DataTable";
import { FacetedFilter } from "@/components/FacetedFilter";
import { FilterChip } from "@/components/FilterChip";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { formatRelative } from "@/lib/format";

import { client } from "../client";

const LIMIT = 20;

/** Sources named by the OpenMaTel design; unknown sources are also searchable. */
const SOURCE_OPTIONS = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "dsh", label: "dsh" },
  { value: "pi", label: "pi" },
];

const ERROR_OPTIONS = [{ value: "true", label: "Has errors" }];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const statusTone = (status: SessionStatus): StatusTone => {
  switch (status) {
    case "ok":
      return "completed";
    case "error":
    case "timeout":
    case "denied":
      return "errored";
    case "cancelled":
    case "interrupted":
      return "terminated";
    default:
      return "neutral";
  }
};

const relativeStarted = (value: string | null): string => {
  if (value === null) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  return formatRelative(Date.now() - timestamp);
};

/** The session list, following the console's DataTable list architecture. */
export function SessionsListPage() {
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | undefined>(undefined);
  const [hasErrors, setHasErrors] = useState(false);
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Debounce typing so a search does not fire one request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNextCursor(null);

    client
      .listSessions({
        limit: LIMIT,
        ...(query !== "" ? { q: query } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(hasErrors ? { has_error: true } : {}),
      })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError(messageOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query, source, hasErrors, reload]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await client.listSessions({
        limit: LIMIT,
        ...(query !== "" ? { q: query } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(hasErrors ? { has_error: true } : {}),
        cursor: nextCursor,
      });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, query, source, hasErrors]);

  const filtersActive = query !== "" || source !== undefined || hasErrors;

  const columns = useMemo<ColumnDef<SessionSummary>[]>(
    () => [
      {
        id: "session",
        accessorFn: (session) => session.title ?? "",
        header: "Session",
        size: 260,
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium text-fg">
              {row.original.title !== null && row.original.title !== ""
                ? row.original.title
                : "Untitled session"}
            </span>
            <span
              className="truncate font-mono text-xs text-fg-subtle"
              title={row.original.session_id}
            >
              {row.original.session_id}
            </span>
          </div>
        ),
      },
      {
        id: "source",
        accessorFn: (session) => session.source ?? "",
        header: "Source",
        size: 150,
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <Badge label={row.original.source ?? "—"} />
            {row.original.harness && row.original.harness !== row.original.source ? (
              <Badge label={row.original.harness} />
            ) : null}
          </div>
        ),
      },
      {
        id: "model",
        accessorFn: (session) => session.model ?? "",
        header: "Model",
        size: 140,
        cell: ({ row }) => (
          <span className="block truncate font-mono text-xs text-fg-muted">
            {row.original.model ?? "—"}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (session) => session.status,
        header: "Status",
        size: 90,
        cell: ({ row }) => (
          <StatusPill
            status={statusTone(row.original.status)}
            label={row.original.status}
          />
        ),
      },
      {
        id: "turns",
        accessorFn: (session) => session.turn_count,
        header: "Turns / steps",
        size: 100,
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted">
            {row.original.turn_count} / {row.original.step_count}
          </span>
        ),
      },
      {
        id: "tools",
        accessorFn: (session) => session.tool_call_count,
        header: "Tool calls",
        size: 110,
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted">
            {row.original.tool_call_count}
            {row.original.tool_error_count > 0 ? (
              <span className="text-danger"> · {row.original.tool_error_count} failed</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "tokens",
        accessorFn: (session) => session.usage.total.input_tokens ?? 0,
        header: "Tokens in / out",
        size: 180,
        cell: ({ row }) => {
          const usage = row.original.usage;
          return (
            <span
              className="font-mono text-xs text-fg-muted"
              title={`${usage.covered} of ${usage.calls} calls reported usage`}
            >
              {formatTokens(usage.total.input_tokens)} /{" "}
              {formatTokens(usage.total.output_tokens)}
              <span className="text-fg-subtle"> · {formatCoverage(usage.coverage)}</span>
            </span>
          );
        },
      },
      {
        id: "started",
        accessorFn: (session) => session.started_at ?? "",
        header: "Started",
        size: 100,
        cell: ({ row }) => (
          <span className="text-fg-muted" title={row.original.started_at ?? undefined}>
            {relativeStarted(row.original.started_at)}
          </span>
        ),
      },
    ],
    [],
  );

  const clearFilters = (): void => {
    setSearch("");
    setQuery("");
    setSource(undefined);
    setHasErrors(false);
  };

  const filters = (
    <>
      <FilterChip
        label="Source"
        active={source !== undefined}
        display={source}
        onClear={() => setSource(undefined)}
      >
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-56 p-0">
          <FacetedFilter
            options={SOURCE_OPTIONS}
            value={source ?? ""}
            onValueChange={(value) => setSource(value === "" ? undefined : value)}
            searchPlaceholder="Source..."
          />
        </PopoverContent>
      </FilterChip>

      <FilterChip
        label="Errors"
        active={hasErrors}
        display={hasErrors ? "Has errors" : undefined}
        onClear={() => setHasErrors(false)}
      >
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-48 p-0">
          <FacetedFilter
            options={ERROR_OPTIONS}
            value={hasErrors ? "true" : ""}
            onValueChange={(value) => setHasErrors(value === "true")}
            searchPlaceholder="Errors..."
          />
        </PopoverContent>
      </FilterChip>
    </>
  );

  const emptyTitle = error !== null
    ? "Could not load sessions"
    : filtersActive
      ? "No matching sessions"
      : "No sessions yet";

  const emptySubtitle = error !== null
    ? error
    : filtersActive
      ? "Try a different search, or clear the source and error filters."
      : (
          <>
            Sessions come from the local coding-agent logs. Run{" "}
            <code>openmatel index</code> to scan them, then reload this page.
          </>
        );

  return (
    <DataTable<SessionSummary>
      title="Sessions"
      searchPlaceholder="Search sessions..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={items}
      loading={loading}
      getRowId={(session) => session.session_id}
      onRowClick={(session) =>
        navigate(`/sessions/${encodeURIComponent(session.session_id)}`)
      }
      hasMore={nextCursor !== null}
      loadingMore={loadingMore}
      onLoadMore={() => void loadMore()}
      emptyTitle={emptyTitle}
      emptySubtitle={emptySubtitle}
      emptyKind={error === null ? "session" : undefined}
      emptyAction={
        error !== null ? (
          <Button onClick={() => setReload((value) => value + 1)}>Retry</Button>
        ) : filtersActive ? (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : undefined
      }
      columns={columns}
    />
  );
}
