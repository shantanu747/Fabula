export type ParagraphAuthor = "writer" | "ai";

export interface StoryParagraph {
  author: ParagraphAuthor;
  text: string;
  /** Only meaningful when author === "ai". Carried through for future per-paragraph
   *  attribution (US-9) — not consumed by prompt-building in this milestone. */
  providerId?: string;
}

export interface GenerateParagraphInput {
  /** Oldest-first paragraph history. Empty = generating the very first paragraph (UC-2/UC-3). */
  storySoFar: StoryParagraph[];
  /** Optional scene-setting hints. Only meaningful when storySoFar is empty. */
  theme?: string;
  characters?: string;
  openingLines?: string;
  /** Required so no call site can silently skip the per-request cost cap (PRD §7). */
  maxOutputTokens: number;
}

export interface InventedMetadata {
  theme?: string;
  characters?: string;
}

export interface LLMProvider {
  id: string; // 'anthropic' | 'openai' | 'openrouter' | ...
  displayName: string;
  /**
   * Extends AGENTS.md's `AsyncIterable<string>` to `AsyncGenerator<string, InventedMetadata | undefined>`.
   * Structurally still satisfies AsyncIterable<string> — `for await...of` consumers see no difference.
   * Only a manual .next()-driven consumer (the route handler) reads the generator's return value,
   * which carries the AI's invented theme/characters for UC-3's "separate tag" display requirement.
   */
  generateParagraph(
    input: GenerateParagraphInput
  ): AsyncGenerator<string, InventedMetadata | undefined, unknown>;
}
