# Design spec

The committed source the redesign ADRs (`docs/adr/0029`–`0033`) cite.

- `handoff.md` — the design handoff document: rationale, board references, and component specs
  for every phase of the redesign.
- `classical/` — the Classical design system's source stylesheet (`styles.css`) and its own
  readme, as handed off. `src/app/globals.css` is the implementation; this is the spec it was
  built from.
- `screenshots/` — one reference image per board named in the handoff and the ADRs.
- `screenshots/before/` — the two pre-redesign boards (`0a`, `0b`), kept for a before/after
  comparison. Everything else under `screenshots/` is post-redesign.

The handoff's `.dc.html` prototype is not included here — it's a 68KB single-file export with no
information the README and screenshots don't already carry. If it's ever needed for reference,
it lives in the original handoff drop the design owner has locally.
