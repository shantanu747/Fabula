import { createHash } from "node:crypto";
import type { ChatMessage } from "@/lib/providers/prompt";

/**
 * Fingerprinting for the eval harness. Two jobs:
 *
 * 1. Request fingerprints (Layer 2 staleness): a stable hash of the exact
 *    request payload the app builds for a case, so a prompt change that
 *    alters the payload fails loudly against the recorded fixture instead of
 *    coasting on it.
 * 2. Judgement cache keys: `sha256(generatedText + caseId + rubricVersion)`,
 *    so a rubric bump or a re-recorded output invalidates every cached
 *    judgement by construction.
 *
 * Canonical JSON is the heart of both: key order must not matter, so keys are
 * sorted recursively before serializing (JSON.stringify's default separators
 * then give a stable byte stream).
 */

export interface EvalRequestPayload {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: ChatMessage[];
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortKeysDeep(item)] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function fingerprintPayload(payload: EvalRequestPayload): string {
  return sha256(canonicalJson(payload));
}

/** Keep the operand order exactly as spec'd; it's part of the committed data. */
export function judgementCacheKey(
  generatedText: string,
  caseId: string,
  rubricVersion: string
): string {
  return sha256(generatedText + caseId + rubricVersion);
}
