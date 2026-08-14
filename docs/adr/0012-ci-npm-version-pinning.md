# 12. Pinning npm in CI rather than inheriting Node's bundled version

## Status

Accepted.

## Context

The GitHub Actions workflow added alongside the v2 accounts work failed on its first run, at `npm ci`, before reaching lint, test, or build:

```
npm error code EBADPLATFORM
npm error notsup Unsupported platform for @esbuild/aix-ppc64@0.28.2: wanted {"os":"aix","cpu":"ppc64"} (current: {"os":"linux","cpu":"x64"})
```

The error names an AIX/ppc64 binary on a Linux x64 runner, which invites an incorrect diagnosis — that the lockfile was generated on the wrong platform and should be regenerated on Linux, or that platform checks should be disabled with `engine-strict=false`. Both readings are wrong and are recorded here because the error text will keep suggesting them. npm lockfiles are cross-platform by design: esbuild ships roughly twenty-five per-platform binary packages and every lockfile lists all of them, each guarded by `os`/`cpu` and marked `optional`, with npm filtering at install time. That is what makes one lockfile serve a macOS laptop and a Linux runner. `engine-strict` governs the `engines` field — Node and npm version bounds — and has nothing to do with `os`/`cpu` filtering.

Two distinct problems were actually in play, and only diagnosing both explains the failure.

First, the lockfile was genuinely corrupt. Twenty-seven entries under `node_modules/vitest/` carried `"extraneous": true` and, critically, lacked `"optional": true` — twenty-six of them platform-gated binaries. The identical esbuild 0.28.2 subtree under `node_modules/tsx/` was labelled correctly (`dev` + `optional`), which is what identifies this as corruption rather than normal npm output: it comes from `npm install` recording a stale `node_modules` tree rather than from the resolver. Stripped of `optional`, those entries read as *required* installs, so a strict npm tries to fetch the AIX binary on Linux and fails on the first one alphabetically.

Second, and load-bearing: the lockfile is authored by **npm 11** locally, while the workflow's `node-version: 22` bundles **npm 10**. npm 10 rejects the corrupt entries with `EBADPLATFORM`; npm 11 tolerates them. Regenerating the lockfile alone does not fix CI, because npm 10 and npm 11 resolve this dependency set into *different trees* — given a clean npm 11 lockfile, npm 10 fails a second way, with `EUSAGE` "can only install packages when your package.json and package-lock.json are in sync."

This was established by reproducing both npm versions against both lockfiles rather than by inference:

| | npm 10.9 | npm 11.12 |
|---|---|---|
| **committed lockfile** | `EBADPLATFORM` — the observed CI failure | all steps pass |
| **regenerated lockfile** | `EUSAGE` out-of-sync | all steps pass |

Worth noting for anyone re-running this experiment: `npm ci --os=linux --cpu=x64` is *not* a faithful simulation of a Linux runner. npm 11 accepts those flags and reports success where a real npm 10 run fails, and npm 10 ignores them outright, reporting the host platform. The mismatch only surfaces by running the actual npm major.

## Decision

**Pin npm explicitly in CI** with `npm i -g npm@11` between `setup-node` and `npm ci`, and **regenerate the lockfile** with `npm install --package-lock-only`.

Pinning is the change that fixes the build; regenerating removes real corruption and is worth doing on its own merits. The regeneration is safe to take in the same commit because it produces **zero version changes** — it removes the 27 malformed entries and adds 6 correct ones, touching classification metadata only.

Pinning npm was chosen over the alternative of bumping `node-version` until the bundled npm happens to be 11. Which npm ships with which Node release is an implicit coupling that no longer reads as load-bearing once the build is green, so a future routine Node bump could silently reintroduce the mismatch and resurrect an error message that points at esbuild and AIX rather than at npm. An explicit pin states the actual requirement — *this lockfile needs npm 11* — at the point where it matters.

Regenerating the lockfile with npm 10 to match Node 22 was rejected as the wrong direction: it would pin the repo to the older resolver and leave every developer's local `npm install` free to rewrite the lockfile back into a form CI cannot consume.

## Consequences

- The npm major is now stated in two places that must agree: the `npm i -g npm@11` step and whatever developers run locally. There is no mechanical enforcement — no `packageManager` field, no `engines.npm` constraint — so a contributor on npm 10 or a future npm 12 can still author a lockfile CI will reject. Adding `"packageManager": "npm@11.x"` to `package.json` for Corepack, or `engines.npm`, is the natural hardening step if that happens; it was not done here because it changes how every contributor's npm behaves and is broader than fixing a red build.
- `npm i -g npm@11` runs on every CI invocation, costing a few seconds and taking a dependency on the npm registry before `npm ci` even starts. That is accepted over the alternative of a silently drifting toolchain.
- The corrupt lockfile entries are gone, but nothing prevents them recurring: they originate from `npm install` reading a stale `node_modules`. A clean `rm -rf node_modules` before dependency changes, or preferring `npm ci`, avoids re-recording that state. This is the underlying hygiene issue that the pin does not address.
- CI still has no Postgres service, and this is deliberate rather than an oversight — worth recording since the placeholder `DATABASE_URL` pointing at `localhost:5432` looks like a latent failure. `getDb()` constructs the Neon client lazily and `NextAuth()` takes its config as a function, so nothing connects during `next build`; the build marks all 16 routes dynamic and prerenders no database query. Should any page ever become statically prerendered while reading from the database, the build will begin failing with a connection error and a real service container will be needed.
- The workflow's existing comment claims the API-key env vars are touched "at module scope" during build. That was already imprecise before this change — provider clients are constructed lazily, mirroring `getDb()` — and remains so; it is left alone as out of scope for a CI fix, but it should not be read as a statement about how the providers actually initialize.
