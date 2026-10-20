import { createObsClient } from "@openmatel/ui";

/**
 * One Query API client for the whole SPA.
 *
 * The CLI serves the built assets at the same origin as `/v1`, so the default
 * (empty) base URL is exactly what the desktop console needs.
 */
export const client = createObsClient();
