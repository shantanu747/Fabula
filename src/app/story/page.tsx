"use client";

import { useState } from "react";
import Link from "next/link";
import { useStory } from "@/lib/story/StoryContext";
import { isAIsTurn, isWritersTurn } from "@/lib/story/turn";

export default function Story() {
  const {
    paragraphs,
    invented,
    theme,
    characters,
    providers,
    selectedProviderId,
    generation,
    setSelectedProviderId,
    submitWriterParagraph,
    generateNext,
    resetStory,
  } = useStory();
  const [draft, setDraft] = useState("");

  const isStreaming = generation.kind === "streaming";
  const canWrite = isWritersTurn(paragraphs) && draft.trim().length > 0 && !isStreaming;
  const canContinue = isAIsTurn(paragraphs) && !isStreaming;

  const headerParts = [theme || invented?.theme, characters || invented?.characters].filter(
    (part): part is string => Boolean(part)
  );

  function providerDisplayName(id?: string): string {
    if (!id) return "AI";
    return providers.find((p) => p.id === id)?.displayName ?? id;
  }

  function handleAddToStory() {
    if (!canWrite) return;
    submitWriterParagraph(draft);
    setDraft("");
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-10 sm:py-14">
      <div className="w-full max-w-2xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link
              href="/"
              className="font-serif text-lg font-semibold tracking-tight text-foreground"
            >
              Fabula
            </Link>
            {headerParts.length > 0 && (
              <p className="mt-1 text-xs text-muted">🏮 {headerParts.join(" · ")}</p>
            )}
          </div>
          <Link
            href="/"
            onClick={resetStory}
            className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-accent"
          >
            New story
          </Link>
        </header>

        <div className="flex flex-col gap-4">
          {paragraphs.map((p, i) => (
            <article
              key={i}
              className={
                p.author === "ai"
                  ? "rounded-2xl border border-border bg-ai-soft p-5"
                  : "rounded-2xl border border-border bg-card p-5"
              }
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={
                    p.author === "ai"
                      ? "inline-flex items-center rounded-full bg-ai px-2.5 py-0.5 text-xs font-medium text-accent-foreground"
                      : "inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground"
                  }
                >
                  {p.author === "ai" ? providerDisplayName(p.providerId) : "You"}
                </span>
              </div>
              <p className="font-serif text-[15px] leading-7 text-foreground">{p.text}</p>
            </article>
          ))}

          {isStreaming && (
            <article className="rounded-2xl border border-border bg-ai-soft p-5">
              <div className="mb-2 flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-ai px-2.5 py-0.5 text-xs font-medium text-accent-foreground">
                  {providerDisplayName(selectedProviderId)}
                </span>
              </div>
              <p className="font-serif text-[15px] leading-7 text-foreground">
                {generation.text}
                <span className="animate-pulse">▍</span>
              </p>
            </article>
          )}
        </div>

        {generation.kind === "error" && (
          <div className="mt-4 rounded-2xl border border-border bg-card p-4 text-sm text-foreground">
            <p>{generation.message}</p>
            {generation.errorKind !== "turn-violation" && (
              <button
                type="button"
                onClick={() => generateNext()}
                className="mt-3 rounded-xl border border-border px-4 py-2 text-xs font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Try again
              </button>
            )}
          </div>
        )}

        <div className="mt-6 rounded-2xl border border-border bg-card p-5 shadow-sm">
          <label className="mb-2 block text-sm text-muted" htmlFor="next-paragraph">
            Write the next paragraph
          </label>
          <textarea
            id="next-paragraph"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Continue the story in your own words..."
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <div className="mt-3 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={handleAddToStory}
              disabled={!canWrite}
              className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground"
            >
              Add to story
            </button>

            <div className="flex items-center gap-2 sm:justify-end">
              <label htmlFor="provider-switch" className="text-xs text-muted">
                AI writes as
              </label>
              <select
                id="provider-switch"
                value={selectedProviderId}
                onChange={(e) => setSelectedProviderId(e.target.value)}
                disabled={isStreaming}
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-40"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => generateNext()}
                disabled={!canContinue}
                className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {isStreaming ? "Writing…" : "Continue →"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
