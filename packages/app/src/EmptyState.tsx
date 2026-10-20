/**
 * Empty state of the session list.
 *
 * It names the exact local files OpenMaTel reads, so a fresh install is not a
 * blank page: the user can see why nothing is here and what to do next.
 */

export function EmptyState() {
  return (
    <div className="app-empty-state">
      <h2>No sessions indexed yet</h2>
      <p>
        OpenMaTel reads session logs that local coding agents already write. Nothing is uploaded
        and no instrumentation is required.
      </p>
      <ul className="app-path-list">
        <li>
          <span className="app-agent">Claude Code</span>
          <code>~/.claude/projects/&lt;cwd&gt;/&lt;session&gt;.jsonl</code>
        </li>
        <li>
          <span className="app-agent">Codex</span>
          <code>~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl</code>
        </li>
        <li>
          <span className="app-agent">dsh</span>
          <code>~/.dsh/sessions/&lt;cwd&gt;/session-&lt;uuid&gt;/session.v4.jsonl.zstd</code>
        </li>
        <li>
          <span className="app-agent">pi</span>
          <code>~/.pi/agent/sessions/&lt;cwd&gt;/&lt;ts&gt;_&lt;uuid&gt;.jsonl</code>
        </li>
      </ul>
      <p>
        Run <code>openmatel</code> (or <code>openmatel index</code>) to scan these paths, then
        reload this page.
      </p>
    </div>
  );
}
