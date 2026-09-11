/**
 * Registry display names read "Claude (Anthropic)". The UI sets the model name
 * and the vendor separately (README: provider rows, the "Next voice" switcher),
 * so split once here rather than in each screen.
 */
export function splitDisplayName(displayName: string): { name: string; vendor: string } {
  const match = displayName.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return match ? { name: match[1], vendor: match[2] } : { name: displayName, vendor: "" };
}
