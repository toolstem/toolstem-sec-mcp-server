/**
 * Tool 5: compare_disclosure_signals
 *
 * Side-by-side comparison of 2-5 companies across key SEC disclosure signals:
 * filing velocity, material event count (90d), red-flag count (365d), activist
 * risk, and most recent filing date. Returns derived winners for each dimension.
 *
 * Each company's signals are derived from a single getCompanyFilingsIndex() call
 * (no calls to other tools), and all lookups run in parallel via Promise.all.
 *
 * Input:  array of 2-5 ticker symbols or CIKs
 * Output: DisclosureComparison
 *
 * v0.2 notes: none — all signals are fully derived from the submissions index.
 */

import {
  resolveTickerOrCik,
  getCompanyFilingsIndex,
  decomposeRecentFilings,
  type FilingRecord,
} from '../services/edgar.js';
import { withinLookback } from '../utils/formatting.js';
import { lookupItem, type ItemSeverity } from '../data/form_8k_items.js';

// -----------------------------------------------------------------------------
// Output types
// -----------------------------------------------------------------------------

export interface CompanyDisclosureEntry {
  ticker: string | null;
  cik: string;
  company_name: string | null;
  filing_velocity: 'ACCELERATING' | 'NORMAL' | 'SLOWING' | null;
  material_event_count_90d: number;
  redflag_count_365d: number;
  activist_risk_flag: boolean;
  last_filing_date: string | null;
}

export interface DisclosureWinners {
  /** CIK of company with lowest material_event_count_90d. Ties broken by alphabetical CIK. */
  quietest_disclosure: string | null;
  /** CIK of company with highest material_event_count_90d. Ties broken by alphabetical CIK. */
  most_active: string | null;
  /** CIK of company with highest redflag_count_365d. Ties broken by alphabetical CIK. */
  most_redflags: string | null;
  /** All CIKs where activist_risk_flag is true. */
  activist_targets: string[];
}

export interface DisclosureComparison {
  companies: CompanyDisclosureEntry[];
  winners: DisclosureWinners;
  meta: {
    source: string;
    timestamp: string;
    data_delay: string;
  };
}

// -----------------------------------------------------------------------------
// Internal signal helpers (duplicated from tool 1 / tool 4 inline to avoid
// cross-tool imports — tools should be independently importable)
// -----------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const EIGHT_K_FORMS = new Set(['8-K', '8-K/A']);
const ACTIVIST_FORMS = new Set(['SC 13D', 'SC 13D/A', '13D', '13D/A']);
const SEVERITY_RANK: Record<ItemSeverity, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

function computeVelocity(
  filingDates: string[],
): 'ACCELERATING' | 'NORMAL' | 'SLOWING' | null {
  const now = Date.now();
  const dates = filingDates
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a);

  if (dates.length === 0) return null;
  const oldest = dates[dates.length - 1];
  if ((now - oldest) / MS_PER_DAY < 90) return null;

  const cutoff30 = now - 30 * MS_PER_DAY;
  const cutoff365 = now - 365 * MS_PER_DAY;
  const recent30 = dates.filter((t) => t >= cutoff30).length;
  const prior365 = dates.filter((t) => t >= cutoff365 && t < cutoff30).length;
  const windows335 = (365 - 30) / 30;
  const avgPer30 = prior365 / windows335;

  if (avgPer30 === 0) return recent30 > 0 ? 'ACCELERATING' : 'NORMAL';
  const ratio = recent30 / avgPer30;
  if (ratio >= 1.5) return 'ACCELERATING';
  if (ratio <= 0.5) return 'SLOWING';
  return 'NORMAL';
}

function isRedFlag8K(filing: FilingRecord): boolean {
  if (!EIGHT_K_FORMS.has(filing.form)) return false;
  if (filing.items.length === 0) return false;
  for (const code of filing.items) {
    const def = lookupItem(code);
    if (SEVERITY_RANK[def.severity] >= SEVERITY_RANK['RED']) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Per-company signal derivation
// -----------------------------------------------------------------------------

async function deriveCompanyEntry(input: string): Promise<CompanyDisclosureEntry> {
  const resolved = await resolveTickerOrCik(input);
  if (!resolved) {
    throw new Error(`Could not resolve ticker or CIK: "${input}"`);
  }

  const { cik, ticker, title } = resolved;
  const index = await getCompanyFilingsIndex(cik);
  const allFilings = decomposeRecentFilings(index);

  const allDates = allFilings.map((f) => f.filingDate);
  const filing_velocity = computeVelocity(allDates);

  const material_event_count_90d = allFilings.filter(
    (f) => EIGHT_K_FORMS.has(f.form) && withinLookback(f.filingDate, 90),
  ).length;

  const redflag_count_365d = allFilings.filter(
    (f) => withinLookback(f.filingDate, 365) && isRedFlag8K(f),
  ).length;

  const activist_risk_flag = allFilings.some(
    (f) => ACTIVIST_FORMS.has(f.form) && withinLookback(f.filingDate, 365),
  );

  const last_filing_date = allFilings.length > 0 ? allFilings[0].filingDate : null;

  return {
    ticker,
    cik,
    company_name: title,
    filing_velocity,
    material_event_count_90d,
    redflag_count_365d,
    activist_risk_flag,
    last_filing_date,
  };
}

// -----------------------------------------------------------------------------
// Winner derivation helpers (ties broken by alphabetical CIK — deterministic)
// -----------------------------------------------------------------------------

function pickMin(entries: CompanyDisclosureEntry[], key: 'material_event_count_90d'): string | null {
  if (entries.length === 0) return null;
  return entries.reduce((best, e) =>
    e[key] < best[key] || (e[key] === best[key] && e.cik < best.cik) ? e : best,
  ).cik;
}

function pickMax(
  entries: CompanyDisclosureEntry[],
  key: 'material_event_count_90d' | 'redflag_count_365d',
): string | null {
  if (entries.length === 0) return null;
  return entries.reduce((best, e) =>
    e[key] > best[key] || (e[key] === best[key] && e.cik < best.cik) ? e : best,
  ).cik;
}

// -----------------------------------------------------------------------------
// Main tool function
// -----------------------------------------------------------------------------

/**
 * Compare disclosure signals across 2-5 companies in parallel.
 *
 * @param inputs  Array of 2-5 ticker symbols or CIKs.
 * @returns DisclosureComparison with per-company signals and winners.
 * @throws Error if inputs.length is outside [2, 5].
 */
export async function compareDisclosureSignals(inputs: string[]): Promise<DisclosureComparison> {
  if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 5) {
    throw new Error(
      `compare_disclosure_signals requires 2-5 company identifiers; got ${Array.isArray(inputs) ? inputs.length : typeof inputs}.`,
    );
  }

  // Run all lookups in parallel to minimise wall-clock time.
  const companies = await Promise.all(inputs.map((inp) => deriveCompanyEntry(inp)));

  const quietest_disclosure = pickMin(companies, 'material_event_count_90d');
  const most_active = pickMax(companies, 'material_event_count_90d');
  const most_redflags = pickMax(companies, 'redflag_count_365d');
  const activist_targets = companies
    .filter((e) => e.activist_risk_flag)
    .map((e) => e.cik)
    .sort(); // sorted for determinism

  return {
    companies,
    winners: {
      quietest_disclosure,
      most_active,
      most_redflags,
      activist_targets,
    },
    meta: {
      source: 'sec_edgar_direct',
      timestamp: new Date().toISOString(),
      data_delay: 'live',
    },
  };
}
