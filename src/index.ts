#!/usr/bin/env node
/**
 * Toolstem SEC MCP Server — entry point.
 *
 * Exposes five SEC EDGAR intelligence tools:
 *   - get_company_filings_summary  — filing velocity, material event counts, disclosure trend
 *   - get_insider_signal           — insider Form 3/4/4A activity probe
 *   - get_institutional_signal     — activist risk flag (13D/13D/A); 13F-HR in v0.2
 *   - get_material_events_digest   — 8-K item-level severity digest (premium tier)
 *   - compare_disclosure_signals   — side-by-side comparison of 2-5 companies
 *
 * Supports two transports:
 *   - stdio (default) — for Claude Desktop, Smithery, npm installs, etc.
 *   - HTTP (via --http flag) — Streamable HTTP on PORT (default 3000)
 *
 * No API key is required — all data is sourced directly from SEC EDGAR's public
 * submissions API. The rate limiter in services/edgar.ts keeps traffic below
 * SEC's 10 rps fair-access ceiling automatically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { getCompanyFilingsSummary } from './tools/get-company-filings-summary.js';
import { getInsiderSignal } from './tools/get-insider-signal.js';
import { getInstitutionalSignal } from './tools/get-institutional-signal.js';
import { getMaterialEventsDigest } from './tools/get-material-events-digest.js';
import { compareDisclosureSignals } from './tools/compare-disclosure-signals.js';

// -----------------------------------------------------------------------------
// Zod schemas for structured output validation
// -----------------------------------------------------------------------------

const MetaShape = z.object({
  source: z.string(),
  timestamp: z.string(),
  data_delay: z.string(),
});

const FilingSummaryRecordShape = z.object({
  accession_number: z.string(),
  form: z.string(),
  filing_date: z.string(),
  primary_doc_description: z.string().nullable(),
  items: z.array(z.string()),
  sec_url: z.string(),
});

const CompanyFilingsSummaryShape = {
  ticker: z.string().nullable(),
  cik: z.string(),
  company_name: z.string().nullable(),
  recent_filings: z.array(FilingSummaryRecordShape),
  signals: z.object({
    filing_velocity: z.enum(['ACCELERATING', 'NORMAL', 'SLOWING']).nullable(),
    material_event_count_90d: z.number(),
    disclosure_volume_trend: z.enum(['RISING', 'STABLE', 'FALLING']).nullable(),
    latest_form_types: z.array(z.string()),
  }),
  meta: MetaShape,
};

const InsiderSignalShape = {
  ticker: z.string().nullable(),
  cik: z.string(),
  company_name: z.string().nullable(),
  lookback_days: z.number(),
  insider_signal: z
    .enum(['STRONG_BUYING', 'BUYING', 'NEUTRAL', 'SELLING', 'STRONG_SELLING'])
    .nullable(),
  net_transaction_count: z.number(),
  buy_count: z.number(),
  sell_count: z.number(),
  recent_insider_filings: z.array(
    z.object({
      accession_number: z.string(),
      filing_date: z.string(),
      sec_url: z.string(),
    }),
  ),
  meta: MetaShape,
};

const InstitutionalSignalShape = {
  ticker: z.string().nullable(),
  cik: z.string(),
  company_name: z.string().nullable(),
  quarters_back: z.number(),
  institutional_signal: z.enum(['ACCUMULATING', 'HOLDING', 'DISTRIBUTING']).nullable(),
  recent_13f_count: z.number(),
  activist_risk_flag: z.boolean(),
  recent_13d_filings: z.array(
    z.object({
      accession_number: z.string(),
      filing_date: z.string(),
      form: z.string(),
      sec_url: z.string(),
    }),
  ),
  meta: MetaShape,
};

const MaterialEventItemShape = z.object({
  code: z.string(),
  label: z.string(),
  category: z.string(),
  severity: z.enum(['RED', 'YELLOW', 'GREEN']),
});

const MaterialEventsDigestShape = {
  ticker: z.string().nullable(),
  cik: z.string(),
  company_name: z.string().nullable(),
  lookback_days: z.number(),
  events: z.array(
    z.object({
      accession_number: z.string(),
      filing_date: z.string(),
      form: z.string(),
      items: z.array(MaterialEventItemShape),
      sec_url: z.string(),
      overall_severity: z.enum(['RED', 'YELLOW', 'GREEN']),
    }),
  ),
  category_counts: z.record(z.string(), z.number()),
  redflag_count: z.number(),
  meta: MetaShape,
};

const DisclosureComparisonShape = {
  companies: z.array(
    z.object({
      ticker: z.string().nullable(),
      cik: z.string(),
      company_name: z.string().nullable(),
      filing_velocity: z.enum(['ACCELERATING', 'NORMAL', 'SLOWING']).nullable(),
      material_event_count_90d: z.number(),
      redflag_count_365d: z.number(),
      activist_risk_flag: z.boolean(),
      last_filing_date: z.string().nullable(),
    }),
  ),
  winners: z.object({
    quietest_disclosure: z.string().nullable(),
    most_active: z.string().nullable(),
    most_redflags: z.string().nullable(),
    activist_targets: z.array(z.string()),
  }),
  meta: MetaShape,
};

// -----------------------------------------------------------------------------
// Server factory
// -----------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'toolstem-sec-mcp-server',
    version: '0.1.7',
  });

  // ---------------------------------------------------------------------------
  // Tool 1: get_company_filings_summary
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_company_filings_summary',
    {
      title: 'Company Filings Summary',
      description:
        'Retrieve a structured overview of a company\'s SEC filing activity. ' +
        'Returns the most recent 20 filings and pre-computed signals: filing velocity ' +
        '(ACCELERATING / NORMAL / SLOWING vs. trailing 365-day average), material event ' +
        'count in the last 90 days, 10-K disclosure volume trend (RISING / STABLE / FALLING), ' +
        'and the unique form types filed in the last 90 days. Use this as a first-pass ' +
        'signal before digging into insider or material-event detail.',
      inputSchema: {
        ticker_or_cik: z
          .string()
          .min(1)
          .describe(
            'Ticker symbol (e.g. "AAPL") or numeric CIK (e.g. "320193" or "0000320193").',
          ),
      },
      outputSchema: CompanyFilingsSummaryShape,
      annotations: {
        title: 'Company Filings Summary',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticker_or_cik }) => {
      const result = await getCompanyFilingsSummary(ticker_or_cik);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [key: string]: unknown },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 2: get_insider_signal
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_insider_signal',
    {
      title: 'Insider Signal',
      description:
        'Probe insider filing activity (Form 3, 4, 4/A) for a company over a ' +
        'configurable lookback window. Answers: "Are insiders filing recently?" ' +
        'Returns recent Form 4 filing references and counts. ' +
        'NOTE: Direction-aware buy/sell signals (insider_signal, buy_count, sell_count) ' +
        'are null/0 in v0.1 — Form 4 XML parsing ships in v0.2.',
      inputSchema: {
        ticker_or_cik: z
          .string()
          .min(1)
          .describe('Ticker symbol (e.g. "MSFT") or numeric CIK.'),
        lookback_days: z
          .number()
          .int()
          .min(1)
          .max(730)
          .default(90)
          .describe('Number of calendar days to look back (default 90, max 730).'),
      },
      outputSchema: InsiderSignalShape,
      annotations: {
        title: 'Insider Signal',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticker_or_cik, lookback_days }) => {
      const result = await getInsiderSignal(ticker_or_cik, lookback_days ?? 90);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [key: string]: unknown },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 3: get_institutional_signal
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_institutional_signal',
    {
      title: 'Institutional Signal',
      description:
        'Probe institutional and activist investor signals for a company. ' +
        'Returns a live activist_risk_flag (true if any SC 13D or 13D/A was filed ' +
        'in the last 365 days — an activist investor has disclosed a large stake). ' +
        'Also lists the 13D filings and their SEC URLs. ' +
        'NOTE: Institutional accumulation/distribution signal (institutional_signal) and ' +
        'recent_13f_count are null/0 in v0.1 — quarterly 13F XBRL parsing ships in v0.2.',
      inputSchema: {
        ticker_or_cik: z
          .string()
          .min(1)
          .describe('Ticker symbol (e.g. "NVDA") or numeric CIK.'),
        quarters_back: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(4)
          .describe('Number of calendar quarters to look back (default 4 ≈ 1 year, max 20).'),
      },
      outputSchema: InstitutionalSignalShape,
      annotations: {
        title: 'Institutional Signal',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticker_or_cik, quarters_back }) => {
      const result = await getInstitutionalSignal(ticker_or_cik, quarters_back ?? 4);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [key: string]: unknown },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 4: get_material_events_digest (premium tier)
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_material_events_digest',
    {
      title: 'Material Events Digest',
      description:
        'Retrieve a severity-ranked digest of all 8-K and 8-K/A filings for a ' +
        'company within a configurable lookback window. Each event is tagged with ' +
        'item codes mapped to plain-English labels, categories, and severity ' +
        '(RED / YELLOW / GREEN). Returns redflag_count (events with any RED item) and ' +
        'category_counts for quick categorical analysis. Answers: "Has this company ' +
        'disclosed a cybersecurity incident, restatement, or going-concern risk recently?" ' +
        'Premium-tier tool. See the actor pricing page for current per-call cost.',
      inputSchema: {
        ticker_or_cik: z
          .string()
          .min(1)
          .describe('Ticker symbol (e.g. "TSLA") or numeric CIK.'),
        lookback_days: z
          .number()
          .int()
          .min(1)
          .max(1825)
          .default(365)
          .describe('Number of calendar days to include (default 365, max 1825 / 5 years).'),
      },
      outputSchema: MaterialEventsDigestShape,
      annotations: {
        title: 'Material Events Digest',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticker_or_cik, lookback_days }) => {
      const result = await getMaterialEventsDigest(ticker_or_cik, lookback_days ?? 365);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [key: string]: unknown },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 5: compare_disclosure_signals
  // ---------------------------------------------------------------------------

  server.registerTool(
    'compare_disclosure_signals',
    {
      title: 'Compare Disclosure Signals',
      description:
        'Side-by-side comparison of 2-5 companies across key SEC disclosure ' +
        'signals: filing velocity, material event count (90d), red-flag count ' +
        '(365d), activist risk flag, and most recent filing date. Returns derived ' +
        '"winners" for each dimension — quietest disclosure, most active filer, ' +
        'most red flags, and companies with active activist investors. All lookups ' +
        'run in parallel. Use for competitive intelligence or risk triage across a watchlist.',
      inputSchema: {
        tickers_or_ciks: z
          .array(z.string().min(1))
          .min(2)
          .max(5)
          .describe(
            '2-5 ticker symbols or CIKs to compare (e.g. ["AAPL", "MSFT", "GOOGL"]).',
          ),
      },
      outputSchema: DisclosureComparisonShape,
      annotations: {
        title: 'Compare Disclosure Signals',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ tickers_or_ciks }) => {
      const result = await compareDisclosureSignals(tickers_or_ciks);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [key: string]: unknown },
      };
    },
  );

  return server;
}

// -----------------------------------------------------------------------------
// Transport runners
// -----------------------------------------------------------------------------

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep process alive — stdio transport handles close events.
}

async function runHttp(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Bind address: localhost by default, 0.0.0.0 only with ALLOW_REMOTE=1
  // ---------------------------------------------------------------------------
  const allowRemote = process.env.ALLOW_REMOTE === '1';
  const bindHost = allowRemote ? '0.0.0.0' : '127.0.0.1';

  // ---------------------------------------------------------------------------
  // Auth: required when ALLOW_REMOTE=1 unless explicitly disabled
  // ---------------------------------------------------------------------------
  const authToken = process.env.MCP_AUTH_TOKEN;
  const authDisabled = process.env.MCP_AUTH_DISABLED === '1';

  if (allowRemote && !authToken && !authDisabled) {
    console.error(
      'ERROR: ALLOW_REMOTE=1 requires MCP_AUTH_TOKEN to be set.\n' +
      'Set MCP_AUTH_TOKEN=<secret> or, if you accept the risk, set MCP_AUTH_DISABLED=1 to skip auth.',
    );
    process.exit(1);
  }

  const authEnabled = !!authToken && !authDisabled;

  // Bearer-token middleware using constant-time comparison on equal-length buffers
  function bearerAuth(req: Request, res: Response, next: NextFunction): void {
    if (!authEnabled) { next(); return; }

    const header = req.header('authorization') ?? '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) {
      res.status(401).json({ error: 'Missing or malformed Authorization header' });
      return;
    }
    const supplied = Buffer.from(header.slice(prefix.length));
    const expected = Buffer.from(authToken!);

    // Pad to equal length before timingSafeEqual (required by Node)
    const maxLen = Math.max(supplied.length, expected.length);
    const a = Buffer.alloc(maxLen);
    const b = Buffer.alloc(maxLen);
    supplied.copy(a);
    expected.copy(b);

    if (supplied.length !== expected.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Invalid bearer token' });
      return;
    }
    next();
  }

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);

  // ---------------------------------------------------------------------------
  // Rate limiting on /mcp — 150 requests per minute per IP
  // ---------------------------------------------------------------------------
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: 150,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded — try again in a minute' },
  });

  // Per-session transport registry for Streamable HTTP, with TTL cleanup.
  interface SessionEntry {
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
  }
  const sessions = new Map<string, SessionEntry>();

  // Sweep stale sessions every 60 seconds (30-minute inactivity TTL).
  const SESSION_TTL_MS = 30 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        try { entry.transport.close?.(); } catch { /* ignore */ }
        sessions.delete(id);
      }
    }
  }, 60_000).unref();

  // /health is intentionally unauthenticated: load balancers and uptime probes
  // need to reach it without credentials. It exposes no secrets or user data.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'toolstem-sec-mcp-server', version: '0.1.7' });
  });

  app.post('/mcp', mcpLimiter, bearerAuth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.header('mcp-session-id');
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        entry.lastActivity = Date.now();
        transport = entry.transport;
      } else {
        // New session (or no session header) — create a fresh transport + server pair.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId: string) => {
            if (transport) sessions.set(newId, { transport, lastActivity: Date.now() });
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        const server = createServer();
        await server.connect(transport);
      }

      if (!transport) {
        res.status(500).json({ error: 'Failed to initialize transport' });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] unhandled error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', mcpLimiter, bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Missing or unknown mcp-session-id' });
      return;
    }
    const entry = sessions.get(sessionId)!;
    entry.lastActivity = Date.now();
    await entry.transport.handleRequest(req, res);
  });

  app.delete('/mcp', mcpLimiter, bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Missing or unknown mcp-session-id' });
      return;
    }
    const entry = sessions.get(sessionId)!;
    entry.lastActivity = Date.now();
    await entry.transport.handleRequest(req, res);
  });

  app.listen(port, bindHost, () => {
    // eslint-disable-next-line no-console
    console.log(
      `\n  Toolstem SEC MCP server v0.1.7\n` +
      `  Listening on http://${bindHost}:${port}/mcp\n` +
      `  Auth:    ${authEnabled ? 'ENABLED (bearer token)' : 'DISABLED'}\n` +
      `  Remote:  ${allowRemote ? 'ALLOWED (0.0.0.0)' : 'localhost only (127.0.0.1)'}` +
      (!authEnabled && allowRemote ? '\n  ⚠  WARNING: Remote access is open with no authentication!' : '') +
      '\n',
    );
  });
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const useHttp = process.argv.includes('--http');

if (useHttp) {
  runHttp().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start HTTP server:', err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start stdio server:', err);
    process.exit(1);
  });
}
