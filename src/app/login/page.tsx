"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { AppHeader } from "@/components/AppHeader";
import { safeCallbackUrl } from "@/lib/auth/callbackUrl";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sanitized at the point of use, not here — safeCallbackUrl needs the real origin,
  // and `window` isn't available while this renders on the server.
  const rawCallbackUrl = searchParams.get("callbackUrl");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setIsSubmitting(false);
    if (result?.error) {
      setError("Incorrect email or password.");
      return;
    }
    router.push(safeCallbackUrl(rawCallbackUrl, window.location.origin));
  }

  return (
    <div className="w-full max-w-sm">
      <AppHeader />

      <div className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <h1 className="font-serif text-2xl font-semibold text-foreground">Sign in</h1>
        <p className="mt-2 text-sm text-muted">
          Save your stories and share them with other Writers.
        </p>

        <button
          type="button"
          onClick={() =>
            signIn("google", {
              callbackUrl: safeCallbackUrl(rawCallbackUrl, window.location.origin),
            })
          }
          className="mt-6 w-full rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent"
        >
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-muted">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="mb-2 block text-sm text-muted" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm text-muted" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-1 w-full rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-muted">
          New here?{" "}
          <Link href="/signup" className="tap-target inline-block font-medium text-accent">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function Login() {
  return (
    <div className="flex flex-1 flex-col items-center bg-background px-4 py-6 sm:py-10">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
