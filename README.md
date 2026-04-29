# Toolstem SEC MCP Server

**Signal-first SEC EDGAR intelligence for AI agents.** Five tools that answer questions directly — "Is the CEO buying?", "Has there been a restatement?", "Is an activist circling?" — instead of returning raw filing lists.

---

## Why this exists

Existing SEC data tools give agents paginated filing lists and raw XML. Agents then have to parse, classify, and derive signals themselves — burning context window on bureaucratic extraction instead of analysis.

Toolstem SEC MCP Server pre-computes five high-value signals directly from SEC EDGAR's public submissions API, returning structured, agent-ready JSON. No third-party data providers, no API keys, no per-symbol fees — just SEC EDGAR's authoritative source with a rate-limiter that keeps you off their blocklist.

---

## The five tools

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
Probes Form 3/4/4A insider filing activity within a lookback window.

Returns: `recent_insider_filings` (accession numbers + SEC URLs for Forms 3/4/4A), `lookback_days`, and counts.

> **v0.1 note:** When at least one Form 3/4/4A filing exists in the lookback window, `insider_signal` is `null` ("direction unknown — Form 4 XML parsing ships in v0.2"). When no insider filings exist in the window, `insider_signal` is `"NEUTRAL"` ("verified absence of activity"). `buy_count` and `sell_count` are 0 in v0.1.

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
Probes for activist investor activity via SC 13D / 13D/A filings.

| Field | Description |
|-------|-------------|
| `activist_risk_flag` | `true` if any SC 13D or 13D/A was filed in the last 365 days |
| `recent_13d_filings` | List of 13D filings with form type, date, and SEC URL |

> **v0.1 note:** `institutional_signal` and `recent_13f_count` are null/0. Quarterly 13F XBRL/XML parsing (ACCUMULATING / HOLDING / DISTRIBUTING) ships in v0.2.

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

### 4. `get_material_events_digest` ⚡ premium ($0.50)
Severity-ranked digest of all 8-K and 8-K/A filings within a lookback window. Maps each item code to a plain-English label and severity rating.

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
Side-by-side comparison of 2-5 companies across all key disclosure signals. All lookups run in parallel.

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

## Pricing

All calls are billed on a **per-result** basis via Apify's Pay-Per-Event (PPE) system. Pricing is charged at the time the tool returns its result.

| Tool | Tier | Price per call |
| --- | --- | --- |
| `get_company_filings_summary` | Cheap | $0.005 |
| `get_insider_signal` | Standard | $0.05 |
| `get_institutional_signal` | Standard | $0.05 |
| `get_material_events_digest` | Premium | $0.50 |
| `compare_disclosure_signals` | Premium | $0.50 |

Default-demo probes (Actor runs with no `tool` input) are **free** — they serve a cached result and do not fire a PPE charge. This keeps directory health-check probes and first-time evaluations cost-free. Apify retains a 20 % commission on all PPE revenue; the prices above are gross amounts.

---

## Installation

### npm (MCP stdio transport)

```bash
npm install -g toolstem-sec-mcp-server
```

Add to your MCP client config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "toolstem-sec": {
      "command": "toolstem-sec-mcp-server"
    }
  }
}
```

No API key required.

### Hosted on Apify

Run the Actor directly or connect via the MCP gateway:

```
https://mcp.apify.com/?tools=toolstem/toolstem-sec-mcp-server
```

Actor input example:
```json
{
  "tool": "get_material_events_digest",
  "ticker_or_cik": "TSLA",
  "lookback_days": 365
}
```

### HTTP server (self-hosted)

```bash
npm install -g toolstem-sec-mcp-server
toolstem-sec-mcp-server --http
# Listens on http://0.0.0.0:3000/mcp
```

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

Built by [Toolstem](https://github.com/toolstem). Data sourced directly from [SEC EDGAR](https://www.sec.gov/developer).
