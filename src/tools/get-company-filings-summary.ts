/**
 * Tool 1: get_company_filings_summary
 *
 * Returns a structured summary of a company's SEC filing activity, including
 * the most recent 20 filings and computed signals: filing velocity, material
 * event count, disclosure volume trend, and recent form types.
 *
 * Input:  ticker symbol (e.g. "AAPL") or zero-padded CIK (e.g. "0000320193")
 * Output: CompanyFilingsSummary
 *
 * v0.2 notes: none — signals are fully derived from the submissions index.
 */

import {
  resolveTickerOrCik,
  getCompanyFilingsIndex,
  decomposeRecentFilings,
} from '../services/edgar.js';
import { withinLookback, filingIndexUrl } from '../utils/formatting.js';

// -----------------------------------------------------------------------------
// Output types
// -----------------------------------------------------------------------------

export interface FilingSummaryRecord {
  accession_number: string;
  form: string;
  filing_date: string;
  primary_doc_description: string | null;
  items: string[];
  sec_url: string;
}

export interface FilingSignals {
  filing_velocity: 'ACCELERATING' | 'NORMAL' | 'SLOWING' | null;
  material_event_count_90d: number;
  disclosure_volume_trend: 'RISING' | 'STABLE' | 'FALLING' | null;
  latest_form_types: string[];
}

export interface CompanyFilingsSummary {
  ticker: string | null;
  cik: string;
  company_name: string | null;
  recent_filings: FilingSummaryRecord[];
  signals: FilingSignals;
  meta: {
    source: string;
    timestamp: string;
    data_delay: string;
  };
}

// -----------------------------------------------------------------------------
// Signal helpers
// -----------------------------------------------------------------------------

/**
 * Compute filing velocity by comparing last-30d count to the per-30d average
 * over the prior 365d (excluding the 30d window).
 * Returns null if history is <90 days.
 */
function computeFilingVelocity(
  filingDates: string[],
): 'ACCELERATING' | 'NORMAL' | 'SLOWING' | null {
  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const dates = filingDates
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a); // desc

  if (dates.length === 0) return null;

  const oldest = dates[dates.length - 1];
  const historyDays = (now - oldest) / MS_PER_DAY;

  // Need at least 90 days of history to be meaningful.
  if (historyDays < 90) return null;

  const cutoff30 = now - 30 * MS_PER_DAY;
  const cutoff365 = now - 365 * MS_PER_DAY;

  const recent30 = dates.filter((t) => t >= cutoff30).length;
  const prior365 = dates.filter((t) => t >= cutoff365 && t < cutoff30).length;

  // How many 30-day windows fit in the prior 335 days?
  const windows335 = (365 - 30) / 30; // ~11.17
  const avgPer30 = prior365 / windows335;

  if (avgPer30 === 0) {
    // No prior filings in the window -> if there are recent filings it's accelerating.
    return recent30 > 0 ? 'ACCELERATING' : 'NORMAL';
  }

  const ratio = recent30 / avgPer30;
  if (ratio >= 1.5) return 'ACCELERATING';
  if (ratio <= 0.5) return 'SLOWING';
  return 'NORMAL';
}

/**
 * Compare the size (bytes) of the latest 10-K to the previous 10-K.
 * RISING if +10%+, FALLING if -10% or worse, STABLE otherwise.
 * Returns null if fewer than 2 10-K filings are present.
 */
function computeDisclosureVolumeTrend(
  forms: string[],
  sizes: (number | null)[],
): 'RISING' | 'STABLE' | 'FALLING' | null {
  // Collect 10-K records in order (most recent first, as returned by EDGAR).
  const tenKs: number[] = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === '10-K') {
      const s = sizes[i];
      if (typeof s === 'number' && s > 0) {
        tenKs.push(s);
      }
    }
  }
  if (tenKs.length < 2) return null;

  const latest = tenKs[0];
  const prior = tenKs[1];
  const changeRatio = (latest - prior) / prior;

  if (changeRatio >= 0.1) return 'RISING';
  if (changeRatio <= -0.1) return 'FALLING';
  return 'STABLE';
}

// -----------------------------------------------------------------------------
// Main tool function
// -----------------------------------------------------------------------------

/**
 * Retrieve and summarize a company's SEC filing activity.
 *
 * @param input  Ticker symbol (e.g. "AAPL") or CIK (numeric or zero-padded).
 * @returns CompanyFilingsSummary with signals derived from the submissions index.
 */
export async function getCompanyFilingsSummary(input: string): Promise<CompanyFilingsSummary> {
  const resolved = await resolveTickerOrCik(input);
  if (!resolved) {
    throw new Error(`Could not resolve ticker or CIK: "${input}"`);
  }

  const { cik, ticker, title } = resolved;

  const index = await getCompanyFilingsIndex(cik);
  const allFilings = decomposeRecentFilings(index);

  // --- recent_filings: last 20 ---
  const recentFilings: FilingSummaryRecord[] = allFilings.slice(0, 20).map((f) => ({
    accession_number: f.accessionNumber,
    form: f.form,
    filing_date: f.filingDate,
    primary_doc_description: f.primaryDocDescription,
    items: f.items,
    sec_url: filingIndexUrl(cik, f.accessionNumber),
  }));

  // --- signals ---

  // filing_velocity
  const allDates = allFilings.map((f) => f.filingDate);
  const filing_velocity = computeFilingVelocity(allDates);

  // material_event_count_90d: 8-K filings in last 90d
  const material_event_count_90d = allFilings.filter(
    (f) => f.form === '8-K' && withinLookback(f.filingDate, 90),
  ).length;

  // disclosure_volume_trend: compare 10-K sizes
  const forms = allFilings.map((f) => f.form);
  const sizes = allFilings.map((f) => f.size);
  const disclosure_volume_trend = computeDisclosureVolumeTrend(forms, sizes);

  // latest_form_types: unique forms in last 90d, ordered by most recent appearance
  const seen = new Set<string>();
  const latest_form_types: string[] = [];
  for (const f of allFilings) {
    if (withinLookback(f.filingDate, 90) && !seen.has(f.form)) {
      seen.add(f.form);
      latest_form_types.push(f.form);
    }
  }

  return {
    ticker,
    cik,
    company_name: title,
    recent_filings: recentFilings,
    signals: {
      filing_velocity,
      material_event_count_90d,
      disclosure_volume_trend,
      latest_form_types,
    },
    meta: {
      source: 'sec_edgar_direct',
      timestamp: new Date().toISOString(),
      data_delay: 'live',
    },
  };
}
