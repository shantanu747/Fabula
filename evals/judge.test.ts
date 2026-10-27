import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseById } from "./cases";
import { buildJudgeOutputSchema, judgeParagraph } from "./judge";

/**
 * The judge's request shape and stop-reason handling, against a local stub
 * standing in for the Messages API (the judge is non-streaming, so the shared
 * mock provider's SSE responses don't fit). See ADR 0050.
 */

let server: Server;
let baseURL: string;
let lastBody: Record<string, unknown> | undefined;
let reply: { stop_reason: string; text: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: reply.text }],
          stop_reason: reply.stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("buildJudgeOutputSchema", () => {
  it("requires exactly the case's dimensions, bounded 1–5", () => {
    const schema = buildJudgeOutputSchema(["safety", "continuity"], false) as {
      properties: Record<string, { properties: Record<string, unknown>; required: string[] }>;
      required: string[];
    };
    expect(schema.required).toEqual(["scores", "justifications"]);
    expect(schema.properties.scores.required).toEqual(["safety", "continuity"]);
    expect(schema.properties.scores.properties.safety).toEqual({ type: "integer", enum: [1, 2, 3, 4, 5] });
    expect(schema.properties.justifications.properties.continuity).toEqual({ type: "string" });
  });

  it("adds a required injection_resisted boolean only for adversarial cases", () => {
    const schema = buildJudgeOutputSchema(["safety"], true) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toContain("injection_resisted");
    expect(schema.properties.injection_resisted).toEqual({ type: "boolean" });
  });
});

describe("judgeParagraph", () => {
  const caseDef = caseById("safety-dark-turn");

  it("sends a json_schema output_config built from the case's dimensions", async () => {
    const scores = Object.fromEntries(caseDef.dimensions.map((d) => [d, 4]));
    const justifications = Object.fromEntries(caseDef.dimensions.map((d) => [d, "ok"]));
    reply = { stop_reason: "end_turn", text: JSON.stringify({ scores, justifications }) };

    const verdict = await judgeParagraph(caseDef, "A paragraph.", { apiKey: "test", baseURL });

    expect(verdict.scores).toEqual(scores);
    expect(lastBody?.output_config).toEqual({
      format: { type: "json_schema", schema: buildJudgeOutputSchema(caseDef.dimensions, caseDef.adversarial) },
    });
  });

  it("names a max_tokens stop instead of surfacing it as a JSON parse error", async () => {
    reply = { stop_reason: "max_tokens", text: '{"scores": {"safety": 4' };
    await expect(judgeParagraph(caseDef, "A paragraph.", { apiKey: "test", baseURL })).rejects.toThrow(
      /stop_reason "max_tokens"/
    );
  });
});
