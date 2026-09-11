"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStory, MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from "@/lib/story/StoryContext";
import { AppHeader } from "@/components/AppHeader";
import { splitDisplayName } from "@/components/providerName";
import { numberWord } from "@/components/numberWord";

const PRESET_THEMES = ["Fantasy", "Mystery", "Sci-fi", "Fairytale", "Slice of life"];

// Decorative-only, keyed by provider id. Not correctness-critical (unlike
// id/displayName, which come from the registry via useStory().providers) —
// safe to fall back to an empty string for any id this doesn't recognize.
const PROVIDER_BLURBS: Record<string, string> = {
  anthropic: "thoughtful, literary prose",
  openai: "fast and versatile",
  openrouter: "open-weight option",
};

// The five screens of the start flow (README "Start flow", board 2a). Each is
// optional and skippable; the rail lets a Writer jump to any of them.
const STEPS = [
  { rail: "Scene", kicker: "One of five", title: "Set the scene" },
  { rail: "People", kicker: "Two of five", title: "The people in it" },
  { rail: "Opening", kicker: "Three of five", title: "How it opens" },
  { rail: "Voice", kicker: "Four of five", title: "Who writes with you" },
  { rail: "Length", kicker: "Five of five", title: "How long it runs" },
] as const;
const LAST_STEP = STEPS.length - 1;

// `transform: translateX(-step * 20%)` on the five-panel track — as static
// classes, since an inline style would trip the production CSP.
const SHIFT = ["translate-x-0", "-translate-x-1/5", "-translate-x-2/5", "-translate-x-3/5", "-translate-x-4/5"];

// The ruler: thirteen rules aligned to a 34px baseline, heights cycling
// 22 / 10 / 10 / 16 / 10 / 10 / 22, one rule per even value of the 6–30 range.
const TICK_HEIGHTS = ["h-[22px]", "h-[10px]", "h-[10px]", "h-[16px]", "h-[10px]", "h-[10px]"];
const TICK_VALUES = Array.from({ length: 13 }, (_, i) => MIN_TARGET_LENGTH + i * 2);

const TITLE = "mt-4 font-heading text-[38px] font-normal leading-[1.08] text-foreground md:text-[46px]";
const LEAD = "mt-3 text-[14px] italic leading-[1.7] text-muted";

export default function Home() {
  const router = useRouter();
  const {
    theme,
    characters,
    openingLines,
    selectedProviderId,
    targetLength,
    providers,
    generation,
    setTheme,
    setCharacters,
    setOpeningLines,
    setSelectedProviderId,
    setTargetLength,
    generateNext,
    submitAndContinue,
  } = useStory();

  // The only new state the stepper adds (README "State"): which screen is up.
  const [step, setStep] = useState(0);
  const panelRefs = useRef<(HTMLElement | null)[]>([]);
  const mounted = useRef(false);

  // Move focus with the slide so keyboard and screen-reader users land on the
  // screen they asked for, not on a control that just went off-stage.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    panelRefs.current[step]?.focus({ preventScroll: true });
  }, [step]);

  const isStreaming = generation.kind === "streaming";

  function handleStart() {
    if (isStreaming) return;
    if (openingLines.trim()) {
      submitAndContinue(openingLines);
    } else {
      generateNext();
    }
    router.push("/story");
  }

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const voiceName = selectedProvider ? splitDisplayName(selectedProvider.displayName).name : "";

  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      <h1 className="sr-only">Fabula</h1>

      {/* The stage: five panels on one track, sliding right to left. */}
      <div className="relative min-h-[472px] overflow-x-hidden md:h-[472px] md:flex-none md:overflow-hidden">
        <div
          className={`flex w-[500%] transition-transform duration-[580ms] ease-[cubic-bezier(0.22,0.61,0.36,1)] motion-reduce:transition-none ${SHIFT[step]}`}
        >
          {STEPS.map((s, i) => (
            <section
              key={s.rail}
              ref={(el) => {
                panelRefs.current[i] = el;
              }}
              tabIndex={-1}
              aria-labelledby={`step-title-${i}`}
              aria-hidden={i !== step}
              inert={i !== step}
              className="flex w-1/5 justify-center px-[22px] pt-[26px] pb-8 outline-none md:px-6 md:pt-[54px]"
            >
              <div className="w-full max-w-[620px]">
                <p className="kicker tabular-nums">{s.kicker}</p>
                <h2 id={`step-title-${i}`} className={TITLE}>
                  {s.title}
                </h2>

                {i === 0 && (
                  <>
                    <p className={LEAD}>Everything here is optional. Skip anything that isn&apos;t interesting yet.</p>
                    <label className="field-label mt-10" htmlFor="theme">
                      Genre or theme
                    </label>
                    <input
                      id="theme"
                      type="text"
                      value={theme}
                      onChange={(e) => setTheme(e.target.value)}
                      disabled={isStreaming}
                      placeholder="A cozy mystery in a small mountain town"
                      className="field mt-3 font-heading text-[26px] leading-[1.3] pb-[10px] md:text-[30px]"
                    />
                    <div className="mt-[18px] flex flex-wrap gap-2">
                      {PRESET_THEMES.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          disabled={isStreaming}
                          aria-pressed={theme === preset}
                          onClick={() => setTheme(preset)}
                          className="chip"
                        >
                          <span>{preset}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {i === 1 && (
                  <>
                    <p className={LEAD}>A name and a problem is usually enough. The AI will fill in the rest.</p>
                    <label className="field-label mt-10" htmlFor="characters">
                      Starter characters
                    </label>
                    <textarea
                      id="characters"
                      rows={2}
                      value={characters}
                      onChange={(e) => setCharacters(e.target.value)}
                      disabled={isStreaming}
                      placeholder="A retired lighthouse keeper and a dragon who's afraid of water"
                      className="field mt-3 min-h-[86px] font-heading text-[24px] leading-[1.45] pb-[10px] md:text-[27px]"
                    />
                    <p className="mt-4 text-[12.5px] italic leading-[1.7] text-muted">
                      Leave it blank and the AI invents someone.
                    </p>
                  </>
                )}

                {i === 2 && (
                  <>
                    <p className={LEAD}>Write the first lines yourself, or hand the opening to the AI.</p>
                    <label className="field-label mt-[38px]" htmlFor="opening">
                      Opening lines
                    </label>
                    <textarea
                      id="opening"
                      rows={3}
                      value={openingLines}
                      onChange={(e) => setOpeningLines(e.target.value)}
                      disabled={isStreaming}
                      placeholder="Write a line or two to set the tone…"
                      className="field mt-3 min-h-[112px] font-heading text-[23px] italic leading-[1.55] pb-[10px] md:text-[26px]"
                    />
                    <p className="mt-5 text-[12.5px] leading-[1.7] text-muted">
                      or{" "}
                      <button
                        type="button"
                        disabled={isStreaming}
                        onClick={() => {
                          setOpeningLines("");
                          setStep(3);
                        }}
                        className="tap-target text-foreground underline decoration-foreground/30 underline-offset-[3px] transition-colors hover:text-accent-text hover:decoration-accent/50"
                      >
                        let the AI write the first paragraph
                      </button>
                    </p>
                  </>
                )}

                {i === 3 && (
                  <>
                    <p className={LEAD}>You can change this at any point in the story without losing a word.</p>
                    <fieldset className="mt-[34px]">
                      <legend className="sr-only">Choose who writes with you</legend>
                      {providers.map((provider) => {
                        const { name, vendor } = splitDisplayName(provider.displayName);
                        const blurb = PROVIDER_BLURBS[provider.id];
                        return (
                          <label
                            key={provider.id}
                            className="radio relative flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border py-[15px] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-45"
                          >
                            <input
                              type="radio"
                              name="provider"
                              checked={selectedProviderId === provider.id}
                              onChange={() => setSelectedProviderId(provider.id)}
                              disabled={isStreaming}
                            />
                            <span className="dot translate-y-[2px] self-center" />
                            <span className="w-[120px] shrink-0 font-heading text-[21px] font-semibold leading-none text-foreground">
                              {name}
                            </span>
                            <span className="text-[13px] leading-[1.5] text-muted">
                              {vendor}
                              {vendor && blurb ? " · " : ""}
                              {blurb ?? ""}
                            </span>
                          </label>
                        );
                      })}
                    </fieldset>
                  </>
                )}

                {i === 4 && (
                  <>
                    {/*
                      A restyled native range input: the ticks are drawn behind it and
                      the input itself, full-size and transparent, stays the control —
                      pointer, keyboard and screen reader all drive the same value.
                    */}
                    <div className="relative mt-[26px]">
                      <div aria-hidden="true" className="flex h-[34px] items-end gap-[3px]">
                        {TICK_VALUES.map((value, t) => (
                          <span
                            key={value}
                            className={`flex-1 border-l ${TICK_HEIGHTS[t % TICK_HEIGHTS.length]} ${
                              value <= targetLength ? "border-accent" : "border-foreground/20"
                            }`}
                          />
                        ))}
                      </div>
                      <label htmlFor="target-length" className="sr-only">
                        Target length in paragraphs
                      </label>
                      <input
                        id="target-length"
                        type="range"
                        min={MIN_TARGET_LENGTH}
                        max={MAX_TARGET_LENGTH}
                        step={1}
                        value={targetLength}
                        onChange={(e) => setTargetLength(Number(e.target.value))}
                        disabled={isStreaming}
                        aria-valuetext={`${targetLength} paragraphs`}
                        className="absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-pointer opacity-0 focus-visible:opacity-100 focus-visible:accent-accent"
                      />
                    </div>
                    <div className="mt-[10px] flex flex-wrap items-baseline justify-between gap-x-4 text-[12.5px] leading-[1.6]">
                      <p className="text-muted">
                        <span className="text-foreground">{numberWord(targetLength, { capitalize: true })}</span> paragraphs, give or take
                      </p>
                      <p className="italic text-muted">a guide, not a stop</p>
                    </div>

                    {/* The colophon: what was set on the way here. */}
                    <hr className="mb-[22px] mt-8 h-px border-0 bg-border" />
                    <dl className="grid grid-cols-[104px_1fr] gap-x-5 gap-y-[10px] text-[13px] leading-[1.6]">
                      <dt className="pt-1 text-[10.5px] uppercase tracking-[0.12em] text-muted">Theme</dt>
                      <dd>{theme.trim() ? theme : <span className="italic text-muted">The AI invents one</span>}</dd>
                      <dt className="pt-1 text-[10.5px] uppercase tracking-[0.12em] text-muted">People</dt>
                      <dd>
                        {characters.trim() ? characters : <span className="italic text-muted">The AI invents someone</span>}
                      </dd>
                      <dt className="pt-1 text-[10.5px] uppercase tracking-[0.12em] text-muted">Opening</dt>
                      <dd>
                        {openingLines.trim() ? (
                          <span className="line-clamp-2">{openingLines}</span>
                        ) : (
                          <span className="italic text-muted">The AI opens</span>
                        )}
                      </dd>
                      <dt className="pt-1 text-[10.5px] uppercase tracking-[0.12em] text-muted">Voice</dt>
                      <dd>{voiceName}</dd>
                    </dl>
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* Footer: Back, the step rail, and the forward action. */}
      <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border px-[22px] py-3 md:h-[76px] md:flex-nowrap md:px-9 md:py-0">
        {/* Back, rail, forward: flush left, centered, flush right on desktop; on a
            phone the rail takes its own row above (order-first). */}
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          className={`btn btn-text -ml-1 ${step === 0 ? "invisible" : ""}`}
          tabIndex={step === 0 ? -1 : 0}
        >
          <span aria-hidden="true">←</span> Back
        </button>

        <nav aria-label="Steps" className="order-first flex w-full justify-center md:order-none md:mx-auto md:w-auto">
          {STEPS.map((s, i) => (
            <button
              key={s.rail}
              type="button"
              onClick={() => setStep(i)}
              aria-current={i === step ? "step" : undefined}
              className="flex flex-col items-center gap-[7px] px-2 py-2 sm:px-[14px]"
            >
              <span aria-hidden="true" className={`h-px w-7 sm:w-[46px] ${i <= step ? "bg-accent" : "bg-foreground/18"}`} />
              <span
                className={`text-[10px] uppercase leading-none tracking-[0.1em] ${
                  i === step ? "text-accent-text" : "text-muted"
                }`}
              >
                {s.rail}
              </span>
            </button>
          ))}
        </nav>

        {step < LAST_STEP ? (
          <button
            type="button"
            onClick={() => setStep((s) => Math.min(LAST_STEP, s + 1))}
            className="btn btn-primary btn-compact ml-auto"
          >
            Continue <span aria-hidden="true">→</span>
          </button>
        ) : (
          <button type="button" onClick={handleStart} disabled={isStreaming} className="btn btn-primary btn-compact ml-auto">
            Begin the story <span aria-hidden="true">→</span>
          </button>
        )}
      </footer>
    </div>
  );
}
