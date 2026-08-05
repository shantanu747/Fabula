import Link from "next/link";

const PRESET_THEMES = [
  "Fantasy",
  "Mystery",
  "Sci-fi",
  "Fairytale",
  "Slice of life",
];

const PROVIDERS = [
  {
    id: "anthropic",
    name: "Claude",
    vendor: "Anthropic",
    blurb: "Thoughtful, literary prose.",
  },
  {
    id: "openai",
    name: "GPT-4o",
    vendor: "OpenAI",
    blurb: "Fast and versatile.",
  },
  {
    id: "openweight",
    name: "Llama 3.1",
    vendor: "via OpenRouter",
    blurb: "Open-weight option.",
  },
];

export default function Home() {
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
                placeholder="e.g. A cozy mystery in a small mountain town"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {PRESET_THEMES.map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
                  >
                    {theme}
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
                placeholder="e.g. A retired lighthouse keeper and a dragon who's afraid of water"
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
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
                placeholder="Write a line or two to set the tone, or leave this blank"
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
          </section>

          <section className="mt-7 border-t border-border pt-6">
            <h2 className="text-sm font-semibold text-foreground">
              Choose who writes with you
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {PROVIDERS.map((provider, i) => (
                <label
                  key={provider.id}
                  className="flex cursor-pointer flex-col gap-1 rounded-xl border border-border bg-background p-3 text-sm has-[:checked]:border-accent has-[:checked]:ring-1 has-[:checked]:ring-accent"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="provider"
                      defaultChecked={i === 0}
                      className="accent-accent"
                    />
                    <span className="font-medium text-foreground">
                      {provider.name}
                    </span>
                  </span>
                  <span className="text-xs text-muted">
                    {provider.vendor} · {provider.blurb}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/story"
              className="flex-1 rounded-xl border border-border px-5 py-3 text-center text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              I&apos;ll write the first paragraph
            </Link>
            <Link
              href="/story"
              className="flex-1 rounded-xl bg-accent px-5 py-3 text-center text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
            >
              Get me started →
            </Link>
          </section>

          <p className="mt-5 text-center text-xs text-muted">
            No sign-up. Nothing here is saved once you close this tab.
          </p>
        </div>
      </div>
    </div>
  );
}
