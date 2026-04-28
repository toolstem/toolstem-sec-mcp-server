/**
 * Tool 3: get_institutional_signal
 *
 * Probes a company's SEC submissions index for signs of institutional and
 * activist investor activity. Returns an activist risk flag derived from
 * SC 13D filings, plus a placeholder for institutional accumulation signal
 * (deferred to v0.2).
 *
 * Input:  ticker or CIK, optional quartersBack (default 4)
 * Output: InstitutionalSignal
 *
 * v0.1 limitation: institutional_signal is null and recent_13f_count is 0.
 * True 13F-HR holdings data requires either fetching and parsing each
 * institution's quarterly XBRL/XML filing to identify holdings of this company,
 * or using the SEC EDGAR full-text-search API. Both approaches are deferred to
 * v0.2.
 *
 * v0.2 plan: Use the EDGAR full-text-search API
 * (https://efts.sec.gov/LATEST/search-index?q=<CIK>&dateRange=custom&...) to
 * locate 13F-HR filings that cite this company's CIK in their XML holdings
 * table, then parse the XBRL to extract share counts and aggregate across
 * institutions to derive ACCUMULATING / HOLDING / DISTRIBUTING.
 *
 * activist_risk_flag IS implemented in v0.1: any SC 13D or 13D/A in the last
 * 365 days triggers this flag.
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

export interface ThirteenDFilingRef {
  accession_number: string;
  filing_date: string;
  form: string;
  sec_url: string;
}

export interface InstitutionalSignal {
  ticker: string | null;
  cik: string;
  company_name: string | null;
  quarters_back: number;
  /**
   * Direction of institutional flow. null in v0.1 — quarterly 13F XBRL/XML
   * parsing ships in v0.2.
   */
  institutional_signal: 'ACCUMULATING' | 'HOLDING' | 'DISTRIBUTING' | null;
  /**
   * Count of 13F-HR filings naming this company in the lookback window.
   * 0 in v0.1 pending v0.2 implementation.
   */
  recent_13f_count: number;
  /** True if any SC 13D or 13D/A was filed in the last 365 days. */
  activist_risk_flag: boolean;
  recent_13d_filings: ThirteenDFilingRef[];
  meta: {
    source: string;
    timestamp: string;
    data_delay: string;
  };
}

// Forms that signal activist / large-holder disclosure.
const ACTIVIST_FORMS = new Set(['SC 13D', 'SC 13D/A', '13D', '13D/A']);

// -----------------------------------------------------------------------------
// Main tool function
// -----------------------------------------------------------------------------

/**
 * Retrieve institutional and activist investor signals for a company.
 *
 * @param input        Ticker symbol or CIK.
 * @param quartersBack Number of calendar quarters to look back (default 4 ≈ 1 year).
 * @returns InstitutionalSignal; activist_risk_flag is live; institutional_signal deferred to v0.2.
 */
export async function getInstitutionalSignal(
  input: string,
  quartersBack: number = 4,
): Promise<InstitutionalSignal> {
  const resolved = await resolveTickerOrCik(input);
  if (!resolved) {
    throw new Error(`Could not resolve ticker or CIK: "${input}"`);
  }

  const { cik, ticker, title } = resolved;

  const index = await getCompanyFilingsIndex(cik);
  const allFilings = decomposeRecentFilings(index);

  // Activist risk: any SC 13D / 13D/A in the last 365 days.
  const activist13d = allFilings.filter(
    (f) => ACTIVIST_FORMS.has(f.form) && withinLookback(f.filingDate, 365),
  );
  const activist_risk_flag = activist13d.length > 0;

  const recent_13d_filings: ThirteenDFilingRef[] = activist13d.slice(0, 10).map((f) => ({
    accession_number: f.accessionNumber,
    filing_date: f.filingDate,
    form: f.form,
    sec_url: filingIndexUrl(cik, f.accessionNumber),
  }));

  // v0.1 limitation: institutional_signal and recent_13f_count require
  // cross-filing analysis (parsing each institution's 13F-HR holdings XML to
  // find entries for this CIK). Full implementation ships in v0.2.
  const institutional_signal: InstitutionalSignal['institutional_signal'] = null;
  const recent_13f_count = 0;

  return {
    ticker,
    cik,
    company_name: title,
    quarters_back: quartersBack,
    institutional_signal,
    recent_13f_count,
    activist_risk_flag,
    recent_13d_filings,
    meta: {
      source: 'sec_edgar_direct',
      timestamp: new Date().toISOString(),
      data_delay: 'live',
    },
  };
}
