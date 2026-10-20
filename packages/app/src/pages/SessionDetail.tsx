import { useNavigate, useParams } from "react-router";

import { ObsProvider, SessionDetail } from "@openmatel/ui";

import { Page } from "@/components/Page";
import { useTheme } from "@console-shims/lib/theme";

import { client } from "../client";

/**
 * Part B replaces this route with the console's session detail surface. For
 * now the existing OpenMaTel detail component is rendered inside the console's
 * Page shell, with the ObsClient/provider boundary kept intact.
 */
export function SessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { effective } = useTheme();

  if (id === undefined || id === "") {
    return <Page>Session not found.</Page>;
  }

  return (
    <Page>
      <ObsProvider
        client={client}
        navigate={navigate}
        theme={effective}
        className="omt-console-detail"
      >
        <SessionDetail
          key={id}
          sessionId={id}
          onBack={() => navigate("/sessions")}
          onOpenSession={(sessionId) =>
            navigate(`/sessions/${encodeURIComponent(sessionId)}`)
          }
        />
      </ObsProvider>
    </Page>
  );
}
