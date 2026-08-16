import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { extractInventedMetadata } from "./prompt";
import type { InventedMetadata } from "./types";

async function* fromChunks(chunks: readonly string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

/**
 * Drives the generator by hand rather than with for-await-of, because the value
 * under test is partly the generator's *return* value, which for-await-of
 * discards. This mirrors how the API route consumes it.
 */
async function drain(
  stream: AsyncIterable<string>,
  expectHeader: boolean
): Promise<{ prose: string; metadata: InventedMetadata | undefined }> {
  const generator = extractInventedMetadata(stream, expectHeader);
  let prose = "";
  for (;;) {
    const step = await generator.next();
    if (step.done) return { prose, metadata: step.value };
    prose += step.value;
  }
}

/** Splits a string at arbitrary offsets, mimicking provider chunk boundaries. */
function splitAt(text: string, offsets: readonly number[]): string[] {
  const cuts = [...new Set(offsets.filter((o) => o > 0 && o < text.length))].sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = 0;
  for (const cut of cuts) {
    parts.push(text.slice(prev, cut));
    prev = cut;
  }
  parts.push(text.slice(prev));
  return parts;
}

describe("extractInventedMetadata", () => {
  it("is a pure passthrough when no header is expected", async () => {
    const { prose, metadata } = await drain(fromChunks(["Just ", "prose ", "text"]), false);

    expect(prose).toBe("Just prose text");
    expect(metadata).toBeUndefined();
  });

  it("splits the header from the prose and returns the parsed metadata", async () => {
    const { prose, metadata } = await drain(
      fromChunks(["THEME: fantasy\nCHARACTERS: hero, villain\n---\nOnce upon a time..."]),
      true
    );

    expect(metadata).toEqual({ theme: "fantasy", characters: "hero, villain" });
    expect(prose).toBe("Once upon a time...");
  });

  it("falls back to treating everything as prose when the model ignores the format", async () => {
    // A refusal or an instruction miss. Dropping the text entirely would show
    // the Writer an empty paragraph and no explanation.
    const { prose, metadata } = await drain(fromChunks(["I can't help with that."]), true);

    expect(prose).toBe("I can't help with that.");
    expect(metadata).toEqual(undefined);
  });

  it("tolerates a header missing one of its two fields", async () => {
    const { prose, metadata } = await drain(fromChunks(["THEME: noir\n---\nRain fell."]), true);

    expect(metadata).toEqual({ theme: "noir", characters: undefined });
    expect(prose).toBe("Rain fell.");
  });

  it("yields nothing but still returns metadata when the model writes no prose", async () => {
    const { prose, metadata } = await drain(fromChunks(["THEME: noir\nCHARACTERS: a cat\n---"]), true);

    expect(metadata).toEqual({ theme: "noir", characters: "a cat" });
    expect(prose).toBe("");
  });

  /**
   * Same class of bug as the client-side sentinel: the delimiter is a protocol
   * boundary inside a stream whose chunk boundaries fall wherever the provider's
   * tokenizer put them. In particular a cut immediately after `---` used to leak
   * the following newline into the paragraph, because the leading-whitespace
   * strip only ever looked at the first post-delimiter chunk.
   */
  it("produces identical prose and metadata for every chunk split", async () => {
    const safeText = fc.stringMatching(/^[A-Za-z0-9 ,.']{1,40}$/);

    await fc.assert(
      fc.asyncProperty(
        safeText,
        safeText,
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.'\n]{0,120}$/),
        fc.array(fc.nat(300), { maxLength: 10 }),
        async (theme, characters, prose, cuts) => {
          const wire = `THEME: ${theme}\nCHARACTERS: ${characters}\n---\n${prose}`;

          const { prose: got, metadata } = await drain(fromChunks(splitAt(wire, cuts)), true);

          expect(got).toBe(prose);
          // `|| undefined` mirrors parseMetadataHeader: a field the model left
          // blank is absent, not an empty string the UI would render as a tag.
          expect(metadata).toEqual({
            theme: theme.trim() || undefined,
            characters: characters.trim() || undefined,
          });
        }
      ),
      { numRuns: 300 }
    );
  });

  it("keeps a blank THEME from swallowing the CHARACTERS line", async () => {
    // Also from the property above. A greedy `\s*` crossed the newline and
    // reported the whole next line as the theme.
    const { metadata } = await drain(
      fromChunks(["THEME:\nCHARACTERS: a lighthouse keeper\n---\nThe lamp turned."]),
      true
    );

    expect(metadata).toEqual({ theme: undefined, characters: "a lighthouse keeper" });
  });

  it("strips the delimiter's trailing newline even when the chunk ends right after it", async () => {
    // The exact regression the property above generalises. Kept as a named case
    // so a failure reads as a bug report rather than a shrunk counterexample.
    const { prose } = await drain(
      fromChunks(["THEME: noir\nCHARACTERS: a cat\n---", "\nRain fell on the city."]),
      true
    );

    expect(prose).toBe("Rain fell on the city.");
  });
});

describe("extractInventedMetadata — whitespace between the delimiter and the prose", () => {
  it("yields nothing for a post-delimiter chunk that is only whitespace", () => {
    // The model can emit the delimiter, then a chunk of blank space, then the
    // paragraph. The blank chunk must not surface as an empty leading line.
    return drain(fromChunks(["THEME: noir\nCHARACTERS: a cat\n---", "   \n ", "Rain fell."]), true).then(
      ({ prose }) => {
        expect(prose).toBe("Rain fell.");
      }
    );
  });
});
