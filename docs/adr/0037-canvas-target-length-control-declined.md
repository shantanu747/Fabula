# 37. Canvas target-length control: declined again

## Status

Accepted. Reaffirms ADR 0031's removal of the target-length slider.

## Context

ADR 0031 removed the target-length slider from the story canvas: the boards show none, and
neither `docs/PRD.md` nor `docs/use-cases.md` asks for adjusting the target after a story starts.
`docs/plans/v4/08-ui-redesign-followups.md` flagged this as one of three deliberately-deferred
handoff intents needing an explicit revisit rather than staying an unrecorded omission, and
offered a concrete way to build it if wanted: a visually hidden `<input type="range">` driving
the arc rail's existing 210px scale (`ArcRail`, `src/app/story/page.tsx`) — the same pattern the
start flow's own Length step already uses for its ruler.

## Decision

Leave it out. Nothing about the boards, the PRD, or the use cases changed since ADR 0031; the
reasoning that decided it then still holds. `StoryContext.setTargetLength` stays exported — the
start flow's Length step (`src/app/page.tsx`) is its only caller today, and moving target length
off the canvas didn't touch that. `src/app/story/page.tsx` never imported `setTargetLength` to
begin with, so there was no dead import there to delete.

## Consequences

- No code changes from this ADR. It exists to close the item as a decision, not a silent gap.
- If a use case for mid-story length adjustment appears later, the arc rail is still the
  documented place to add the control, and the pattern (hidden range input, visible only to
  assistive tech) is already proven in the start flow.
