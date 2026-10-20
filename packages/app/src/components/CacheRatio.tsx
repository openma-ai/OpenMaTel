import { Badge } from "@/components/Badge";

import { formatPercent } from "../lib/session-format";

/**
 * Cache hit ratio indicator (`cache_read / context_tokens`, design §15.7).
 *
 * This is an OpenMaTel-owned indicator: the vendored console has no notion of
 * a cache ratio. It uses the vendored `Badge` so it sits visually next to the
 * session-header chips. Unknown stays an em dash, never `0%`.
 */
export function CacheRatio({
  ratio,
  className,
}: {
  ratio: number | null;
  className?: string;
}) {
  const label = `cache ${formatPercent(ratio)}`;
  const title =
    ratio === null
      ? "Cache hit ratio is unknown: no model call reported both cache_read_tokens and context_tokens"
      : "Cache hit ratio = cache_read_tokens / context_tokens over calls where both are known";

  return (
    <span className={className} title={title}>
      <Badge
        icon={
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              ratio === null ? "bg-fg-subtle" : "bg-success"
            }`}
          />
        }
        label={label}
        title={title}
      />
    </span>
  );
}
