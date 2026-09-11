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
    <div className="w-full max-w-[520px]">
      <div className="mt-10 md:mt-14">
        <h1 className="font-heading text-[38px] font-normal leading-[1.1] text-foreground">Sign in</h1>
        <p className="mt-3 text-[13.5px] leading-[1.7] text-muted">
          Keep your stories, and share the ones worth reading.
        </p>

        <button
          type="button"
          onClick={() =>
            signIn("google", {
              callbackUrl: safeCallbackUrl(rawCallbackUrl, window.location.origin),
            })
          }
          className="btn btn-secondary btn-block mt-7 py-3 font-body text-[13px] font-normal"
        >
          Continue with Google
        </button>

        <div className="my-6 flex items-center gap-[14px] text-[11.5px] italic text-muted">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div>
            <label className="field-label mb-2" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field text-[15px]"
            />
          </div>
          <div>
            <label className="field-label mb-2" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field text-[15px] tracking-[0.18em]"
            />
          </div>

          {error && <p className="text-[13px] text-foreground">{error}</p>}

          <button type="submit" disabled={isSubmitting} className="btn btn-primary btn-block py-[13px]">
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-[12.5px] text-muted">
          New here?{" "}
          <Link
            href="/signup"
            className="tap-target inline-block text-accent-text underline decoration-accent/50 underline-offset-2"
          >
            Create an account
          </Link>
        </p>

        <p className="mt-8 border-t border-border pt-6 text-center text-[12px] italic leading-[1.7] text-muted">
          You never needed an account to write. This only saves what you wrote.
        </p>
      </div>
    </div>
  );
}

export default function Login() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      <div className="flex w-full flex-col items-center px-4 pb-12 sm:px-6">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
