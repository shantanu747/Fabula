import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockProvider } from "./server";
import type { MockProvider } from "./types";
import { anthropicProvider } from "@/lib/providers/anthropic";
import { openaiProvider } from "@/lib/providers/openai";
import { openrouterProvider } from "@/lib/providers/openrouter";
import { MAX_OUTPUT_TOKENS } from "@/lib/providers/constants";
import type { GenerateParagraphInput, LLMProvider } from "@/lib/providers/types";
import type { InventedMetadata } from "@/lib/providers/types";

/**
 * Wire-shape spec for the mock server: drive the REAL adapters (and raw SDKs)
 * against it. If the SSE encoders drift from what the installed SDKs parse,
 * this file fails here — not as an unrelated mystery three plans later.
 *
 * The adapters memoize their SDK clients and read the base-URL env vars once
 * per process, so the mock URL is installed in beforeAll before the first
 * generation runs.
 */

let mock: MockProvider;

beforeAll(async () => {
  mock = await startMockProvider();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.OPENAI_BASE_URL = mock.url;
  process.env.OPENROUTER_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY ??= "mock-test-key";
  process.env.OPENAI_API_KEY ??= "mock-test-key";
  process.env.OPENROUTER_API_KEY ??= "mock-test-key";
});

afterAll(async () => {
  await mock.stop();
});

function inputWithTheme(text: string): GenerateParagraphInput {
  // A theme suppresses the zero-input metadata-header contract so chunk
  // boundaries pass through untouched.
  return {
    storySoFar: [{ author: "writer", text }],
    theme: "stormy seaside mystery",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
}

async function collect(provider: LLMProvider, input: GenerateParagraphInput) {
  const iterator = provider.generateParagraph(input);
  const chunks: string[] = [];
  let metadata: InventedMetadata | undefined;
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) {
      metadata = value.invented;
      break;
    }
    chunks.push(value);
  }
  return { chunks, metadata };
}

describe("mock provider server against the real adapters", () => {
  it("streams an anthropic chunk sequence through the real adapter verbatim", async () => {
    mock.setScript(() => ({
      kind: "stream",
      chunks: ["The rain had stopped by morning. ", "Mara lit the lamp anyway. ", "Habit, mostly."],
    }));

    const { chunks } = await collect(anthropicProvider, inputWithTheme("The sea kept its own ledger."));
    expect(chunks).toEqual(["The rain had stopped by morning. ", "Mara lit the lamp anyway. ", "Habit, mostly."]);
  });

  it("streams an openai chunk sequence through the real adapter verbatim", async () => {
    mock.setScript(() => ({
      kind: "stream",
      chunks: ["The Harrier came in at noon. ", "Everyone pretended not to look."],
    }));

    const { chunks } = await collect(openaiProvider, inputWithTheme("Two boats left the harbor."));
    expect(chunks).toEqual(["The Harrier came in at noon. ", "Everyone pretended not to look."]);
  });

  it("streams an openrouter chunk sequence through the real adapter verbatim", async () => {
    mock.setScript(() => ({
      kind: "stream",
      chunks: ["The yawl's crew sang off-key. ", "The mail sacks did not mind."],
    }));

    const { chunks } = await collect(openrouterProvider, inputWithTheme("Flour sacks lined the hold."));
    expect(chunks).toEqual(["The yawl's crew sang off-key. ", "The mail sacks did not mind."]);
  });

  it("supports the zero-input metadata header through the full adapter pipeline", async () => {
    mock.setScript(() => ({
      kind: "stream",
      chunks: [
        "THEME: salt and stubbornness\nCHARACTERS: Tavi, a first-run deckhand\n---\n",
        "The Greywing left at first light. ",
        "Nobody waved, but the cat watched.",
      ],
    }));

    const zeroInput: GenerateParagraphInput = { storySoFar: [], maxOutputTokens: MAX_OUTPUT_TOKENS };
    const { chunks, metadata } = await collect(anthropicProvider, zeroInput);

    expect(metadata).toEqual({ theme: "salt and stubbornness", characters: "Tavi, a first-run deckhand" });
    expect(chunks.join("")).toBe("The Greywing left at first light. Nobody waved, but the cat watched.");
  });

  it("surfaces the error kind to the adapters as a provider failure", async () => {
    mock.setScript(() => ({ kind: "error", status: 500, body: { error: { message: "mock blew up" } } }));

    await expect(collect(anthropicProvider, inputWithTheme("x"))).rejects.toThrow();
    await expect(collect(openaiProvider, inputWithTheme("x"))).rejects.toThrow();
  });

  it("surfaces the truncate kind as a mid-stream failure, not a shortened success", async () => {
    mock.setScript(() => ({ kind: "truncate", chunks: ["Partial text that dies ", "mid-thought…"] }));

    await expect(collect(openaiProvider, inputWithTheme("x"))).rejects.toThrow();
    await expect(collect(anthropicProvider, inputWithTheme("x"))).rejects.toThrow();
  });

  it("hang never answers until the client gives up", async () => {
    mock.setScript(() => ({ kind: "hang" }));

    const client = new OpenAI({ apiKey: "mock-test-key", baseURL: mock.url, timeout: 1500, maxRetries: 0 });
    await expect(
      client.chat.completions.create({
        model: "gpt-5-mini",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      })
    ).rejects.toThrow();
  }, 10_000);
});

describe("mock server sanity", () => {
  it("responds 404 to unknown routes", async () => {
    const response = await fetch(`${mock.url}/nope`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("leaves the remote-control routes 404 when remoteControl is off", async () => {
    const response = await fetch(`${mock.url}/__mock/calls`);
    expect(response.status).toBe(404);
  });

  it("fails loudly when no script is installed", async () => {
    // Fresh server with no setScript: every vendor route must error, not hang.
    const bare = await startMockProvider();
    try {
      const client = new Anthropic({ apiKey: "mock-test-key", baseURL: bare.url, maxRetries: 0 });
      await expect(
        client.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 8,
          messages: [{ role: "user", content: "x" }],
        })
      ).rejects.toThrow();
    } finally {
      await bare.stop();
    }
  });
});

describe("remote-control plane (used by the E2E harness, not setScript)", () => {
  let remote: MockProvider;

  beforeAll(async () => {
    remote = await startMockProvider({ remoteControl: true });
  });

  afterAll(async () => {
    await remote.stop();
  });

  it("serves queued responses over HTTP and repeats the last one", async () => {
    await fetch(`${remote.url}/__mock/reset`, { method: "POST" });
    await fetch(`${remote.url}/__mock/queue`, {
      method: "POST",
      body: JSON.stringify({
        responses: [
          { kind: "stream", chunks: ["first "] },
          { kind: "stream", chunks: ["second "] },
        ],
      }),
    });

    // A fresh SDK client pointed at `remote`, not the app's memoized adapters
    // (which are pinned to the outer `mock` server for this file's process).
    const client = new Anthropic({ apiKey: "mock-test-key", baseURL: remote.url, maxRetries: 0 });
    async function call(): Promise<string> {
      const stream = client.messages.stream({
        model: "claude-sonnet-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "x" }],
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      return text;
    }

    expect(await call()).toBe("first ");
    expect(await call()).toBe("second ");
    // Queue is down to its last entry — it repeats rather than erroring.
    expect(await call()).toBe("second ");

    const callsResponse = await fetch(`${remote.url}/__mock/calls`);
    expect((await callsResponse.json()).count).toBe(3);
  });

  it("resets the call counter and queue", async () => {
    await fetch(`${remote.url}/__mock/reset`, { method: "POST" });
    const callsResponse = await fetch(`${remote.url}/__mock/calls`);
    expect((await callsResponse.json()).count).toBe(0);
  });
});
