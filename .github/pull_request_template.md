## Context

<!-- What problem is this solving, and why now? Link the use case in docs/use-cases.md
     or the section of docs/PRD.md this serves. If it's a bug, what was the symptom? -->

## Approach

<!-- How does the change work, and what did you consider and reject? If this made a
     non-obvious technical or architectural decision, it needs an ADR under docs/adr/
     — link it here rather than explaining it twice. -->

## Testing

<!-- What proves this works? Name the specs, and say what you exercised by hand.
     "Tests pass" is not an answer; which behaviour is now covered that wasn't? -->

- [ ] `npm run lint`, `npm test`, and `npm run build` pass
- [ ] New behaviour has a test that fails without the change
- [ ] UI changes checked at ~375px as well as desktop (see AGENTS.md)
- [ ] Schema changes have a migration, and it applies to a database with existing rows

## Risk

<!-- What could this break, and how would you know? What's the rollback?
     If it touches the provider interface, persistence, or the streaming
     protocol, say so explicitly. -->

## Screenshots

<!-- For UI changes: before and after, mobile and desktop. Delete if not applicable. -->
