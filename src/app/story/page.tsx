"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useStory, MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from "@/lib/story/StoryContext";
import { isWritersTurn } from "@/lib/story/turn";
import { AppHeader } from "@/components/AppHeader";

function StoryPage() {
  const {
    paragraphs,
    invented,
    theme,
    characters,
    targetLength,
    providers,
    selectedProviderId,
    generation,
    storyId,
    setSelectedProviderId,
    setTargetLength,
    submitAndContinue,
    generateNext,
    resetStory,
    hydrateStory,
  } = useStory();
  const [draft, setDraft] = useState("");
  const searchParams = useSearchParams();
  const requestedStoryId = searchParams.get("storyId");

  // Resuming a saved story from /library: hydrate the whole client state from the
  // server once, on mount / when the requested id changes. Guests never hit this —
  // /library is behind the sign-in gate, so a storyId in the URL implies a session.
  useEffect(() => {
    if (!requestedStoryId || requestedStoryId === storyId) return;
    let cancelled = false;
    fetch(`/api/stories/${requestedStoryId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        hydrateStory({
          theme: data.theme,
          characters: data.characters,
          openingLines: data.openingLines,
          selectedProviderId: data.selectedProviderId,
          targetLength: data.targetLength,
          paragraphs: data.paragraphs,
          invented: data.invented,
          generation: { kind: "idle" },
          storyId: data.id,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedStoryId]);

  const isStreaming = generation.kind === "streaming";
  const canContinue = isWritersTurn(paragraphs) && draft.trim().length > 0 && !isStreaming;
  const nextParagraphNumber = paragraphs.length + 1;

  const headerParts = [theme || invented?.theme, characters || invented?.characters].filter(
    (part): part is string => Boolean(part)
  );

  function providerDisplayName(id?: string): string {
    if (!id) return "AI";
    return providers.find((p) => p.id === id)?.displayName ?? id;
  }

  function handleContinue() {
    if (!canContinue) return;
    submitAndContinue(draft);
    setDraft("");
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-10 sm:py-14">
      <div className="w-full max-w-2xl">
        <AppHeader />

        <header className="mb-6 mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="sr-only">Your story</h1>
            {headerParts.length > 0 && (
              <p className="text-xs text-muted">
                <span aria-hidden="true">🏮 </span>
                {headerParts.join(" · ")}
              </p>
            )}
          </div>
          <Link
            href="/"
            onClick={resetStory}
            className="tap-target rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-accent"
          >
            New story
          </Link>
        </header>

        {/*
          role="log" marks this as content that grows by appending, so a screen
          reader announces each finished paragraph once as it lands instead of
          re-reading the whole story. The in-progress paragraph below is
          deliberately kept out of this region: announcing a token at a time
          would be unusable.
        */}
        <div className="flex flex-col gap-4" role="log" aria-live="polite" aria-label="Story so far">
          {paragraphs.map((p, i) => (
            <article
              key={i}
              aria-label={`Paragraph ${i + 1}, written by ${
                p.author === "ai" ? providerDisplayName(p.providerId) : "you"
              }`}
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

        </div>

        {isStreaming && (
          <article
            className="mt-4 rounded-2xl border border-border bg-ai-soft p-5"
            // Hidden from assistive tech while it fills in: the finished
            // paragraph is announced by the log above once it lands, and
            // announcing the partial text as it streams would talk over itself.
            // The status line below carries the state instead.
            aria-hidden="true"
          >
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

        {/* Announced once when writing starts, and once when it stops. */}
        <p role="status" className="sr-only">
          {isStreaming ? `${providerDisplayName(selectedProviderId)} is writing a paragraph…` : ""}
        </p>

        {generation.kind === "error" && (
          // role="alert" so a failure interrupts rather than waiting for a pause
          // — the Writer is watching for a paragraph that is not coming.
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-border bg-card p-4 text-sm text-foreground"
          >
            <p>{generation.message}</p>
            {/*
              No retry button for a turn violation (nothing to retry) or a rate
              limit (retrying now just fails again — the message says when).
            */}
            {generation.errorKind !== "turn-violation" && generation.errorKind !== "rate-limited" && (
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
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-sm text-muted" htmlFor="next-paragraph">
              Write the next paragraph
            </label>
            <span id="paragraph-progress" className="text-xs text-muted">
              Paragraph {nextParagraphNumber} of ~{targetLength}
            </span>
          </div>
          <textarea
            id="next-paragraph"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-describedby="paragraph-progress"
            placeholder="Continue the story in your own words..."
            className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
          />

          <div className="mt-4 flex items-center gap-3">
            <label htmlFor="target-length" className="whitespace-nowrap text-xs text-muted">
              Target length
            </label>
            <input
              id="target-length"
              type="range"
              min={MIN_TARGET_LENGTH}
              max={MAX_TARGET_LENGTH}
              step={1}
              value={targetLength}
              onChange={(e) => setTargetLength(Number(e.target.value))}
              className="h-11 w-full accent-accent"
            />
            <span className="whitespace-nowrap text-xs text-muted">~{targetLength}</span>
          </div>

          <div className="mt-4 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
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
            </div>

            <button
              type="button"
              onClick={handleContinue}
              disabled={!canContinue}
              className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {isStreaming ? (
                "Writing…"
              ) : (
                <>
                  Continue the Story <span aria-hidden="true">→</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Story() {
  return (
    <Suspense>
      <StoryPage />
    </Suspense>
  );
}
