# SEC EDGAR MCP Server — Insider Signals, 13D Activist Risk & Filing Intelligence

**SEC EDGAR intelligence for AI agents.** Five composite tools that pre-compute high-value signals directly from SEC EDGAR's public submissions API, returned as structured JSON.

> **No SEC API key required.** Data is sourced directly from SEC EDGAR's public submissions API. A built-in sliding-window rate limiter keeps traffic under SEC's 10 rps fair-access ceiling automatically.

---

## Quickstart — hosted endpoint (recommended)

Point your MCP client or agent at the hosted endpoint. **No API key, no infra, no setup.** Billing is per-call via [x402](https://www.x402.org) — the agent's wallet pays directly in USDC on Base mainnet.

```
https://mcp.toolstem.com/mcp/sec
```

- **No SEC API key, no signup, no marketplace account** — the agent's wallet pays directly.
- **No infrastructure** — nothing to install, host, or keep running.
- **No setup** — connect an MCP client and call a tool.
- `initialize` and `tools/list` are **free** (discovery and schema introspection).
- `tools/call` is **tiered per tool** (see [Pricing](#pricing) below).

### Claude Desktop

Drop this into your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "toolstem-sec": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.toolstem.com/mcp/sec"
      ]
    }
  }
}
```

Restart Claude Desktop, then ask: *"Has TSLA disclosed any material 8-K events in the last 90 days?"*

### Any MCP client (LangChain.js)

The official [`@langchain/mcp-adapters`](https://www.npmjs.com/package/@langchain/mcp-adapters) library connects directly to the hosted URL:

```ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const client = new MultiServerMCPClient({
  toolstem_sec: {
    transport: "http",
    url: "https://mcp.toolstem.com/mcp/sec",
    // Add your x402-signing middleware via headers, OR run an x402
    // proxy locally and point url at it. See https://www.x402.org/clients.
  },
});

const tools = await client.getTools();
const agent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o-mini" }), tools });
await agent.invoke({ messages: "Has TSLA disclosed any material 8-K events in the last 90 days?" });
```

Prefer to run the server yourself over stdio/HTTP? See [Advanced: self-host](#advanced-self-host) at the bottom.

---

## Pricing

- **MCP `initialize` and `tools/list` are free** — discover the server and its tool surface without paying anything.
- **`tools/call` is tiered per tool**, paid in USDC on Base mainnet via [x402](https://www.x402.org). No API key, no signup, no marketplace account — agents pay directly from their own wallet.

| Tier | Price per call | Tools |
|------|----------------|-------|
| Cheap | **$0.005** | `get_company_filings_summary` |
| Standard | **$0.05** | `get_insider_signal`, `get_institutional_signal` |
| Premium | **$0.50** | `get_material_events_digest`, `compare_disclosure_signals` |

See the live pricing page on [toolstem.com/sec/](https://toolstem.com/sec/) for current rates.

---

## The five tools

All five tools are composite/curated (they compute derived signals or aggregate across multiple EDGAR endpoints — no raw passthroughs). Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.

| # | Tool | Required input | Optional input (default) | Tier (price/call) |
|---|------|----------------|--------------------------|-------------------|
| 1 | `get_company_filings_summary` | `ticker_or_cik` (string) | — | Cheap ($0.005) |
| 2 | `get_insider_signal` | `ticker_or_cik` (string) | `lookback_days` (int 1–730, **default 90**) | Standard ($0.05) |
| 3 | `get_institutional_signal` | `ticker_or_cik` (string) | `quarters_back` (int 1–20, **default 4**) | Standard ($0.05) |
| 4 | `get_material_events_digest` | `ticker_or_cik` (string) | `lookback_days` (int 1–1825, **default 365**) | **Premium ($0.50)** |
| 5 | `compare_disclosure_signals` | `tickers_or_ciks` (string[2..5]) | — | **Premium ($0.50)** |

---

### 1. `get_company_filings_summary`

Overview of a company's filing activity: last 20 filings + computed signals.

| Signal | Description |
|--------|-------------|
| `filing_velocity` | `ACCELERATING` / `NORMAL` / `SLOWING` vs. trailing 365-day average |
| `material_event_count_90d` | Count of 8-K filings in the last 90 days |
| `disclosure_volume_trend` | `RISING` / `STABLE` / `FALLING` based on 10-K size comparison |
| `latest_form_types` | Unique form types filed in the last 90 days |

**Example output (abbreviated):**
```json
{
  "ticker": "AAPL",
  "cik": "0000320193",
  "company_name": "Apple Inc.",
  "signals": {
    "filing_velocity": "NORMAL",
    "material_event_count_90d": 4,
    "disclosure_volume_trend": "RISING",
    "latest_form_types": ["8-K", "4", "DEF 14A"]
  },
  "meta": { "source": "sec_edgar_direct", "data_delay": "live" }
}
```

---

### 2. `get_insider_signal`

Probes Form 3 / 4 / 4/A insider filing activity within a configurable lookback window. Required: `ticker_or_cik`. Optional: `lookback_days` (1–730, default 90).

Returns: `recent_insider_filings[]` (accession numbers + SEC URLs), `net_transaction_count`, `buy_count`, `sell_count`, and `insider_signal`.

> **v0.1 limitation — counts only.** v0.1 returns counts and Form 4 references only; **direction-aware buy/sell signals ship in v0.2** (Form 4 XML parsing). Today, `insider_signal` is `null` when filings exist in the window (direction unknown) and `"NEUTRAL"` when no insider filings exist (verified absence). `buy_count` / `sell_count` are `0` in v0.1.

**Example output (abbreviated):**
```json
{
  "ticker": "MSFT",
  "cik": "0000789019",
  "company_name": "MICROSOFT CORP",
  "lookback_days": 90,
  "insider_signal": null,
  "net_transaction_count": 0,
  "buy_count": 0,
  "sell_count": 0,
  "recent_insider_filings": [
    {
      "accession_number": "0001127602-26-001234",
      "filing_date": "2026-04-15",
      "sec_url": "https://www.sec.gov/Archives/edgar/data/789019/000112760226001234/0001127602-26-001234-index.htm"
    }
  ],
  "meta": { "source": "sec_edgar_direct", "data_delay": "live" }
}
```

---

### 3. `get_institutional_signal`

Probes for activist investor activity via SC 13D / 13D/A filings. Required: `ticker_or_cik`. Optional: `quarters_back` (1–20, default 4 ≈ 1 year).

| Field | Description |
|-------|-------------|
| `activist_risk_flag` | `true` if any SC 13D or 13D/A was filed in the last 365 days |
| `recent_13d_filings` | List of 13D filings with form type, date, and SEC URL |

> **v0.1 limitation — activist flag only.** v0.1 ships the **live `activist_risk_flag` (from 13D/13D-A)** and a list of 13D filings. Quarterly **13F XBRL parsing** — which produces `institutional_signal` (`ACCUMULATING` / `HOLDING` / `DISTRIBUTING`) and `recent_13f_count` — **ships in v0.2**. Today those two fields are `null` / `0`.

**Example output (abbreviated):**
```json
{
  "ticker": "NVDA",
  "cik": "0001045810",
  "company_name": "NVIDIA CORP",
  "quarters_back": 4,
  "institutional_signal": null,
  "recent_13f_count": 0,
  "activist_risk_flag": false,
  "recent_13d_filings": [],
  "meta": { "source": "sec_edgar_direct", "data_delay": "live" }
}
```

---

### 4. `get_material_events_digest` ⚡ **Premium tier**

> **Premium tier — $0.50 USDC per call** on Base mainnet, settled via x402. See the live pricing page on [toolstem.com/sec/](https://toolstem.com/sec/) for current rates.

Severity-ranked digest of all 8-K and 8-K/A filings within a configurable lookback window. Each item code is mapped to a plain-English label and severity rating. Required: `ticker_or_cik`. Optional: `lookback_days` (1–1825, default 365).

| Severity | Examples |
|----------|---------|
| 🔴 RED | Cybersecurity incident (1.05), restatement (4.02), bankruptcy (1.03), delisting (3.01) |
| 🟡 YELLOW | Acquisition (2.01), new debt (2.03), executive departure (5.02) |
| 🟢 GREEN | Earnings release (2.02), Reg FD (7.01), shareholder vote (5.07) |

Returns: `events[]` (sorted newest-first), `redflag_count`, `category_counts`.

**Example output (abbreviated):**
```json
{
  "ticker": "TSLA",
  "cik": "0001318605",
  "company_name": "Tesla, Inc.",
  "lookback_days": 180,
  "redflag_count": 1,
  "category_counts": { "RED": 1, "YELLOW": 3, "GREEN": 7 },
  "events": [
    {
      "accession_number": "0001628280-26-005678",
      "filing_date": "2026-04-10",
      "form": "8-K",
      "items": [
        { "code": "4.02", "label": "Non-Reliance on Previously Issued Financial Statements", "category": "financial", "severity": "RED" }
      ],
      "sec_url": "https://www.sec.gov/Archives/edgar/data/1318605/000162828026005678/0001628280-26-005678-index.htm"
    }
  ],
  "meta": { "source": "sec_edgar_direct", "data_delay": "live" }
}
```

---

### 5. `compare_disclosure_signals`

Side-by-side comparison of 2–5 companies across all key disclosure signals. Required: `tickers_or_ciks` (string[2..5]). All lookups run in parallel.

Returns per-company: `filing_velocity`, `material_event_count_90d`, `redflag_count_365d`, `activist_risk_flag`, `last_filing_date`.

Returns winners (as **CIKs**, not tickers — cross-reference with the `companies[]` array): `quietest_disclosure`, `most_active`, `most_redflags`, `activist_targets`.

**Example output (abbreviated):**
```json
{
  "companies": [
    {
      "ticker": "AAPL",
      "cik": "0000320193",
      "filing_velocity": "NORMAL",
      "material_event_count_90d": 4,
      "redflag_count_365d": 0,
      "activist_risk_flag": false,
      "last_filing_date": "2026-04-25"
    },
    {
      "ticker": "MSFT",
      "cik": "0000789019",
      "filing_velocity": "ACCELERATING",
      "material_event_count_90d": 7,
      "redflag_count_365d": 0,
      "activist_risk_flag": false,
      "last_filing_date": "2026-04-26"
    }
  ],
  "winners": {
    "quietest_disclosure": "0000320193",
    "most_active": "0000789019",
    "most_redflags": null,
    "activist_targets": []
  },
  "meta": { "source": "sec_edgar_direct", "data_delay": "live" }
}
```

---

## Advanced: self-host

> **Most users should use the [hosted endpoint](#quickstart--hosted-endpoint-recommended) above** — it needs no API key, no infrastructure, and no setup. This section is for users who specifically want to run the server themselves. When self-hosting you are responsible for running the process and for supplying an EDGAR fair-access contact (`SEC_USER_AGENT_CONTACT`).

### Claude Desktop (self-hosted over stdio)

Run locally over stdio — no x402 charges, you bring your own EDGAR fair-access contact:

```json
{
  "mcpServers": {
    "toolstem-sec": {
      "command": "npx",
      "args": ["-y", "toolstem-sec-mcp-server"],
      "env": {
        "SEC_USER_AGENT_CONTACT": "you@yourorg.com"
      }
    }
  }
}
```

### npm (MCP stdio transport)

```bash
npm install -g toolstem-sec-mcp-server
toolstem-sec-mcp-server
```

### Self-hosted HTTP

Three modes:

**Local-only (default — safest):**
```bash
toolstem-sec-mcp-server --http
# Binds 127.0.0.1:3000 — reachable only from this machine
```

**Remote with auth:**
```bash
ALLOW_REMOTE=1 MCP_AUTH_TOKEN=my-secret toolstem-sec-mcp-server --http
# Binds 0.0.0.0:3000 — requires Bearer token on every /mcp request
```

**Remote without auth (use at your own risk):**
```bash
ALLOW_REMOTE=1 MCP_AUTH_DISABLED=1 toolstem-sec-mcp-server --http
# Binds 0.0.0.0:3000 — no authentication
```

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default `3000`) |
| `ALLOW_REMOTE` | Set to `1` to bind `0.0.0.0` instead of `127.0.0.1` |
| `MCP_AUTH_TOKEN` | Bearer token for `/mcp` routes (required when `ALLOW_REMOTE=1`) |
| `MCP_AUTH_DISABLED` | Set to `1` to skip auth even with `ALLOW_REMOTE=1` (not recommended) |
| `SEC_USER_AGENT_CONTACT` | Contact email for SEC EDGAR User-Agent header |

---

## SEC EDGAR fair-access policy

All outbound traffic goes through a shared sliding-window rate limiter (8 rps target, 4 rps safety margin below SEC's 10 rps hard cap). Every request includes a `User-Agent` header identifying the package and a contact email per SEC policy. Override the contact email via:

```bash
SEC_USER_AGENT_CONTACT=you@yourorg.com toolstem-sec-mcp-server
```

Violating SEC's fair-access policy can result in your IP being blocked. This server is designed to stay compliant automatically.

---

## v0.2 roadmap

- **Form 4 XML parsing** — direction-aware insider signals (`STRONG_BUYING` / `BUYING` / `NEUTRAL` / `SELLING` / `STRONG_SELLING`) with net share counts
- **13F XBRL parsing** — quarterly institutional flow signals (`ACCUMULATING` / `HOLDING` / `DISTRIBUTING`) with institution count
- **8-K text extraction** — natural-language summaries of each material event from the filing's primary HTML document

---

## License & author

MIT License — see [LICENSE](./LICENSE).

Built by [Toolstem](https://toolstem.com/sec/). Data sourced directly from [SEC EDGAR](https://www.sec.gov/developer).
