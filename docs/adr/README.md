# Architecture Decision Records

This directory records the significant technical, feature, and architecture decisions made while building Fabula — the reasoning behind them, the alternatives considered, and their consequences. `docs/PRD.md` and `docs/use-cases.md` define *what* the product does; these records explain *why* it's built the way it is.

Format (lightweight [Nygard-style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)):

- **Status** — accepted, superseded, etc.
- **Context** — the problem or constraint that forced a decision.
- **Decision** — what was chosen.
- **Consequences** — what that choice makes easy, hard, or worth revisiting later.

New ADRs are numbered sequentially and are not edited after acceptance — a changed decision gets a new ADR that supersedes the old one, so the record of *why* something changed is preserved rather than overwritten.

## Index

1. [Model-agnostic provider interface](0001-model-agnostic-provider-interface.md) — the `LLMProvider` abstraction and registry pattern.
2. [Provider and model selection](0002-provider-model-selection.md) — why Claude Sonnet 5, GPT-5 mini, and Llama 3.3 70B.
3. [Streaming wire protocol](0003-streaming-wire-protocol.md) — how `/api/generate` streams prose and carries invented-metadata out of band.
4. [Strict turn-taking policy](0004-strict-turn-taking-policy.md) — one paragraph per turn, enforced server-side.
5. [Context window management](0005-context-window-management.md) — the anchor-plus-recency rolling window.
6. [Content safety defaults](0006-content-safety-defaults.md) — age-appropriate output as a prompting default, not a toggle.
7. [Client state architecture](0007-client-state-architecture.md) — cross-route story state without a database or storage APIs.
8. [Merged actions and narrative-arc pacing](0008-merged-actions-and-narrative-pacing.md) — one button per screen, the stale-closure fix, and soft-target climax/resolution steering.
9. [Accounts and persistence architecture](0009-accounts-and-persistence-architecture.md) — Neon + Drizzle, Auth.js v5 with JWT sessions, and the write-through-mirror persistence model.
10. [Shared story feed and safety](0010-shared-story-feed-and-safety.md) — logged-in-only feed, the unmoderated-content risk, disclaimer + report mitigation, and explicit non-goals.
11. [Security hardening after the v2 review](0011-security-hardening-post-review.md) — origin-resolved redirect validation, uninformative registration responses, and the shared server-side input trust boundary.
12. [Pinning npm in CI](0012-ci-npm-version-pinning.md) — why the `EBADPLATFORM`/AIX build failure was an npm major-version mismatch, not a platform-specific lockfile.
