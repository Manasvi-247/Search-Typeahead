/**
 * Canonical query normalization — MUST be identical at ingest time and at query time,
 * otherwise prefix lookups won't line up with stored keys.
 *
 * Handles the assignment's "mixed-case input" requirement (ass.txt:66) by lower-casing,
 * and avoids whitespace mismatches by trimming + collapsing internal runs of whitespace.
 */
export function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}
