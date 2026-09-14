"use client";

import { useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    await fetch("/api/auth/password/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => {});
    setIsSubmitting(false);
    // Same response whether or not the address exists (ADR 0011's posture) —
    // this page always shows the same confirmation regardless of the fetch's
    // own outcome, deliberately.
    setSent(true);
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      <div className="flex w-full flex-col items-center px-4 pb-12 sm:px-6">
        <div className="w-full max-w-[520px]">
          <div className="mt-10 md:mt-14">
            <h1 className="font-heading text-[38px] font-normal leading-[1.1] text-foreground">
              Forgot your password?
            </h1>
            <p className="mt-3 text-[13.5px] leading-[1.7] text-muted">
              We&apos;ll email you a link to set a new one.
            </p>

            {sent ? (
              <p className="mt-8 text-[13.5px] leading-[1.7] text-foreground">
                If that address has an account, we&apos;ve sent a reset link. It expires in an hour.
              </p>
            ) : (
              <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-6">
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
                <button type="submit" disabled={isSubmitting} className="btn btn-primary btn-block py-[13px]">
                  {isSubmitting ? "Sending…" : "Send reset link"}
                </button>
              </form>
            )}

            <p className="mt-6 text-center text-[12.5px] text-muted">
              <Link
                href="/login"
                className="tap-target inline-block text-accent-text underline decoration-accent/50 underline-offset-2"
              >
                Back to sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
