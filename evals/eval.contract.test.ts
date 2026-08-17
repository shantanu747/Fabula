import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { CONTEXT_WINDOW_CHAR_BUDGET } from "@/lib/providers/constants";
import { buildMessages, buildSystemPrompt, windowStoryParagraphs } from "@/lib/providers/prompt";
import { CASES, caseById } from "./cases";

/**
 * Layer 1 — prompt contract (docs/plans/v3/01): free and deterministic.
 *
 * Two halves. The file snapshots pin the exact request the app builds per
 * golden case, so any prompt.ts change surfaces as a reviewable diff
 * (`vitest run -u --config vitest.eval.config.mts` to accept). The property
 * assertions then pin what must hold no matter how the wording evolves:
 * safety clause, length-steering bands, windowing note behavior, the
 * zero-input metadata-header instruction, and the ongoing theme/characters
 * reminder.
 */

const OMISSION_NOTE = "[...earlier paragraphs continue here, omitted for length...]";
const HEADER_INSTRUCTION = "Prefix your response with exactly this format";
const SAFETY_CLAUSE = "age-appropriate";

function snapshotPath(caseId: string): string {
  return fileURLToPath(new URL(`./prompt-snapshots/${caseId}.json`, import.meta.url));
}

describe("layer 1: prompt contract", () => {
  for (const evalCase of CASES) {
    it(`snapshots the request payload for ${evalCase.id}`, () => {
      const trueCount = evalCase.input.storySoFar.length;
      const windowed = {
        ...evalCase.input,
        storySoFar: windowStoryParagraphs(evalCase.input.storySoFar),
      };
      expect({
        systemPrompt: buildSystemPrompt(),
        messages: buildMessages(windowed, trueCount),
      }).toMatchFileSnapshot(snapshotPath(evalCase.id));
    });

    it(`includes the safety clause in the system prompt for ${evalCase.id}`, () => {
      // The clause (ADR 0006) is per-prompt, and a regression test belongs
      // next to the case that would suffer, not in one umbrella assertion.
      expect(buildSystemPrompt()).toContain(SAFETY_CLAUSE);
    });

    it(`expectMetadataHeader agrees with the app's own predicate for ${evalCase.id}`, () => {
      const derived =
        evalCase.input.storySoFar.length === 0 &&
        !evalCase.input.theme &&
        !evalCase.input.characters &&
        !evalCase.input.openingLines;
      expect(evalCase.expectMetadataHeader).toBe(derived);
    });
  }

  describe("length-steering bands", () => {
    function lastUserMessage(caseId: string): string {
      const evalCase = caseById(caseId);
      const messages = buildMessages(evalCase.input, evalCase.input.storySoFar.length);
      return messages[messages.length - 1].content;
    }

    it("emits no steering note below the 0.6 band (midstory-continuation)", () => {
      expect(lastUserMessage("midstory-continuation")).not.toContain("target length");
    });

    it("emits the rising-action note at ratio ~0.65 (arc-rising)", () => {
      expect(lastUserMessage("arc-rising")).toContain("Start raising the stakes");
    });

    it("emits the climax note at ratio ~0.9 (arc-climax)", () => {
      expect(lastUserMessage("arc-climax")).toContain("bring the story to its climax");
    });

    it("emits the resolution note at ratio ~1.1 (arc-resolution)", () => {
      expect(lastUserMessage("arc-resolution")).toContain("resolving the plot");
    });
  });

  describe("windowing", () => {
    it("required premise: the long-story case actually exceeds the char budget", () => {
      const evalCase = caseById("windowed-long-story");
      const total = evalCase.input.storySoFar.reduce((sum, p) => sum + p.text.length, 0);
      expect(total).toBeGreaterThan(CONTEXT_WINDOW_CHAR_BUDGET);
    });

    it("shows the omission note exactly when paragraphs were dropped, and keeps the anchor", () => {
      const evalCase = caseById("windowed-long-story");
      const windowed = windowStoryParagraphs(evalCase.input.storySoFar);
      expect(windowed.length).toBeLessThan(evalCase.input.storySoFar.length);
      expect(windowed[0].text).toContain(OMISSION_NOTE);
      expect(windowed[0].text.startsWith(evalCase.input.storySoFar[0].text.slice(0, 60))).toBe(true);
    });

    it("keeps the omission note out of every case that fits the budget", () => {
      for (const evalCase of CASES.filter((c) => c.id !== "windowed-long-story")) {
        const windowed = windowStoryParagraphs(evalCase.input.storySoFar);
        for (const p of windowed) {
          expect(p.text).not.toContain(OMISSION_NOTE);
        }
      }
    });
  });

  describe("zero-input metadata header instruction", () => {
    it("requests THEME:/CHARACTERS:/--- only on the true zero-input kickoff", () => {
      for (const evalCase of CASES) {
        const trueCount = evalCase.input.storySoFar.length;
        const windowed = {
          ...evalCase.input,
          storySoFar: windowStoryParagraphs(evalCase.input.storySoFar),
        };
        const allContent = buildMessages(windowed, trueCount)
          .map((m) => m.content)
          .join("\n");
        if (evalCase.id === "kickoff-zero-input") {
          expect(allContent).toContain(HEADER_INSTRUCTION);
          expect(allContent).toContain("THEME:");
          expect(allContent).toContain("CHARACTERS:");
          expect(allContent).toContain("---");
        } else {
          expect(allContent).not.toContain(HEADER_INSTRUCTION);
        }
      }
    });
  });

  describe("ongoing theme/characters reminder", () => {
    it("carries theme and characters into a later turn's final message, not just turn 0", () => {
      const evalCase = caseById("safety-kid-premise");
      const messages = buildMessages(evalCase.input, evalCase.input.storySoFar.length);
      const finalMessage = messages[messages.length - 1].content;
      expect(finalMessage).toContain("Keep in mind —");
      expect(finalMessage).toContain(evalCase.input.theme as string);
      expect(finalMessage).toContain(evalCase.input.characters as string);
    });
  });
});
