/**
 * Toolstem SEC MCP Server — Apify Actor entry point.
 *
 * Dispatches to the five SEC EDGAR intelligence tools based on the Actor input
 * field `tool`. When no input (or no `tool`) is provided, runs a default
 * demonstration (get_company_filings_summary for AAPL) and caches the result
 * for 6 hours to avoid unnecessary re-fetching during directory health-check
 * probes.
 *
 * Default-demo runs are NOT charged the per-call PPE event.
 * get_material_events_digest fires a premium `tool-call-premium` event ($0.02).
 * All other real tool calls fire the standard `tool-call` event ($0.005).
 */

import { Actor } from 'apify';

import { getCompanyFilingsSummary } from './tools/get-company-filings-summary.js';
import { getInsiderSignal } from './tools/get-insider-signal.js';
import { getInstitutionalSignal } from './tools/get-institutional-signal.js';
import { getMaterialEventsDigest } from './tools/get-material-events-digest.js';
import { compareDisclosureSignals } from './tools/compare-disclosure-signals.js';

// -----------------------------------------------------------------------------
// Input shape
// -----------------------------------------------------------------------------

interface ActorInput {
  tool:
    | 'get_company_filings_summary'
    | 'get_insider_signal'
    | 'get_institutional_signal'
    | 'get_material_events_digest'
    | 'compare_disclosure_signals';
  /** For tools that accept a single company identifier. */
  ticker_or_cik?: string;
  /** Lookback window in days (get_insider_signal, get_material_events_digest). */
  lookback_days?: number;
  /** Number of quarters to look back (get_institutional_signal). */
  quarters_back?: number;
  /** List of 2-5 tickers/CIKs (compare_disclosure_signals). */
  tickers_or_ciks?: string[];
}

// -----------------------------------------------------------------------------
// Actor main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  await Actor.init();

  try {
    const rawInput = await Actor.getInput<Partial<ActorInput>>();

    // Default behavior: when no input or no tool is provided (e.g. directory
    // health-check probes, first-time evaluators clicking "Run" with empty
    // fields), run get_company_filings_summary for AAPL so the run produces a
    // useful result instead of an error or empty exit.
    //
    // Default-demo runs are NOT charged the per-call PPE event — health-check
    // probes should not generate revenue and should not make unnecessary SEC
    // requests. The result is cached in the actor's default key-value store
    // under SEC_DEFAULT_DEMO_RESULT_V1 for 6 hours.
    const isDefaultDemo = !rawInput || !rawInput.tool;

    const input: ActorInput = {
      tool: rawInput?.tool ?? 'get_company_filings_summary',
      ticker_or_cik: rawInput?.ticker_or_cik ?? 'AAPL',
      lookback_days: rawInput?.lookback_days,
      quarters_back: rawInput?.quarters_back,
      tickers_or_ciks: rawInput?.tickers_or_ciks,
    };

    if (isDefaultDemo) {
      // eslint-disable-next-line no-console
      console.log(
        `No tool specified — running default demonstration: ${input.tool}(${input.ticker_or_cik}). ` +
          `For real usage, specify { "tool": "...", "ticker_or_cik": "..." } or use the MCP gateway ` +
          `at https://mcp.apify.com/?tools=toolstem/toolstem-sec-mcp-server`,
      );
    }

    // Default-demo cache: serve a cached result for up to 6 hours to avoid
    // re-fetching SEC EDGAR on every directory probe. Real (non-default)
    // invocations always go to EDGAR.
    const DEMO_CACHE_KEY = 'SEC_DEFAULT_DEMO_RESULT_V1';
    const DEMO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
    let result: unknown;

    if (isDefaultDemo) {
      const cached = (await Actor.getValue<{ at: number; result: unknown }>(
        DEMO_CACHE_KEY,
      )) as { at: number; result: unknown } | null;

      if (cached && typeof cached.at === 'number' && Date.now() - cached.at < DEMO_CACHE_TTL_MS) {
        // eslint-disable-next-line no-console
        console.log(
          `Serving default demonstration from cache (age: ${Math.round((Date.now() - cached.at) / 1000)}s).`,
        );
        result = cached.result;
        await Actor.pushData(result as Record<string, unknown>);
        await Actor.exit();
        return;
      }
    }

    // Dispatch to the requested tool.
    switch (input.tool) {
      case 'get_company_filings_summary': {
        const toc = input.ticker_or_cik;
        if (!toc || typeof toc !== 'string') {
          throw new Error('Input field "ticker_or_cik" is required for get_company_filings_summary.');
        }
        result = await getCompanyFilingsSummary(toc);
        break;
      }

      case 'get_insider_signal': {
        const toc = input.ticker_or_cik;
        if (!toc || typeof toc !== 'string') {
          throw new Error('Input field "ticker_or_cik" is required for get_insider_signal.');
        }
        const days = typeof input.lookback_days === 'number' ? input.lookback_days : 90;
        result = await getInsiderSignal(toc, days);
        break;
      }

      case 'get_institutional_signal': {
        const toc = input.ticker_or_cik;
        if (!toc || typeof toc !== 'string') {
          throw new Error('Input field "ticker_or_cik" is required for get_institutional_signal.');
        }
        const qb = typeof input.quarters_back === 'number' ? input.quarters_back : 4;
        result = await getInstitutionalSignal(toc, qb);
        break;
      }

      case 'get_material_events_digest': {
        const toc = input.ticker_or_cik;
        if (!toc || typeof toc !== 'string') {
          throw new Error('Input field "ticker_or_cik" is required for get_material_events_digest.');
        }
        const days = typeof input.lookback_days === 'number' ? input.lookback_days : 365;
        result = await getMaterialEventsDigest(toc, days);
        break;
      }

      case 'compare_disclosure_signals': {
        const tocs = input.tickers_or_ciks;
        if (!Array.isArray(tocs) || tocs.length < 2) {
          throw new Error(
            'Input field "tickers_or_ciks" is required for compare_disclosure_signals ' +
              '(array of 2-5 ticker symbols or CIKs).',
          );
        }
        result = await compareDisclosureSignals(tocs);
        break;
      }

      default:
        throw new Error(
          `Unknown tool: ${input.tool}. Valid tools: get_company_filings_summary, ` +
            `get_insider_signal, get_institutional_signal, get_material_events_digest, ` +
            `compare_disclosure_signals.`,
        );
    }

    await Actor.pushData(result as Record<string, unknown>);

    if (isDefaultDemo) {
      // Cache the demo result so subsequent probes are served from cache,
      // not by re-fetching EDGAR.
      await Actor.setValue(DEMO_CACHE_KEY, { at: Date.now(), result });
      // eslint-disable-next-line no-console
      console.log('Default demonstration result cached for 6h. PPE charge skipped (probe).');
    } else {
      // Premium tool fires a higher-value PPE event; all others fire the
      // standard tool-call event.
      const isPremium = input.tool === 'get_material_events_digest';
      const eventName = isPremium ? 'tool-call-premium' : 'tool-call';
      const chargeResult = await Actor.charge({ eventName });
      // eslint-disable-next-line no-console
      console.log('PPE charge result:', JSON.stringify(chargeResult));
    }

    // Explicitly terminate the Actor run. Without this, the container keeps
    // running until the per-run timeout (120s default) even though the tool
    // has already returned.
    await Actor.exit();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Actor run failed:', err);
    await Actor.fail(err instanceof Error ? err.message : String(err));
  }
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  try {
    await Actor.fail(err instanceof Error ? err.message : String(err));
  } catch {
    process.exit(1);
  }
});
