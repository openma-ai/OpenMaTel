/**
 * Local-only auth shim.
 *
 * The vendored AppShell talks to the OpenMA account runtime through this
 * module. OpenMaTel has no accounts: the CLI serves a single-user, loopback
 * console, so the shell is always authenticated as the local workspace.
 */

import type { ReactNode } from "react";

export interface LocalUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

const LOCAL_USER: LocalUser = {
  id: "local",
  name: "Local workspace",
  email: "",
  image: null,
};

export interface AuthState {
  user: LocalUser;
  isLoading: false;
  isAuthenticated: true;
}

export function useAuth(): AuthState {
  return { user: LOCAL_USER, isLoading: false, isAuthenticated: true };
}

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  return children;
}
