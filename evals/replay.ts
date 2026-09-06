import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { MockProvider, Vendor } from "../test-support/mock-provider/types";
import type { InventedMetadata } from "@/lib/providers/types";
import { getProvider } from "@/lib/providers/registry";
import { buildEvalPayload, type EvalCase, type ProviderId } from "./cases";
import { fingerprintPayload } from "./fingerprint";

/**
 * Fixture loading, raw-SSE decoding, and the replay that runs a recorded
 * response back through the real adapter (docs/plans/v3/01 Layer 2).
 *
 * Replay never mocks the adapter: the mock server re-spews the recorded SSE
 * and the production SDK parses it, so stream parsing and
 * extractInventedMetadata stay in the exercised path (ADR 0003 shows why).
 */

export interface Fixture {
  caseId: string;
  providerId: ProviderId;
  model: string;
  requestFingerprint: string;
  recordedAt: string;
  rawSse: string;
}

export function fixturePath(providerId: ProviderId, caseId: string): string {
  return fileURLToPath(new URL(`./fixtures/${providerId}/${caseId}.json`, import.meta.url));
}

export async function loadFixture(providerId: ProviderId, caseId: string): Promise<Fixture> {
  const raw = await readFile(fixturePath(providerId, caseId), "utf8");
  return JSON.parse(raw) as Fixture;
}

export function vendorForProvider(providerId: ProviderId): Vendor {
  return providerId === "anthropic" ? "anthropic" : "openai";
}

/**
 * Staleness is a hard failure (docs/plans/v3/01): recompute the fingerprint of
 * the payload the code would build today and compare it to the one the fixture
 * was recorded against. A mismatch means a prompt change coasting on old
 * fixtures — the fix is `npm run eval:record`, not an override.
 */
export function checkFixtureStaleness(
  fixture: Fixture,
  caseDef: EvalCase
): { currentFingerprint: string; stale: boolean } {
  const currentFingerprint = fingerprintPayload(buildEvalPayload(fixture.providerId, caseDef.input));
  return { currentFingerprint, stale: currentFingerprint !== fixture.requestFingerprint };
}

export interface DecodedSse {
  chunks: string[];
  model: string;
}

/**
 * Straightforward block-based SSE decode: split on blank lines, read the
 * data payload of each block. Anthropic events carry the text in
 * content_block_delta deltas; OpenAI chunks in choices[0].delta.content.
 * `[DONE]` terminates the OpenAI series. This is the mirror of the mock
 * server's encoders and is kept deliberately simple and strict: a fixture
 * that doesn't decode cleanly is a recording bug, not something to skip.
 */
export function decodeRawSse(vendor: Vendor, rawSse: string): DecodedSse {
  const chunks: string[] = [];
  let model = "";
  const blocks = rawSse.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (block.trim() === "") continue;
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (data.trimStart().startsWith("[DONE]")) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`decodeRawSse: unparseable data line: ${data.slice(0, 80)}…`);
    }
    const obj = parsed as Record<string, unknown>;
    if (vendor === "anthropic") {
      if (obj.type === "message_start") {
        const message = obj.message as { model?: unknown } | undefined;
        if (message && typeof message.model === "string") model = message.model;
      }
      if (obj.type === "content_block_delta") {
        const delta = obj.delta as { type?: unknown; text?: unknown } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          chunks.push(delta.text);
        }
      }
    } else {
      if (typeof obj.model === "string" && model === "") model = obj.model;
      const choices = obj.choices as { delta?: { content?: unknown } }[] | undefined;
      const content = choices?.[0]?.delta?.content;
      if (typeof content === "string" && content !== "") chunks.push(content);
    }
  }
  if (model === "") throw new Error("decodeRawSse: no model found in stream");
  return { chunks, model };
}

export interface ReplayResult {
  /** Prose exactly as the app would display it (metadata header stripped). */
  prose: string;
  metadata: InventedMetadata | undefined;
}

/**
 * Install the fixture on the mock server and drive the real adapter through
 * it manually (.next() loop, like src/app/api/generate/route.ts) so we can
 * read the generator's returned InventedMetadata for the zero-input case.
 */
export async function replayFixture(
  fixture: Fixture,
  caseDef: EvalCase,
  mock: MockProvider
): Promise<ReplayResult> {
  const { chunks } = decodeRawSse(vendorForProvider(fixture.providerId), fixture.rawSse);
  mock.setScript(() => ({ kind: "stream", chunks }));

  const provider = getProvider(fixture.providerId);
  if (!provider) throw new Error(`unknown provider: ${fixture.providerId}`);

  const iterator = provider.generateParagraph(caseDef.input);
  let prose = "";
  let metadata: InventedMetadata | undefined;
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) {
      metadata = value.invented;
      break;
    }
    prose += value;
  }
  return { prose, metadata };
}
