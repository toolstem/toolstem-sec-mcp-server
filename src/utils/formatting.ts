/**
 * Formatting utilities for Toolstem SEC MCP server.
 * All helpers are pure functions and safe to use with null/undefined by guarding at call sites.
 */

/**
 * Format a large dollar value into a human-readable string with magnitude suffix.
 * Examples: 2_780_000_000_000 -> "$2.78T", 450_200_000_000 -> "$450.2B", 12_500_000 -> "$12.5M".
 */
export function formatDollars(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'N/A';
  }
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format an integer count with thousands separators.
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return Math.round(value).toLocaleString('en-US');
}

/** Round to 2 decimal places. Returns null on invalid input. */
export function round2(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Safely coerce unknown API field into a number, returning null if invalid.
 * Handles empty strings, whitespace-only strings, and booleans safely.
 */
export function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

/**
 * Compute days between two ISO date strings (or Date objects).
 * Returns null if either input is invalid.
 */
export function daysBetween(start: string | Date, end: string | Date): number | null {
  const s = typeof start === 'string' ? new Date(start) : start;
  const e = typeof end === 'string' ? new Date(end) : end;
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  return Math.round((e.getTime() - s.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * ISO date string for a UTC date N days before today.
 */
export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Check if a YYYY-MM-DD date string falls within the lookback window.
 */
export function withinLookback(dateStr: string, lookbackDays: number): boolean {
  if (!dateStr) return false;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() >= cutoff.getTime();
}

/**
 * Pad a CIK to the 10-digit zero-padded format SEC requires
 * (e.g., 320193 -> "0000320193").
 */
export function padCik(cik: string | number): string {
  const s = String(cik).replace(/^CIK/i, '').replace(/^0+/, '');
  return s.padStart(10, '0');
}

/**
 * Build the canonical SEC filing-detail URL given accession number + CIK.
 * SEC accepts accession numbers in either dashed (0000320193-25-000001) or
 * undashed (000032019325000001) form for the filing index URL; we use the
 * undashed form here as that is what the document folder uses.
 */
export function filingUrl(cik: string | number, accessionNumber: string): string {
  const cikInt = String(cik).replace(/^CIK/i, '').replace(/^0+/, '');
  const accNoDashes = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikInt}&type=&dateb=&owner=include&count=40`;
}

/**
 * Build the full filing-index URL (the directory containing all documents
 * for a single filing). Format:
 *   https://www.sec.gov/Archives/edgar/data/{cikInt}/{accNoDashes}/
 */
export function filingIndexUrl(cik: string | number, accessionNumber: string): string {
  const cikInt = String(cik).replace(/^CIK/i, '').replace(/^0+/, '');
  const accNoDashes = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/`;
}
