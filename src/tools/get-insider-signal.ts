/**
 * Tool 2: get_insider_signal
 *
 * Probes recent Form 3/4/4A insider filings for a company and returns a
 * signal about insider activity within a configurable lookback window.
 *
 * Input:  ticker or CIK, optional lookbackDays (default 90)
 * Output: InsiderSignal
 *
 * v0.1 limitation: insider_signal is set to null and buy_count/sell_count
 * are both 0. Parsing Form 4 XML to derive transaction direction (buy vs sell)
 * and share counts requires fetching each filing's primary XML document, which
 * is deferred to v0.2. See v0.2 note below.
 *
 * v0.2 plan: For each Form 4 accessionNumber, call getFilingDocument() to
 * retrieve the ownershipDocument XML, then parse <transactionAcquiredDisposedCode>
 * ('A' = acquisition / buy, 'D' = disposition / sell) and
 * <transactionShares> to compute direction-aware counts and net share deltas.
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

export interface InsiderFilingRef {
  accession_number: string;
  filing_date: string;
  sec_url: string;
}

export interface InsiderSignal {
  ticker: string | null;
  cik: string;
  company_name: string | null;
  lookback_days: number;
  /**
   * Direction-aware signal. null in v0.1 — Form 4 XML parsing ships in v0.2.
   */
  insider_signal: 'STRONG_BUYING' | 'BUYING' | 'NEUTRAL' | 'SELLING' | 'STRONG_SELLING' | null;
  /**
   * Buys minus sells. 0 in v0.1 pending Form 4 XML parsing in v0.2.
   */
  net_transaction_count: number;
  buy_count: number;
  sell_count: number;
  recent_insider_filings: InsiderFilingRef[];
  meta: {
    source: string;
    timestamp: string;
    data_delay: string;
  };
}

// Ownership form types that indicate insider activity.
const INSIDER_FORMS = new Set(['3', '4', '4/A']);

// -----------------------------------------------------------------------------
// Main tool function
// -----------------------------------------------------------------------------

/**
 * Retrieve insider filing activity for a company.
 *
 * @param input        Ticker symbol or CIK.
 * @param lookbackDays Number of calendar days to look back (default 90).
 * @returns InsiderSignal with filing counts; direction-aware signal deferred to v0.2.
 */
export async function getInsiderSignal(
  input: string,
  lookbackDays: number = 90,
): Promise<InsiderSignal> {
  const resolved = await resolveTickerOrCik(input);
  if (!resolved) {
    throw new Error(`Could not resolve ticker or CIK: "${input}"`);
  }

  const { cik, ticker, title } = resolved;

  const index = await getCompanyFilingsIndex(cik);
  const allFilings = decomposeRecentFilings(index);

  // Filter to insider-form filings within the lookback window.
  const insiderFilings = allFilings.filter(
    (f) => INSIDER_FORMS.has(f.form) && withinLookback(f.filingDate, lookbackDays),
  );

  // Build the reference list (last 20).
  const recent_insider_filings: InsiderFilingRef[] = insiderFilings.slice(0, 20).map((f) => ({
    accession_number: f.accessionNumber,
    filing_date: f.filingDate,
    sec_url: filingIndexUrl(cik, f.accessionNumber),
  }));

  // v0.1 limitation: we cannot determine buy/sell direction without parsing
  // the Form 4 XML for each filing (ownershipDocument > nonDerivativeTable or
  // derivativeTable > transactionAcquiredDisposedCode). This is deferred to v0.2.
  //
  // Per spec instruction 2: when filing count is 0, signal is definitively NEUTRAL
  // ("we checked and there is no insider activity"). For any non-zero count, signal
  // is null in v0.1 ("we don't know direction yet"). These are semantically different.
  const insider_signal: InsiderSignal['insider_signal'] =
    insiderFilings.length === 0 ? 'NEUTRAL' : null;
  const net_transaction_count = 0;
  const buy_count = 0;
  const sell_count = 0;

  return {
    ticker,
    cik,
    company_name: title,
    lookback_days: lookbackDays,
    insider_signal,
    net_transaction_count,
    buy_count,
    sell_count,
    recent_insider_filings,
    meta: {
      source: 'sec_edgar_direct',
      timestamp: new Date().toISOString(),
      data_delay: 'live',
    },
  };
}
