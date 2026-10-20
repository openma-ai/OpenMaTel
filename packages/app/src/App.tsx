import { createObsClient, ObsProvider, SessionDetail, SessionList } from "@openmatel/ui";

import { EmptyState } from "./EmptyState.js";
import { useHistoryRoute } from "./router.js";
import { VERSION } from "./version.js";

const client = createObsClient();

function matchSession(path: string): string | null {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(path);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return match[1] ?? null;
  }
}

/** The standalone OpenMaTel shell: top bar plus the two routes. */
export function App() {
  const { path, navigate } = useHistoryRoute();
  const sessionId = matchSession(path);
  const isList = path === "/" || path === "";

  return (
    <ObsProvider client={client} navigate={navigate}>
      <div className="app-shell">
        <header className="app-topbar">
          <div className="app-topbar-inner">
            <a
              className="app-brand"
              href="/"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate("/");
              }}
            >
              <span className="app-mark" aria-hidden="true">
                ◉
              </span>
              <span className="app-product">OpenMaTel</span>
            </a>
            <nav className="app-nav" aria-label="Primary">
              <a
                className={isList ? "app-nav-link app-nav-link-active" : "app-nav-link"}
                href="/"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  navigate("/");
                }}
              >
                Sessions
              </a>
            </nav>
            <div className="app-topbar-right">
              <span className="app-local-badge" title="Data stays on this machine">
                <span className="app-local-dot" aria-hidden="true" />
                local
              </span>
              <span className="app-version">v{VERSION}</span>
            </div>
          </div>
        </header>

        <main className="app-main">
          {sessionId !== null ? (
            <SessionDetail
              key={sessionId}
              sessionId={sessionId}
              onBack={() => navigate("/")}
              onOpenSession={(id) => navigate(`/sessions/${encodeURIComponent(id)}`)}
            />
          ) : isList ? (
            <SessionList
              emptyState={<EmptyState />}
              onSelectSession={(id) => navigate(`/sessions/${encodeURIComponent(id)}`)}
            />
          ) : (
            <div className="omt-empty app-not-found">
              <h2>Page not found</h2>
              <p>This address is not part of the OpenMaTel session browser.</p>
              <button type="button" className="omt-button" onClick={() => navigate("/")}>
                Back to sessions
              </button>
            </div>
          )}
        </main>
      </div>
    </ObsProvider>
  );
}
