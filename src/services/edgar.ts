/**
 * SEC EDGAR API client.
 *
 * The SEC's fair-access policy is non-negotiable:
 *   - Maximum 10 requests/second per IP, regardless of number of machines
 *   - Every request MUST include a User-Agent header identifying who you are
 *     and how to reach you (per SEC policy)
 *   - Failure to comply will cause your IP to be blocked
 *
 * This client enforces these rules at the only place they can be enforced —
 * the single shared rate limiter — so that any consumer (tools, actor, tests)
 * automatically stays compliant.
 *
 * We target 8 rps with a sliding-window limiter (2 rps under SEC's 10 rps
 * ceiling for safety margin), max burst of 10, and concurrency of 4.
 *
 * Endpoints used:
 *   - https://www.sec.gov/files/company_tickers.json (ticker -> CIK lookup)
 *   - https://data.sec.gov/submissions/CIK{cik}.json (filings index)
 *   - https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json (XBRL facts)
 *   - https://www.sec.gov/cgi-bin/browse-edgar (Form 4 / 13F search via Atom)
 *
 * All methods return null on empty/errored responses so callers can handle
 * graceful degradation. Network errors are retried with exponential backoff
 * (3 attempts, 250ms / 1000ms / 4000ms) for transient 429/5xx; 4xx other
 * than 429 fail fast.
 */

import { padCik } from '../utils/formatting.js';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const SEC_DATA_BASE = 'https://data.sec.gov';
const SEC_WWW_BASE = 'https://www.sec.gov';

/** Hard cap from SEC. We target 8 rps to leave a 2 rps safety margin. */
const TARGET_RPS = 8;
/** Max simultaneous in-flight requests. */
const MAX_CONCURRENCY = 4;
/** Max retries on transient failure (429 / 5xx). */
const MAX_RETRIES = 3;
/** Per-request HTTP timeout (ms). */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Compose the SEC-required User-Agent header.
 * SEC asks for a string identifying your organization + a contact email.
 * We always identify the package and embed a contact email which can be
 * overridden via the SEC_USER_AGENT_CONTACT env var if Toolstem ever
 * delegates operation to a partner.
 */
function buildUserAgent(): string {
  const contact = process.env.SEC_USER_AGENT_CONTACT?.trim() || 'admin@toolstem.com';
  return `Toolstem MCP Server (${contact})`;
}

// -----------------------------------------------------------------------------
// Sliding-window rate limiter
// -----------------------------------------------------------------------------

/**
 * Sliding-window rate limiter that admits up to `rps` requests per rolling
 * 1000ms window. Combined with a concurrency semaphore to bound parallelism.
 *
 * Why sliding-window vs. token bucket: SEC enforces by IP and looks at
 * absolute requests per second. A token bucket can pass `rps` requests in
 * the first 100ms of a window and another `rps` requests in the last 100ms
 * of the next window, which is 2*rps inside a 200ms span — and SEC measures
 * a true 1-second sliding window. Sliding-window matches what they enforce.
 */
class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly rps: number,
    private readonly windowMs = 1000,
  ) {}

  async acquire(): Promise<void> {
    while (true) {
      this.cleanup();
      if (this.timestamps.length < this.rps) {
        this.timestamps.push(Date.now());
        return;
      }
      // Wait until the oldest in-window timestamp falls out of the window.
      const earliest = this.timestamps[0];
      const wait = Math.max(1, this.windowMs - (Date.now() - earliest));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== resolve);
          resolve();
        }, wait);
        // Allow the process to exit cleanly even if a waiter is pending.
        timer.unref?.();
        this.waiters.push(resolve);
      });
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }
}

class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];
  constructor(max: number) {
    this.available = max;
  }
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
  }
  release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// Module-level singletons. ALL outbound SEC traffic from this process passes
// through these, so even concurrent tool calls from the actor / MCP server
// stay under the limit on a single IP.
const limiter = new SlidingWindowLimiter(TARGET_RPS);
const semaphore = new Semaphore(MAX_CONCURRENCY);

// -----------------------------------------------------------------------------
// Core fetch with retry + rate limit + timeout
// -----------------------------------------------------------------------------

interface FetchOptions {
  /** Optional Accept header. SEC JSON endpoints want application/json. */
  accept?: string;
  /** Optional override for the request timeout (ms). */
  timeoutMs?: number;
}

async function rateLimitedFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  await semaphore.acquire();
  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await limiter.acquire();
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': buildUserAgent(),
            // SEC's data.sec.gov endpoints serve gzip; node fetch decodes
            // automatically. Explicitly request JSON for clarity.
            Accept: opts.accept ?? 'application/json',
            // SEC also requests a host-identifying header; node sets Host
            // automatically. We don't override.
          },
        });
        clearTimeout(timer);
        // 429 / 5xx are retryable. 4xx other than 429 fail fast.
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < MAX_RETRIES) {
            const backoff = 250 * Math.pow(4, attempt); // 250 / 1000 / 4000 ms
            await new Promise((r) => {
              const t = setTimeout(r, backoff);
              t.unref?.();
            });
            continue;
          }
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        // Abort, network error, DNS — retry with backoff.
        if (attempt < MAX_RETRIES) {
          const backoff = 250 * Math.pow(4, attempt);
          await new Promise((r) => {
            const t = setTimeout(r, backoff);
            t.unref?.();
          });
          continue;
        }
        throw err;
      }
    }
    // Should be unreachable; final fallback.
    throw lastError instanceof Error ? lastError : new Error('SEC fetch failed');
  } finally {
    semaphore.release();
  }
}

async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T | null> {
  const res = await rateLimitedFetch(url, opts);
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function getText(url: string, opts: FetchOptions = {}): Promise<string | null> {
  const res = await rateLimitedFetch(url, { accept: 'text/plain', ...opts });
  if (!res.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface CompanyTickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

/**
 * SEC publishes a single 12 MB JSON file mapping every ticker -> CIK.
 * We cache it in memory for the life of the process. Refresh would require
 * a process restart; for an actor that's fine because each run is a fresh
 * process.
 */
let _tickerCache: Map<string, CompanyTickerRow> | null = null;

export async function getTickerToCikMap(): Promise<Map<string, CompanyTickerRow>> {
  if (_tickerCache) return _tickerCache;
  const url = `${SEC_WWW_BASE}/files/company_tickers.json`;
  const data = await getJson<Record<string, CompanyTickerRow>>(url);
  const map = new Map<string, CompanyTickerRow>();
  if (data && typeof data === 'object') {
    for (const row of Object.values(data)) {
      if (row && typeof row === 'object' && row.ticker) {
        map.set(row.ticker.toUpperCase(), row);
      }
    }
  }
  _tickerCache = map;
  return map;
}

/** Reset the in-memory ticker cache. Used by tests. */
export function _resetTickerCacheForTests(): void {
  _tickerCache = null;
}

/**
 * Resolve a ticker (e.g., "AAPL") OR a numeric CIK (e.g., "320193" or
 * "0000320193") to a normalized CIK + company info. Returns null if not found.
 */
export async function resolveTickerOrCik(input: string): Promise<{
  cik: string;
  cikInt: number;
  ticker: string | null;
  title: string | null;
} | null> {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  // Pure-numeric input -> treat as CIK directly. We still confirm it
  // exists by fetching the submissions index.
  if (/^\d+$/.test(trimmed)) {
    const cikInt = parseInt(trimmed, 10);
    if (!Number.isFinite(cikInt) || cikInt <= 0) return null;
    const cik = padCik(cikInt);
    const sub = await getCompanyFilingsIndex(cik);
    if (!sub) return null;
    return {
      cik,
      cikInt,
      ticker: Array.isArray(sub.tickers) && sub.tickers.length > 0 ? sub.tickers[0] : null,
      title: sub.name ?? null,
    };
  }

  // Otherwise treat as ticker.
  const tickerMap = await getTickerToCikMap();
  const row = tickerMap.get(trimmed.toUpperCase());
  if (!row) return null;
  return {
    cik: padCik(row.cik_str),
    cikInt: row.cik_str,
    ticker: row.ticker,
    title: row.title,
  };
}

// -----------------------------------------------------------------------------
// Submissions index (filings list)
// -----------------------------------------------------------------------------

export interface SubmissionsIndexRecent {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  acceptanceDateTime: string[];
  act: string[];
  form: string[];
  fileNumber: string[];
  filmNumber: string[];
  items: string[];
  size: number[];
  isXBRL: number[];
  isInlineXBRL: number[];
  primaryDocument: string[];
  primaryDocDescription: string[];
}

export interface SubmissionsIndex {
  cik: string;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  sicDescription?: string;
  filings?: {
    recent?: SubmissionsIndexRecent;
    files?: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
  };
}

/**
 * Fetch the SEC submissions index for a CIK. Includes the most recent ~1000
 * filings inline; older filings live in additional files referenced under
 * `filings.files[]`. For our use cases the recent block is sufficient.
 */
export async function getCompanyFilingsIndex(cik: string): Promise<SubmissionsIndex | null> {
  const padded = padCik(cik);
  const url = `${SEC_DATA_BASE}/submissions/CIK${padded}.json`;
  return getJson<SubmissionsIndex>(url);
}

/**
 * Decompose the parallel-arrays "recent" block into an array of objects.
 * Returns an empty array if no recent filings are available.
 */
export interface FilingRecord {
  accessionNumber: string;
  filingDate: string;
  reportDate: string | null;
  form: string;
  items: string[];
  primaryDocument: string;
  primaryDocDescription: string | null;
  size: number | null;
}

export function decomposeRecentFilings(index: SubmissionsIndex | null): FilingRecord[] {
  const recent = index?.filings?.recent;
  if (!recent) return [];
  const len = recent.accessionNumber?.length ?? 0;
  const out: FilingRecord[] = [];
  for (let i = 0; i < len; i += 1) {
    const itemsRaw = recent.items?.[i];
    const items =
      typeof itemsRaw === 'string' && itemsRaw.length > 0
        ? itemsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    out.push({
      accessionNumber: recent.accessionNumber[i],
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] || null,
      form: recent.form[i],
      items,
      primaryDocument: recent.primaryDocument?.[i] ?? '',
      primaryDocDescription: recent.primaryDocDescription?.[i] || null,
      size: typeof recent.size?.[i] === 'number' ? recent.size[i] : null,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// EDGAR Atom feeds (Form 4 / 13F search)
// -----------------------------------------------------------------------------

/**
 * Fetch raw Atom XML from EDGAR's browse-edgar feed. Used for Form 4
 * (insider transactions) and 13F-HR (institutional holdings) searches.
 *
 * Caller is responsible for parsing — kept as a string so a single shared
 * lightweight regex parser can extract titles/dates without pulling in a
 * full XML dependency.
 */
export async function getBrowseEdgarAtom(params: {
  cik?: string;
  type?: string;
  ownershipOnly?: boolean;
  count?: number;
}): Promise<string | null> {
  const qs = new URLSearchParams();
  qs.set('action', 'getcompany');
  if (params.cik) qs.set('CIK', params.cik.replace(/^0+/, '') || '0');
  if (params.type) qs.set('type', params.type);
  qs.set('owner', params.ownershipOnly ? 'only' : 'include');
  qs.set('count', String(params.count ?? 40));
  qs.set('output', 'atom');
  const url = `${SEC_WWW_BASE}/cgi-bin/browse-edgar?${qs.toString()}`;
  return getText(url, { accept: 'application/atom+xml' });
}

// -----------------------------------------------------------------------------
// Filing-document text fetch (for material-events digest)
// -----------------------------------------------------------------------------

/**
 * Fetch the primary document text for a filing. Used by the material events
 * digest tool to extract 8-K item descriptions. Returns null on error.
 *
 * URL format:
 *   https://www.sec.gov/Archives/edgar/data/{cikInt}/{accNoDashes}/{primaryDocument}
 */
export async function getFilingDocument(
  cik: string,
  accessionNumber: string,
  primaryDocument: string,
): Promise<string | null> {
  const cikInt = String(cik).replace(/^0+/, '') || '0';
  const accNoDashes = accessionNumber.replace(/-/g, '');
  const url = `${SEC_WWW_BASE}/Archives/edgar/data/${cikInt}/${accNoDashes}/${primaryDocument}`;
  return getText(url, { accept: 'text/html,application/xhtml+xml' });
}

// -----------------------------------------------------------------------------
// Test hooks
// -----------------------------------------------------------------------------

export const _internal = {
  buildUserAgent,
  SlidingWindowLimiter,
  Semaphore,
  limiter,
  semaphore,
};
