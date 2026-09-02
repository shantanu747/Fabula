import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildMessages, buildSystemPrompt, generateWithProvider, windowStoryParagraphs } from "./prompt";
import { CONTEXT_WINDOW_CHAR_BUDGET, MAX_OUTPUT_TOKENS } from "./constants";
import type { GenerateParagraphInput, StoryParagraph } from "./types";

const OMISSION_NOTE = "[...earlier paragraphs continue here, omitted for length...]";

function para(author: "writer" | "ai", text: string): StoryParagraph {
  return { author, text };
}

/** Alternating writer/ai paragraphs of a given size, as the turn policy guarantees. */
function story(count: number, charsEach: number): StoryParagraph[] {
  return Array.from({ length: count }, (_, i) =>
    para(i % 2 === 0 ? "writer" : "ai", `${i}`.padEnd(charsEach, "x"))
  );
}

function inputFor(overrides: Partial<GenerateParagraphInput> = {}): GenerateParagraphInput {
  return { storySoFar: [], maxOutputTokens: MAX_OUTPUT_TOKENS, ...overrides };
}

describe("buildSystemPrompt", () => {
  it("states the one-paragraph rule and the age-appropriate default", () => {
    // Content safety is a prompting concern by decision (docs/adr/0006), which
    // makes the instruction's presence the only thing holding it up.
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("ONE paragraph");
    expect(prompt).toContain("age-appropriate");
  });
});

describe("windowStoryParagraphs", () => {
  it("returns an empty history untouched", () => {
    expect(windowStoryParagraphs([])).toEqual([]);
  });

  it("returns the same array when the story fits the budget", () => {
    const paragraphs = [para("writer", "short"), para("ai", "text")];

    // Identity, not equality: under budget there is nothing to copy.
    expect(windowStoryParagraphs(paragraphs)).toBe(paragraphs);
  });

  it("keeps the opening paragraph and drops from the middle when over budget", () => {
    const paragraphs = story(30, 1000); // 30k chars against a 12k budget

    const result = windowStoryParagraphs(paragraphs);

    expect(result[0].text).toContain(paragraphs[0].text);
    expect(result[0].text).toContain(OMISSION_NOTE);
    // What survives besides the anchor is the tail, contiguous and in order.
    expect(result.slice(1)).toEqual(paragraphs.slice(paragraphs.length - (result.length - 1)));
  });

  it("does not annotate the anchor when nothing was dropped", () => {
    const result = windowStoryParagraphs(story(3, 100));

    expect(result[0].text).not.toContain(OMISSION_NOTE);
  });

  it("keeps the anchor even when it alone exceeds the whole budget", () => {
    // Losing the premise would be worse than overshooting the budget, so the
    // anchor is not negotiable.
    const huge = para("writer", "a".repeat(CONTEXT_WINDOW_CHAR_BUDGET + 500));
    const result = windowStoryParagraphs([huge, para("ai", "recent")]);

    expect(result).toHaveLength(1);
    expect(result[0].text).toContain(huge.text);
    expect(result[0].text).toContain(OMISSION_NOTE);
  });

  /**
   * The invariants that must hold for any story, rather than for the three
   * shapes someone thought to write down. The anchor-plus-recency scheme
   * (docs/adr/0005) is only correct if all four hold together: drop the anchor
   * and the model loses the premise; drop ordering and the story scrambles;
   * ignore the budget and the provider call fails.
   */
  it("preserves the anchor, order, and budget for any story", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            author: fc.constantFrom<"writer" | "ai">("writer", "ai"),
            text: fc.string({ minLength: 1, maxLength: 3000 }),
          }),
          { minLength: 1, maxLength: 40 }
        ),
        (paragraphs) => {
          const result = windowStoryParagraphs(paragraphs);

          expect(result.length).toBeGreaterThanOrEqual(1);
          expect(result.length).toBeLessThanOrEqual(paragraphs.length);

          // The anchor is always first and always the real opening paragraph.
          expect(result[0].text.startsWith(paragraphs[0].text)).toBe(true);
          expect(result[0].author).toBe(paragraphs[0].author);

          // Everything after the anchor is an unbroken, in-order tail.
          const tail = result.slice(1);
          expect(tail).toEqual(paragraphs.slice(paragraphs.length - tail.length));

          // Budget holds, except for the deliberate anchor overshoot above.
          const total = result.reduce((sum, p) => sum + p.text.length, 0);
          const anchorFloor = paragraphs[0].text.length + OMISSION_NOTE.length + 4;
          expect(total).toBeLessThanOrEqual(Math.max(CONTEXT_WINDOW_CHAR_BUDGET, anchorFloor));

          // The note appears exactly when something was actually dropped.
          expect(result[0].text.includes(OMISSION_NOTE)).toBe(result.length < paragraphs.length);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("buildMessages — the turn-0 kickoff", () => {
  it("asks for the THEME/CHARACTERS header only when nothing was supplied", () => {
    const messages = buildMessages(inputFor(), 0);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("THEME:");
    expect(messages[0].content).toContain("CHARACTERS:");
    expect(messages[0].content).toContain("---");
  });

  it("passes the Writer's hints through and asks for no header", () => {
    const messages = buildMessages(
      inputFor({ theme: "noir", characters: "a tired detective", openingLines: "It rained." }),
      0
    );

    expect(messages[0].content).toContain("noir");
    expect(messages[0].content).toContain("a tired detective");
    expect(messages[0].content).toContain("It rained.");
    expect(messages[0].content).not.toContain("THEME:");
  });

  it.each([
    ["theme", { theme: "noir" }],
    ["characters", { characters: "a detective" }],
    ["openingLines", { openingLines: "It rained." }],
  ])("treats %s alone as enough to skip the header", (_label, hint) => {
    expect(buildMessages(inputFor(hint), 0)[0].content).not.toContain("THEME:");
  });
});

describe("buildMessages — continuation turns", () => {
  const ongoing = [para("writer", "The Writer's opening."), para("ai", "The AI's reply.")];

  it("maps writer paragraphs to user turns and AI paragraphs to assistant turns", () => {
    const messages = buildMessages(inputFor({ storySoFar: ongoing }), ongoing.length);

    expect(messages.slice(0, 2)).toEqual([
      { role: "user", content: "The Writer's opening." },
      { role: "assistant", content: "The AI's reply." },
    ]);
    expect(messages[messages.length - 1].role).toBe("user");
  });

  it("repeats theme and characters on later turns, not just at kickoff", () => {
    // These used to be dropped once storySoFar was non-empty, so the model lost
    // the Writer's stated premise after turn 0.
    const messages = buildMessages(
      inputFor({ storySoFar: ongoing, theme: "noir", characters: "a detective" }),
      ongoing.length
    );

    const last = messages[messages.length - 1].content;
    expect(last).toContain("noir");
    expect(last).toContain("a detective");
  });

  it("omits the context reminder when there is nothing to remind the model of", () => {
    const messages = buildMessages(inputFor({ storySoFar: ongoing }), ongoing.length);

    expect(messages[messages.length - 1].content).not.toContain("Keep in mind");
  });

  it.each([
    [0, 10, undefined],
    [5, 10, undefined],
    [6, 10, "raising the stakes"],
    [8, 10, "raising the stakes"],
    [9, 10, "climax"],
    [10, 10, "resolving"],
    [14, 10, "resolving"],
  ])("steers the story at %i of %i paragraphs", (count, target, expected) => {
    const messages = buildMessages(
      inputFor({ storySoFar: story(Math.max(count, 1), 10), targetLength: target }),
      count
    );
    const last = messages[messages.length - 1].content;

    if (expected === undefined) {
      expect(last).not.toMatch(/raising the stakes|climax|resolving/);
    } else {
      expect(last).toContain(expected);
    }
  });

  it.each([undefined, 0])("adds no length steering when the target is %s", (targetLength) => {
    const messages = buildMessages(inputFor({ storySoFar: ongoing, targetLength }), 2);

    expect(messages[messages.length - 1].content).not.toMatch(/target length/);
  });

  it("steers on the true paragraph count, not the windowed one", () => {
    // Windowing can drop most of a long story from the prompt. If steering used
    // the windowed count, a story past its target would read as barely started
    // and the AI would keep opening new threads instead of closing them.
    const long = story(40, 1000);

    const messages = buildMessages(inputFor({ storySoFar: long, targetLength: 12 }), long.length);

    expect(messages[messages.length - 1].content).toContain("resolving");
  });
});

describe("generateWithProvider", () => {
  async function collect(input: GenerateParagraphInput, raw: string[]) {
    const generator = generateWithProvider(input, async function* () {
      for (const chunk of raw) yield chunk;
      return { model: "fake-model", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    let prose = "";
    for (;;) {
      const step = await generator.next();
      if (step.done) return { prose, metadata: step.value.invented };
      prose += step.value;
    }
  }

  it("expects the invented-metadata header only on a zero-input kickoff", async () => {
    const { prose, metadata } = await collect(inputFor(), [
      "THEME: noir\nCHARACTERS: a detective\n---\nIt rained.",
    ]);

    expect(metadata).toEqual({ theme: "noir", characters: "a detective" });
    expect(prose).toBe("It rained.");
  });

  it("passes text through untouched once the Writer supplied any hint", async () => {
    // With a Writer-supplied theme there is no header to strip, so text that
    // merely looks like one must survive verbatim.
    const { prose, metadata } = await collect(inputFor({ theme: "noir" }), [
      "THEME: not a header\n---\nstill prose",
    ]);

    expect(metadata).toBeUndefined();
    expect(prose).toBe("THEME: not a header\n---\nstill prose");
  });

  it("windows the history it sends without changing what it reports upstream", async () => {
    const long = story(40, 1000);
    let received: GenerateParagraphInput | undefined;
    let receivedCount = 0;

    const generator = generateWithProvider(
      inputFor({ storySoFar: long, targetLength: 12 }),
      async function* (windowed, trueCount) {
        received = windowed;
        receivedCount = trueCount;
        yield "text";
        return { model: "fake-model" };
      }
    );
    await generator.next();
    await generator.next();

    expect(received!.storySoFar.length).toBeLessThan(long.length);
    expect(receivedCount).toBe(long.length);
  });
});

describe("windowStoryParagraphs — the single-paragraph edge", () => {
  it("adds no omission note when there was nothing after the anchor to omit", () => {
    // A lone opening paragraph over budget: the anchor is kept whole and the
    // note would be a lie, since no later paragraph was dropped.
    const only = [para("writer", "a".repeat(CONTEXT_WINDOW_CHAR_BUDGET + 100))];

    const result = windowStoryParagraphs(only);

    expect(result).toHaveLength(1);
    expect(result[0].text).not.toContain(OMISSION_NOTE);
  });
});
