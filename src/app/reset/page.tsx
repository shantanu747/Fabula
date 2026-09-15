"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";

function ResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const response = await fetch("/api/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });

    setIsSubmitting(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Something went wrong resetting your password.");
      return;
    }
    setDone(true);
  }

  if (!token) {
    return (
      <p className="mt-8 text-[13.5px] leading-[1.7] text-foreground">
        This reset link is missing its token. Request a new one from the{" "}
        <Link href="/forgot" className="text-accent-text underline decoration-accent/50 underline-offset-2">
          forgot password
        </Link>{" "}
        page.
      </p>
    );
  }

  if (done) {
    return (
      <div className="mt-8">
        <p className="text-[13.5px] leading-[1.7] text-foreground">
          Your password has been reset. Any other signed-in sessions have been signed out.
        </p>
        <button
          type="button"
          onClick={() => router.push("/login")}
          className="btn btn-primary btn-block mt-6 py-[13px]"
        >
          Sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-6">
      <div>
        <label className="field-label mb-2" htmlFor="password">
          New password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="field text-[15px] tracking-[0.18em]"
        />
        <p className="mt-2 text-[12px] italic text-muted">At least 8 characters.</p>
      </div>

      {error && <p className="text-[13px] text-foreground">{error}</p>}

      <button type="submit" disabled={isSubmitting} className="btn btn-primary btn-block py-[13px]">
        {isSubmitting ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}

export default function Reset() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      <div className="flex w-full flex-col items-center px-4 pb-12 sm:px-6">
        <div className="w-full max-w-[520px]">
          <div className="mt-10 md:mt-14">
            <h1 className="font-heading text-[38px] font-normal leading-[1.1] text-foreground">
              Set a new password
            </h1>
            <Suspense>
              <ResetForm />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
