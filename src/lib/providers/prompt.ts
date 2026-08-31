import { CONTEXT_WINDOW_CHAR_BUDGET } from "./constants";
import type { GenerateParagraphInput, InventedMetadata, StoryParagraph } from "./types";

export function buildSystemPrompt(): string {
  return [
    "You are a collaborative fiction co-writer inside Fabula, an app where a human Writer and an AI take turns writing one paragraph each of a short story.",
    "On your turn:",
    '- Write exactly ONE paragraph, roughly 80–180 words — enough to move the story forward, not so long it rambles or wanders.',
    '- Output only the paragraph\'s prose. No preamble, no meta-commentary, no chapter titles, no "AI:"/author labels, no multiple paragraphs.',
    "- Match the tone, point of view, and narrative voice already established in the story so far — don't impose a different style partway through.",
    "- Stay strictly consistent with names, settings, and plot details already established. Never contradict, retcon, or restart the story.",
    "- If a note says earlier paragraphs were omitted for length, treat it as real story history you can't see in full — continue naturally from what's visible, and don't invent specific details that might conflict with what was omitted.",
    "- If no genre, characters, or opening exists yet, invent one yourself and stay consistent with it for the rest of the story.",
    "- Default to broadly age-appropriate content suitable for a general audience, including a child co-writing with a parent, unless the story text you've been given clearly signals otherwise. Avoid graphic violence, sexual content, and explicit substance use by default.",
  ].join("\n");
}

/**
 * Rolling context buffer: the client always sends (and displays) the full story;
 * this only bounds what's sent to the model on each generation call. Keeps the
 * opening paragraph as an anchor (it carries the theme/characters/premise the rest
 * of the story depends on) plus as many of the most recent paragraphs as fit the
 * remaining budget — not naive from-the-end truncation, which would risk losing
 * the premise on a long story. Truncation only, no summarization (v1 scope).
 */
export function windowStoryParagraphs(paragraphs: StoryParagraph[]): StoryParagraph[] {
  if (paragraphs.length === 0) return paragraphs;

  const totalLength = paragraphs.reduce((sum, p) => sum + p.text.length, 0);
  if (totalLength <= CONTEXT_WINDOW_CHAR_BUDGET) return paragraphs;

  const [anchor, ...rest] = paragraphs;
  const budgetForRest = CONTEXT_WINDOW_CHAR_BUDGET - anchor.text.length;

  const kept: StoryParagraph[] = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const candidate = rest[i];
    if (used + candidate.text.length > budgetForRest) break;
    kept.unshift(candidate);
    used += candidate.text.length;
  }

  const omitted = rest.length - kept.length;
  const anchorWithNote: StoryParagraph =
    omitted > 0
      ? {
          ...anchor,
          text: `${anchor.text}\n\n[...earlier paragraphs continue here, omitted for length...]`,
        }
      : anchor;

  return [anchorWithNote, ...kept];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const CONTINUE_INSTRUCTION =
  "Continue the story with the next paragraph, picking up naturally from where it left off.";

/**
 * Theme/characters are always carried by the turn-0 kickoff message (see
 * buildKickoffInstruction), but were previously dropped from every later turn —
 * once storySoFar was non-empty, nothing in buildMessages referenced them again.
 * This reminder plugs that gap for turns after the first.
 */
function buildOngoingContextNote(input: GenerateParagraphInput): string | undefined {
  const parts: string[] = [];
  if (input.theme) parts.push(`Genre/theme: ${input.theme}.`);
  if (input.characters) parts.push(`Established characters: ${input.characters}.`);
  return parts.length > 0 ? `Keep in mind — ${parts.join(" ")}` : undefined;
}

/**
 * Soft-target narrative pacing: as the story approaches the Writer-chosen target
 * length, nudge the AI's own turns toward a climax and then a resolution, instead
 * of continuing indefinitely with no dramatic shape. Never blocks anything — a
 * Writer can keep adding paragraphs regardless of what this returns.
 * `currentCount` must be the true (pre-windowing) total paragraph count so the
 * bands don't fire late on a long, windowed-down story.
 */
function buildLengthSteeringNote(currentCount: number, target?: number): string | undefined {
  if (!target || target <= 0) return undefined;
  const nextParagraphNumber = currentCount + 1;
  const ratio = currentCount / target;

  if (ratio < 0.6) return undefined;
  if (ratio < 0.85) {
    return `The story is approaching its target length (paragraph ${nextParagraphNumber} of ~${target}). Start raising the stakes — deepen the central conflict or introduce a complication that pushes things toward a climax soon.`;
  }
  if (ratio < 1.0) {
    return `The story is nearing its target length (paragraph ${nextParagraphNumber} of ~${target}). This is a good point to bring the story to its climax — the central conflict's most intense moment.`;
  }
  return `The story has reached or passed its target length (paragraph ${nextParagraphNumber} of ~${target}). Actively work toward resolving the plot now — wrap up loose threads rather than introducing new ones, and bring the story to a natural close within this paragraph or the next.`;
}

function buildContinuationMessage(input: GenerateParagraphInput, trueCount: number): string {
  const parts = [CONTINUE_INSTRUCTION];
  const context = buildOngoingContextNote(input);
  if (context) parts.push(context);
  const length = buildLengthSteeringNote(trueCount, input.targetLength);
  if (length) parts.push(length);
  return parts.join("\n\n");
}

function buildKickoffInstruction(input: GenerateParagraphInput): string {
  const hints: string[] = [];
  if (input.theme) hints.push(`Genre/theme: ${input.theme}`);
  if (input.characters) hints.push(`Starter characters: ${input.characters}`);
  if (input.openingLines) hints.push(`Opening lines to build from: ${input.openingLines}`);

  if (hints.length === 0) {
    return [
      "Nothing has been set up yet — invent an engaging genre, characters, and opening scene yourself.",
      "Prefix your response with exactly this format before the paragraph itself — the header must end with a line containing only three dashes (---), and only the paragraph follows it:",
      "THEME: <a short phrase>",
      "CHARACTERS: <a short phrase>",
      "---",
      "<the opening paragraph>",
    ].join("\n");
  }

  return [
    "Write the opening paragraph of the story using the following as a starting point:",
    ...hints,
    "Write only the paragraph itself.",
  ].join("\n");
}

/**
 * Maps (already-windowed) storySoFar to alternating chat messages. No same-author
 * merge logic is needed: the API route enforces a strict one-turn-each policy before
 * a provider is ever called, so storySoFar can never end in two consecutive
 * same-author paragraphs by construction — messages always alternate correctly.
 *
 * `trueCount` is the real (pre-windowing) paragraph count, used only for length-
 * steering math — windowing can drop paragraphs from what's sent to the model, but
 * the story's actual progress toward its target length shouldn't be understated
 * just because older paragraphs were trimmed for context-budget reasons.
 */
export function buildMessages(input: GenerateParagraphInput, trueCount: number): ChatMessage[] {
  if (input.storySoFar.length === 0) {
    return [{ role: "user", content: buildKickoffInstruction(input) }];
  }

  const messages: ChatMessage[] = input.storySoFar.map((p) => ({
    role: p.author === "writer" ? "user" : "assistant",
    content: p.text,
  }));
  messages.push({ role: "user", content: buildContinuationMessage(input, trueCount) });
  return messages;
}

const METADATA_DELIMITER = "---";

function parseMetadataHeader(header: string): InventedMetadata {
  // `[ \t]*`, not `\s*`: \s matches newlines, so a model that emits a bare
  // "THEME:" with nothing after it would greedily swallow the following
  // "CHARACTERS:" line and report it as the theme. Each field is confined to
  // its own line, and a field left blank simply comes back undefined.
  const themeMatch = header.match(/THEME:[ \t]*(.+)/i);
  const charactersMatch = header.match(/CHARACTERS:[ \t]*(.+)/i);
  return {
    theme: themeMatch?.[1]?.trim() || undefined,
    characters: charactersMatch?.[1]?.trim() || undefined,
  };
}

/**
 * Only active for the true "zero input" kickoff case (UC-3's precondition). Buffers
 * raw chunks until the model's `---` delimiter, parses the header into InventedMetadata,
 * yields only the prose after it, and returns the parsed metadata. A pure passthrough
 * (returns undefined) whenever expectHeader is false.
 */
export async function* extractInventedMetadata(
  rawStream: AsyncIterable<string>,
  expectHeader: boolean
): AsyncGenerator<string, InventedMetadata | undefined, unknown> {
  if (!expectHeader) {
    for await (const chunk of rawStream) {
      yield chunk;
    }
    return undefined;
  }

  let buffer = "";
  let foundDelimiter = false;
  // The newline the model writes after `---` must be swallowed, but it does not
  // necessarily arrive in the same chunk as the delimiter. Stripping only the
  // first post-delimiter chunk leaks that newline into the paragraph whenever a
  // chunk boundary happens to fall right after `---`, so the strip stays armed
  // until actual prose shows up.
  let leadingStripped = false;
  let metadata: InventedMetadata | undefined;

  function emit(text: string): string {
    if (leadingStripped) return text;
    const stripped = text.replace(/^\s+/, "");
    if (stripped) leadingStripped = true;
    return stripped;
  }

  for await (const chunk of rawStream) {
    if (foundDelimiter) {
      const out = emit(chunk);
      if (out) yield out;
      continue;
    }
    buffer += chunk;
    const idx = buffer.indexOf(METADATA_DELIMITER);
    if (idx !== -1) {
      foundDelimiter = true;
      metadata = parseMetadataHeader(buffer.slice(0, idx));
      const rest = emit(buffer.slice(idx + METADATA_DELIMITER.length));
      if (rest) yield rest;
    }
  }

  // Model ignored the header format (e.g. a refusal or an instruction miss) — fall
  // back to the buffered text as prose rather than silently dropping it.
  if (!foundDelimiter && buffer) {
    yield buffer;
  }

  return metadata;
}

/**
 * Shared wrapper every adapter's generateParagraph delegates to. Handles windowing,
 * deciding whether to expect the invented-metadata header, and delegating to
 * extractInventedMetadata — the only provider-specific part is rawTextStream, which
 * just turns that SDK's native stream into raw text chunks.
 */
export function generateWithProvider(
  input: GenerateParagraphInput,
  rawTextStream: (input: GenerateParagraphInput, trueCount: number) => AsyncIterable<string>
): AsyncGenerator<string, InventedMetadata | undefined, unknown> {
  const expectHeader =
    input.storySoFar.length === 0 && !input.theme && !input.characters && !input.openingLines;
  const trueCount = input.storySoFar.length; // captured before windowing may trim it
  const windowed: GenerateParagraphInput = {
    ...input,
    storySoFar: windowStoryParagraphs(input.storySoFar),
  };
  return extractInventedMetadata(rawTextStream(windowed, trueCount), expectHeader);
}
