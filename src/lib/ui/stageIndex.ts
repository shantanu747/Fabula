/** README "Arc rail": 0–25 / 25–55 / 55–85 / 85–100% of the target length. */
export function stageIndex(ratio: number): number {
  if (ratio < 0.25) return 0;
  if (ratio < 0.55) return 1;
  if (ratio < 0.85) return 2;
  return 3;
}
