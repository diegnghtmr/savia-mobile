export function percentOf(actual: bigint, target: bigint) {
  if (target <= 0n) return "No aplica";
  const magnitude = (actual < 0n ? -actual : actual) * 10000n;
  const rounded = (magnitude + target / 2n) / target;
  return `${actual < 0n && rounded > 0n ? "−" : ""}${rounded / 100n},${String(rounded % 100n).padStart(2, "0")} %`;
}
