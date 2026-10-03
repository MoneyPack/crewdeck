/**
 * Token/cost HUD: scrape what agent CLIs print about usage.
 * ponytail: regex over output; agents disagree on format, so we take the *max* seen per
 * dimension (they print cumulative totals), never a sum.
 */
export interface Usage {
  /** Cumulative USD if the CLI printed any. */
  usd: number | null;
  /** Cumulative tokens if the CLI printed any. */
  tokens: number | null;
}

const USD = /\$\s?(\d{1,6}(?:\.\d{1,4})?)/g;
// "12.3k tokens", "tokens used: 45,210", "Total tokens: 1,204". A number glued to "$" or a decimal is a price, not tokens.
const TOK =
  /tokens?\s*(?:used)?\s*[:=]\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?k?)|(?<![$\d.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?k?)\s*(?:total\s+)?tokens?\b/gi;

function num(s: string): number {
  const k = /k$/i.test(s);
  const n = Number(s.replace(/,/g, '').replace(/k$/i, ''));
  return k ? n * 1000 : n;
}

/** Fold a chunk of (ANSI-stripped) output into `prev`. */
export function scanUsage(prev: Usage, text: string): Usage {
  let { usd, tokens } = prev;
  for (const m of text.matchAll(USD)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v < 10_000) usd = usd === null ? v : Math.max(usd, v);
  }
  for (const m of text.matchAll(TOK)) {
    const v = num(m[1] ?? m[2] ?? '');
    if (Number.isFinite(v) && v > 0 && v < 1e9) tokens = tokens === null ? v : Math.max(tokens, v);
  }
  return usd === prev.usd && tokens === prev.tokens ? prev : { usd, tokens };
}

export const NO_USAGE: Usage = { usd: null, tokens: null };

export function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n);
}

