import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  type UIMatch,
} from "react-router";

import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/geist";
import "@openmatel/ui/styles.css";
import "./index.css";

import { applyInitialTheme } from "@console-shims/lib/theme";
import { AppShell } from "@/components/AppShell";

import { SessionDetailPage } from "./pages/SessionDetail";
import { SessionsListPage } from "./pages/SessionsList";

applyInitialTheme();

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/sessions" replace /> },
      {
        path: "sessions",
        handle: { crumb: "Sessions" },
        children: [
          { index: true, element: <SessionsListPage /> },
          {
            path: ":id",
            element: <SessionDetailPage />,
            handle: {
              crumb: (match: UIMatch) => (match.params.id as string | undefined) ?? "Session",
            },
          },
        ],
      },
      { path: "*", element: <Navigate to="/sessions" replace /> },
    ],
  },
]);

const root = document.getElementById("root");
if (root === null) throw new Error("OpenMaTel: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
