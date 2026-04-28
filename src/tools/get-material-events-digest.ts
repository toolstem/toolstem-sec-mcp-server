/**
 * Tool 4: get_material_events_digest  (premium — $0.02 per call)
 *
 * Fetches all 8-K and 8-K/A filings for a company within a configurable
 * lookback window and maps each filing's item codes to plain-English labels,
 * categories, and severity ratings. Returns a ranked digest of material events
 * with red-flag counts and per-category tallies.
 *
 * Item codes come directly from the SEC submissions index (no additional HTTP
 * calls required). Severity is derived from src/data/form_8k_items.ts.
 *
 * Input:  ticker or CIK, optional lookbackDays (default 365)
 * Output: MaterialEventsDigest
 *
 * v0.2 note: A bonus enhancement would fetch each filing's primary HTML document
 * and extract the item-summary paragraphs to provide natural-language descriptions
 * alongside the structured item codes. Deferred to v0.2 to keep v0.1 cost-free
 * on HTTP calls beyond the submissions index.
 */

import {
  resolveTickerOrCik,
  getCompanyFilingsIndex,
  decomposeRecentFilings,
} from '../services/edgar.js';
import { withinLookback, filingIndexUrl } from '../utils/formatting.js';
import { lookupItem, type ItemSeverity } from '../data/form_8k_items.js';

// -----------------------------------------------------------------------------
// Output types
// -----------------------------------------------------------------------------

export interface MaterialEventItem {
  code: string;
  label: string;
  category: string;
  severity: ItemSeverity;
}

export interface MaterialEvent {
  accession_number: string;
  filing_date: string;
  form: string;
  items: MaterialEventItem[];
  sec_url: string;
  overall_severity: ItemSeverity;
}

export interface MaterialEventsDigest {
  ticker: string | null;
  cik: string;
  company_name: string | null;
  lookback_days: number;
  events: MaterialEvent[];
  /** Per-category event count across all events in the window. */
  category_counts: Record<string, number>;
  /** Count of events whose overall_severity is RED. */
  redflag_count: number;
  meta: {
    source: string;
    timestamp: string;
    data_delay: string;
  };
}

// Severity ordering for worst-case comparison (higher = more severe).
const SEVERITY_RANK: Record<ItemSeverity, number> = {
  GREEN: 0,
  YELLOW: 1,
  RED: 2,
};

function worstSeverity(severities: ItemSeverity[]): ItemSeverity {
  if (severities.length === 0) return 'GREEN';
  let worst: ItemSeverity = 'GREEN';
  for (const s of severities) {
    if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) {
      worst = s;
    }
  }
  return worst;
}

const EIGHT_K_FORMS = new Set(['8-K', '8-K/A']);

// -----------------------------------------------------------------------------
// Main tool function
// -----------------------------------------------------------------------------

/**
 * Build a digest of material events (8-K/8-K/A filings) for a company.
 *
 * This is a premium tool ($0.02 per call). The item data is pulled entirely
 * from the submissions index — no per-filing HTTP requests are made in v0.1.
 *
 * @param input        Ticker symbol or CIK.
 * @param lookbackDays Number of calendar days to include (default 365).
 * @returns MaterialEventsDigest sorted by filing date descending.
 */
export async function getMaterialEventsDigest(
  input: string,
  lookbackDays: number = 365,
): Promise<MaterialEventsDigest> {
  const resolved = await resolveTickerOrCik(input);
  if (!resolved) {
    throw new Error(`Could not resolve ticker or CIK: "${input}"`);
  }

  const { cik, ticker, title } = resolved;

  const index = await getCompanyFilingsIndex(cik);
  const allFilings = decomposeRecentFilings(index);

  // Filter to 8-K / 8-K/A filings within the lookback window.
  const eightKFilings = allFilings.filter(
    (f) => EIGHT_K_FORMS.has(f.form) && withinLookback(f.filingDate, lookbackDays),
  );

  const category_counts: Record<string, number> = {};
  let redflag_count = 0;

  // Build structured events sorted by filing_date descending (EDGAR already
  // returns filings newest-first, so sort is a safety step).
  const events: MaterialEvent[] = eightKFilings
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate))
    .map((f) => {
      const mappedItems: MaterialEventItem[] = f.items.map((code) => {
        const def = lookupItem(code);
        return {
          code: def.code,
          label: def.label,
          category: def.category,
          severity: def.severity,
        };
      });

      const overall_severity = worstSeverity(mappedItems.map((i) => i.severity));

      // Tally category counts.
      for (const item of mappedItems) {
        category_counts[item.category] = (category_counts[item.category] ?? 0) + 1;
      }

      return {
        accession_number: f.accessionNumber,
        filing_date: f.filingDate,
        form: f.form,
        items: mappedItems,
        sec_url: filingIndexUrl(cik, f.accessionNumber),
        overall_severity,
      };
    });

  // Count red-flag events after building the list so the sort is applied.
  redflag_count = events.filter((e) => e.overall_severity === 'RED').length;

  return {
    ticker,
    cik,
    company_name: title,
    lookback_days: lookbackDays,
    events,
    category_counts,
    redflag_count,
    meta: {
      source: 'sec_edgar_direct',
      timestamp: new Date().toISOString(),
      data_delay: 'live',
    },
  };
}
