"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useStory } from "@/lib/story/StoryContext";
import { isWritersTurn } from "@/lib/story/turn";
import { AppHeader, AuthLinks, NAV_LINK } from "@/components/AppHeader";
import { splitDisplayName } from "@/lib/ui/providerName";
import { stageIndex } from "@/lib/ui/stageIndex";

// Story prose: 17px / 1.85 Lora, justified and hyphenated from the tablet
// breakpoint up; 16px / 1.8 and ragged-right on a phone (boards 1c, 1g).
const PROSE =
  "font-body text-[16px] leading-[1.8] text-prose md:text-[17px] md:leading-[1.85] md:text-justify md:hyphens-auto [text-wrap:pretty]";

// The gutter column: 112px with 24px right padding on the tablet breakpoint and
// up. Below it the label folds above its paragraph (10px, 6px gap).
const ROW = "md:grid md:grid-cols-[112px_1fr]";
const GUTTER = "relative mb-[6px] md:mb-0 md:pr-6 md:pt-[9px] md:text-right";
const LABEL = "author-label text-[10px] md:text-[10.5px]";

const STAGES = ["Setup", "Turn", "Climax", "Close"] as const;
const RAIL_HEIGHT = 210;

function AuthorLabel({ ai, children }: { ai: boolean; children: React.ReactNode }) {
  return (
    <span className={ai ? `${LABEL} author-label-ai` : LABEL}>
      {ai && (
        // The mobile stand-in for the gutter rule: a 14px gold dash before the label.
        <span aria-hidden="true" className="mr-2 inline-block h-px w-[14px] bg-accent/55 align-middle md:hidden" />
      )}
      {children}
    </span>
  );
}

/** The 1px gold rule that marks an AI paragraph, 11px in from the gutter's right edge. */
function GutterRule() {
  return (
    <span aria-hidden="true" className="absolute bottom-0 right-[11px] top-0 hidden w-px bg-accent/55 md:block" />
  );
}

/**
 * Decorative: the paragraph count in `#paragraph-progress` is the accessible
 * progress text, so the rail is hidden from assistive tech. SVG attributes
 * carry the fill height — an inline style would trip the production CSP.
 */
function ArcRail({ count, target, ratio }: { count: number; target: number; ratio: number }) {
  const stage = stageIndex(ratio);
  const fill = Math.round(RAIL_HEIGHT * ratio);
  return (
    <aside aria-hidden="true" className="hidden lg:sticky lg:top-20 lg:block lg:self-start lg:pl-8">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted">Arc</p>
      <div className="mt-3 flex gap-3">
        <svg width="3" height={RAIL_HEIGHT} className="shrink-0">
          <rect x="1" y="0" width="1" height={RAIL_HEIGHT} className="fill-foreground/16" />
          <rect x="0" y="0" width="3" height={fill} className="fill-accent" />
        </svg>
        <ul className="flex flex-col justify-between text-[12.5px] leading-none">
          {STAGES.map((name, i) => (
            <li key={name} className={i === stage ? "text-accent-text" : "text-muted"}>
              {name}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 text-[11px] tabular-nums text-muted">
        {count} of ~{target}
      </p>
    </aside>
  );
}

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
    isShared,
    setSelectedProviderId,
    setShared,
    submitAndContinue,
    generateNext,
    switchProviderAndRetry,
    resetStory,
    hydrateStory,
  } = useStory();
  const { status: authStatus } = useSession();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
          isShared: data.isShared,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedStoryId]);

  // The composer grows with its content: a borderless textarea that reads as
  // the next paragraph in the column, never a scrolling box. `field-sizing:
  // content` does this natively where supported; this is the fallback.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const isStreaming = generation.kind === "streaming";
  const canContinue = isWritersTurn(paragraphs) && draft.trim().length > 0 && !isStreaming;
  const nextParagraphNumber = paragraphs.length + 1;
  const ratio = targetLength > 0 ? Math.min(paragraphs.length / targetLength, 1) : 0;
  const isAuthenticated = authStatus === "authenticated";

  const headerParts = [theme || invented?.theme, characters || invented?.characters].filter(
    (part): part is string => Boolean(part)
  );

  function providerDisplayName(id?: string): string {
    if (!id) return "AI";
    return providers.find((p) => p.id === id)?.displayName ?? id;
  }

  function providerShortName(id?: string): string {
    return splitDisplayName(providerDisplayName(id)).name;
  }

  function handleContinue() {
    if (!canContinue) return;
    submitAndContinue(draft);
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleContinue();
    }
  }

  // Save is the header's promise to a Writer, not new state. For a guest,
  // Save is sign-in — persistence is automatic once signed in (docs/adr/0009),
  // and the guest's paragraphs survive the client-side navigation.
  const saveAction = isAuthenticated ? (
    // Hidden below `lg`: the canvas header holds mark, divider, theme, count,
    // Saved, Share, New story, My library, Feed, Sign out, and the theme
    // already truncates at tablet widths — "Saved" is the lowest-value item
    // to drop first (no board covers this width).
    storyId ? <span className="hidden text-[12px] italic text-muted lg:inline">Saved</span> : null
  ) : (
    <Link href="/login" className={NAV_LINK}>
      Sign in to save
    </Link>
  );
  // Share toggles isShared directly from the canvas (docs/adr/0039) — same
  // control, copy, and optimistic-then-PATCH behavior as /library's
  // ShareToggle. Only meaningful once the story is persisted.
  const shareAction =
    isAuthenticated && storyId ? (
      <button
        type="button"
        onClick={() => setShared(!isShared)}
        className={isShared ? "btn btn-primary btn-xs tap-target" : "btn btn-secondary btn-xs tap-target"}
      >
        {isShared ? "Shared to feed" : "Share to feed"}
      </button>
    ) : null;
  const newStoryAction = (
    <Link href="/" onClick={resetStory} className="btn btn-primary btn-xs tap-target">
      New story
    </Link>
  );

  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader
        variant="canvas"
        meta={headerParts.length > 0 ? headerParts.join(" · ") : undefined}
        aside={`${paragraphs.length} / ~${targetLength}`}
        progress={ratio}
        actions={
          <>
            {saveAction}
            {shareAction}
            {newStoryAction}
          </>
        }
      />

      <main className="mx-auto w-full max-w-[800px] px-[22px] pb-[46px] pt-[26px] md:px-6 md:pt-[56px] lg:grid lg:grid-cols-[1fr_96px] lg:px-0">
        <div>
          <h1 className="sr-only">Your story</h1>

          {/*
            role="log" marks this as content that grows by appending, so a screen
            reader announces each finished paragraph once as it lands instead of
            re-reading the whole story. The in-progress paragraph below is
            deliberately kept out of this region: announcing a token at a time
            would be unusable.
          */}
          <div className="flex flex-col gap-6 md:gap-[30px]" role="log" aria-live="polite" aria-label="Story so far">
            {paragraphs.map((p, i) => {
              const ai = p.author === "ai";
              return (
                <article
                  key={i}
                  aria-label={`Paragraph ${i + 1}, written by ${ai ? providerDisplayName(p.providerId) : "you"}`}
                  className={ROW}
                >
                  <div className={GUTTER}>
                    {ai && <GutterRule />}
                    <AuthorLabel ai={ai}>{ai ? providerShortName(p.providerId) : "You"}</AuthorLabel>
                  </div>
                  <p className={PROSE}>{p.text}</p>
                </article>
              );
            })}
          </div>

          {isStreaming && (
            <article
              className={`mt-6 md:mt-[30px] ${ROW}`}
              // Hidden from assistive tech while it fills in: the finished
              // paragraph is announced by the log above once it lands, and
              // announcing the partial text as it streams would talk over itself.
              // The status line below carries the state instead.
              aria-hidden="true"
            >
              <div className={GUTTER}>
                <GutterRule />
                <AuthorLabel ai>{providerShortName(selectedProviderId)}</AuthorLabel>
                <span className="block text-[10.5px] italic leading-[1.5] text-muted">writing…</span>
              </div>
              <p className={PROSE}>
                {generation.text}
                <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-accent" />
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
              className="mt-6 border-y border-border py-4 text-[14px] leading-[1.7] text-foreground md:ml-[112px] md:mt-[30px]"
            >
              <p>{generation.message}</p>
              {/*
                No retry button for a turn violation (nothing to retry) or a rate
                limit (retrying now just fails again — the message says when).
              */}
              {generation.errorKind !== "turn-violation" && generation.errorKind !== "rate-limited" && (
                <div className="mt-4 flex flex-wrap gap-3">
                  {generation.errorKind === "provider-unavailable" && generation.suggestedProviderId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => switchProviderAndRetry(generation.suggestedProviderId!)}
                        // min-h-11 rather than .tap-target: this pair wraps onto
                        // separate rows at mobile widths, and .tap-target's
                        // invisible hit-area overlay would then overlap the
                        // other button's row (see its comment in globals.css).
                        className="btn btn-secondary btn-sm min-h-11"
                      >
                        Use {generation.suggestedProviderName ?? "another provider"}
                      </button>
                      <button
                        type="button"
                        onClick={() => generateNext()}
                        className="btn btn-secondary btn-sm min-h-11"
                      >
                        Try {providerDisplayName(generation.failedProviderId)} again
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => generateNext()} className="btn btn-secondary btn-sm min-h-11">
                      Try again
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* The composer: the next row in the same column, in the same type. */}
          <div className={`mt-6 md:mt-[30px] ${ROW}`}>
            <div className={GUTTER}>
              <AuthorLabel ai={false}>You</AuthorLabel>
            </div>
            <div className="relative">
              <label htmlFor="next-paragraph" className="sr-only">
                Write the next paragraph
              </label>
              <span id="paragraph-progress" className="sr-only">
                Paragraph {nextParagraphNumber} of ~{targetLength}
              </span>
              {draft.length === 0 && (
                // The 1.5px accent bar that opens the empty composer (board 1c).
                <span
                  aria-hidden="true"
                  className={`absolute left-0 top-[0.45em] h-[1.1em] w-[1.5px] bg-accent ${isStreaming ? "opacity-[0.42]" : ""}`}
                />
              )}
              <textarea
                id="next-paragraph"
                ref={textareaRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-describedby="paragraph-progress"
                placeholder={
                  isStreaming
                    ? "Your turn opens when the paragraph lands."
                    : "Keep going — the next paragraph is yours."
                }
                // While the AI writes, the composer reads as closed: the placeholder
                // fades, not the control — a dimmed textarea fails the contrast gate
                // even when empty (docs/adr/0031).
                className={`${PROSE} peer field-sizing-content block w-full resize-none overflow-hidden border-0 bg-transparent p-0 pl-[7px] placeholder:italic focus-visible:outline-none ${
                  isStreaming ? "placeholder:text-foreground/20" : "placeholder:text-foreground/34"
                }`}
              />
              {/* The composer's focus indicator: a 2px accent rule down the textarea's
                  left edge, the same device GutterRule uses for an AI paragraph — shown
                  on keyboard focus regardless of content, since the borderless field has
                  no other visible focus state (docs/adr/0031, WCAG 2.4.7). */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 hidden w-[2px] bg-accent peer-focus-visible:block"
              />
            </div>
          </div>

          {/* The action row, aligned to the prose column; pinned above a rule on a phone. */}
          <div className="mt-[26px] md:ml-[112px] max-md:sticky max-md:bottom-0 max-md:bg-background">
            <div className="flex items-center gap-4 border-t border-border pt-4 md:pt-5">
              <button type="button" onClick={handleContinue} disabled={!canContinue} className="btn btn-primary btn-sm">
                {isStreaming ? "Writing…" : "Add & continue"}
              </button>
              <kbd aria-hidden="true" className="hidden font-body text-[11.5px] text-muted md:inline">
                ⌘ ↵
              </kbd>
              <div className="ml-auto flex flex-col items-end gap-1 text-[13px] md:flex-row md:items-baseline md:gap-2">
                <label htmlFor="provider-switch" className="text-muted">
                  Next voice
                </label>
                {/*
                  A 44px control drawn as inline text: the select itself is the
                  full touch target (a .tap-target overlay on a wrapper would
                  swallow the click), and the underline is a sibling sitting at
                  the text's baseline rather than the box's bottom edge.
                */}
                <span className="relative inline-flex items-center">
                  <select
                    id="provider-switch"
                    value={selectedProviderId}
                    onChange={(e) => setSelectedProviderId(e.target.value)}
                    disabled={isStreaming}
                    className="peer h-11 appearance-none border-0 bg-transparent py-0 pl-0 pr-[14px] font-body text-[13px] text-foreground focus-visible:outline-none"
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {splitDisplayName(p.displayName).name}
                      </option>
                    ))}
                  </select>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-[10px] h-px bg-foreground/30 peer-focus-visible:bg-accent"
                  />
                  <span aria-hidden="true" className="pointer-events-none absolute bottom-[13px] right-0 text-[10px] text-muted">
                    ⌄
                  </span>
                </span>
              </div>
            </div>
          </div>

          {/* On a phone the header carries only mark, theme and count; the rest lands here. */}
          <nav aria-label="Story actions" className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 md:hidden">
            {saveAction}
            {shareAction}
            {newStoryAction}
            <AuthLinks guestLinks={false} />
          </nav>
        </div>

        <ArcRail count={paragraphs.length} target={targetLength} ratio={ratio} />
      </main>
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
