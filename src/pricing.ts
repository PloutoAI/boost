/**
 * Token-to-dollar pricing. Bundled JSON snapshot at
 * `src/data/pricing.json` — refreshed manually when rates change.
 *
 * Why bundled, not fetched: boost's offline-only promise. Stale rates
 * are better than a network call. Surfacing the snapshot date in the
 * output lets users know what they're looking at.
 *
 * Matching: model IDs are looked up as case-insensitive substrings of
 * the entry keys. `claude-opus-4-7-20260301` matches `claude-opus-4-7`.
 * Unknown models return null — callers render "$ —" or skip the cell
 * rather than guessing.
 */
import pricingData from "./data/pricing.json" with { type: "json" };

export type ModelPricing = {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-creation tokens (5m or 1h ephemeral). */
  cache_creation: number;
  /** USD per million cache-read tokens. */
  cache_read: number;
};

export type PricingTable = Record<string, ModelPricing>;

const TABLE: PricingTable = pricingData.models as PricingTable;

export const PRICING_SNAPSHOT_DATE: string =
  (pricingData._meta as { snapshot_date?: string })?.snapshot_date ?? "unknown";

/**
 * Look up a model's pricing by its id. Returns null if the model isn't
 * recognised so callers can decide whether to omit cost or render an
 * "unknown" placeholder.
 */
export function pricingFor(modelId: string | null | undefined): ModelPricing | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  // Direct hit.
  const direct = TABLE[lower];
  if (direct) return direct;
  // Substring match — pricing entries are families, model IDs include
  // dated suffixes like `claude-haiku-4-5-20251001`.
  for (const key of Object.keys(TABLE)) {
    if (lower.includes(key)) return TABLE[key] ?? null;
  }
  return null;
}

export type TokenCounts = {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
};

/**
 * USD cost for a token breakdown on the given model. Returns null for
 * unknown models — never silently 0 (that's a meaningful "we don't
 * know" signal a 0 would hide).
 */
export function dollarsFor(counts: TokenCounts, modelId: string | null | undefined): number | null {
  const p = pricingFor(modelId);
  if (!p) return null;
  return (
    (counts.input * p.input +
      counts.output * p.output +
      counts.cache_creation * p.cache_creation +
      counts.cache_read * p.cache_read) /
    1_000_000
  );
}

/**
 * Format a USD value for display. Two decimal places under $10,
 * one above $100, integer above $10k.
 */
export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  if (amount === 0) return "$0";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  if (abs < 0.01) return `${sign}<$0.01`;
  if (abs < 10) return `${sign}$${abs.toFixed(2)}`;
  if (abs < 100) return `${sign}$${abs.toFixed(1)}`;
  if (abs < 10_000) return `${sign}$${Math.round(abs)}`;
  return `${sign}$${(abs / 1000).toFixed(1)}k`;
}
