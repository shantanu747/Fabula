"use client";

import { useRouter } from "next/navigation";
import { useStory, MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from "@/lib/story/StoryContext";

const PRESET_THEMES = [
  "Fantasy",
  "Mystery",
  "Sci-fi",
  "Fairytale",
  "Slice of life",
];

// Decorative-only, keyed by provider id. Not correctness-critical (unlike
// id/displayName, which come from the registry via useStory().providers) —
// safe to fall back to an empty string for any id this doesn't recognize.
const PROVIDER_BLURBS: Record<string, string> = {
  anthropic: "Thoughtful, literary prose.",
  openai: "Fast and versatile.",
  openrouter: "Open-weight option.",
};

function splitDisplayName(displayName: string): { name: string; vendor: string } {
  const match = displayName.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return match ? { name: match[1], vendor: match[2] } : { name: displayName, vendor: "" };
}

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

  return (
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-16 sm:py-24">
      <div className="w-full max-w-2xl">
        <header className="mb-10 text-center">
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-foreground">
            Fabula
          </h1>
          <p className="mt-3 text-base text-muted">
            Co-write a short story with an AI. Give it a spark, or don&apos;t
            — either way, you start together.
          </p>
        </header>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
          <section>
            <h2 className="text-sm font-semibold text-foreground">
              Set the scene{" "}
              <span className="font-normal text-muted">(all optional)</span>
            </h2>

            <div className="mt-4">
              <label className="mb-2 block text-sm text-muted" htmlFor="theme">
                Genre or theme
              </label>
              <input
                id="theme"
                type="text"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                disabled={isStreaming}
                placeholder="e.g. A cozy mystery in a small mountain town"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-40"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {PRESET_THEMES.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    disabled={isStreaming}
                    onClick={() => setTheme(preset)}
                    className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5">
              <label
                className="mb-2 block text-sm text-muted"
                htmlFor="characters"
              >
                Starter characters
              </label>
              <textarea
                id="characters"
                rows={2}
                value={characters}
                onChange={(e) => setCharacters(e.target.value)}
                disabled={isStreaming}
                placeholder="e.g. A retired lighthouse keeper and a dragon who's afraid of water"
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-40"
              />
            </div>

            <div className="mt-5">
              <label
                className="mb-2 block text-sm text-muted"
                htmlFor="opening"
              >
                Opening lines
              </label>
              <textarea
                id="opening"
                rows={3}
                value={openingLines}
                onChange={(e) => setOpeningLines(e.target.value)}
                disabled={isStreaming}
                placeholder="Write a line or two to set the tone, or leave this blank"
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-40"
              />
            </div>
          </section>

          <section className="mt-7 border-t border-border pt-6">
            <h2 className="text-sm font-semibold text-foreground">
              Choose who writes with you
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {providers.map((provider) => {
                const { name, vendor } = splitDisplayName(provider.displayName);
                return (
                  <label
                    key={provider.id}
                    className="flex cursor-pointer flex-col gap-1 rounded-xl border border-border bg-background p-3 text-sm has-[:checked]:border-accent has-[:checked]:ring-1 has-[:checked]:ring-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-40"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="provider"
                        checked={selectedProviderId === provider.id}
                        onChange={() => setSelectedProviderId(provider.id)}
                        disabled={isStreaming}
                        className="accent-accent"
                      />
                      <span className="font-medium text-foreground">{name}</span>
                    </span>
                    <span className="text-xs text-muted">
                      {vendor}
                      {PROVIDER_BLURBS[provider.id] ? ` · ${PROVIDER_BLURBS[provider.id]}` : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="mt-7 border-t border-border pt-6">
            <div className="flex items-baseline justify-between gap-2">
              <label className="text-sm font-semibold text-foreground" htmlFor="target-length">
                Target story length
              </label>
              <span className="text-xs text-muted">~{targetLength} paragraphs</span>
            </div>
            <input
              id="target-length"
              type="range"
              min={MIN_TARGET_LENGTH}
              max={MAX_TARGET_LENGTH}
              step={1}
              value={targetLength}
              onChange={(e) => setTargetLength(Number(e.target.value))}
              disabled={isStreaming}
              className="mt-3 w-full accent-accent disabled:opacity-40"
            />
            <p className="mt-2 text-xs text-muted">
              A gentle guide, not a hard stop — the AI leans toward wrapping up near
              this point, but nothing stops you from writing more.
            </p>
          </section>

          <section className="mt-8">
            <button
              type="button"
              onClick={handleStart}
              disabled={isStreaming}
              className="w-full rounded-xl bg-accent px-5 py-3 text-center text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            >
              Let&apos;s write →
            </button>
          </section>

          <p className="mt-5 text-center text-xs text-muted">
            No sign-up. Nothing here is saved once you close this tab. Write opening
            lines above to start the story yourself — otherwise the AI will.
          </p>
        </div>
      </div>
    </div>
  );
}
