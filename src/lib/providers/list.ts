import { PROVIDERS } from "./registry";

export interface ProviderSummary {
  id: string;
  displayName: string;
}

/**
 * Server-only. Reads the registry directly, so the id/displayName the UI ever
 * sees can never drift from what /api/generate actually accepts — call this
 * only from Server Components (e.g. layout.tsx), never from "use client" code,
 * since registry.ts transitively imports the provider SDKs.
 */
export function getProviderList(): ProviderSummary[] {
  return Object.values(PROVIDERS).map(({ id, displayName }) => ({ id, displayName }));
}
