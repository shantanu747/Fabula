import Link from "next/link";

const PARAGRAPHS = [
  {
    author: "writer" as const,
    text: `Mara hadn't climbed the lighthouse stairs in eleven years, not since her father died and left her the keys, the debts, and a beam that hadn't turned in a decade. She climbed them now because something in the lamp room was scratching.`,
  },
  {
    author: "ai" as const,
    provider: "Claude",
    vendor: "Anthropic",
    text: `The thing in the lamp room was not, as she'd half-expected, a gull. It was curled around the dead lens like a cat around a bowl, scales the color of rust and low tide, and when it opened one eye at her it flinched — actually flinched — from the flashlight beam. "Please," it said, in a voice like a kettle just starting to sing, "point that somewhere else."`,
  },
  {
    author: "writer" as const,
    text: `Mara did not scream, which she would later consider the single most impressive thing she'd ever done. She lowered the flashlight to the floor instead, and in the dark the creature seemed to exhale.`,
  },
  {
    author: "ai" as const,
    provider: "GPT-4o",
    vendor: "OpenAI",
    text: `"Better," it said. It unwound itself, slow, joint by joint, and she saw it was smaller than the room had made it seem — no bigger than a large dog, with wings folded wrong, like an umbrella caught in wind. "I am afraid of water," it added, with the particular dignity of a creature admitting something ridiculous. "Which is, I am aware, a poor career choice for a dragon who lives in a lighthouse."`,
  },
];

export default function Story() {
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
            <p className="mt-1 text-xs text-muted">
              🏮 Fantasy · A lighthouse keeper and a dragon afraid of water
            </p>
          </div>
          <Link
            href="/"
            className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-accent"
          >
            New story
          </Link>
        </header>

        <div className="flex flex-col gap-4">
          {PARAGRAPHS.map((p, i) => (
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
                  {p.author === "ai" ? `${p.provider}` : "You"}
                </span>
                {p.author === "ai" && (
                  <span className="text-xs text-muted">{p.vendor}</span>
                )}
              </div>
              <p className="font-serif text-[15px] leading-7 text-foreground">
                {p.text}
              </p>
            </article>
          ))}
        </div>

        <div className="mt-6 rounded-2xl border border-border bg-card p-5 shadow-sm">
          <label
            className="mb-2 block text-sm text-muted"
            htmlFor="next-paragraph"
          >
            Write the next paragraph
          </label>
          <textarea
            id="next-paragraph"
            rows={4}
            placeholder="Continue the story in your own words..."
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <div className="mt-3 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              Add to story
            </button>

            <div className="flex items-center gap-2 sm:justify-end">
              <label htmlFor="provider-switch" className="text-xs text-muted">
                AI writes as
              </label>
              <select
                id="provider-switch"
                defaultValue="anthropic"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="anthropic">Claude (Anthropic)</option>
                <option value="openai">GPT-4o (OpenAI)</option>
                <option value="openweight">Llama 3.1 (OpenRouter)</option>
              </select>
              <button
                type="button"
                className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
              >
                Continue →
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
