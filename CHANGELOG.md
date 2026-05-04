# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.3] - 2026-05-04

### Added — MCP tool annotations

All five tools (`get_company_filings_summary`, `get_insider_signal`, `get_institutional_signal`, `get_material_events_digest`, `compare_disclosure_signals`) now expose the standard MCP `annotations` block:

- `readOnlyHint: true` — SEC EDGAR is read-only by definition
- `destructiveHint: false` — tools never mutate state
- `idempotentHint: true` — same ticker/CIK + lookback yields same digest
- `openWorldHint: true` — tools fetch live from data.sec.gov
- `title` — human-readable display label

Motivated by Anthropic Connectors Directory submission requirements. Purely additive metadata; no behavioral change.

## [0.1.2] - 2026-04-29

### Changed

- **Three-tier per-result pricing model.** Replaced the previous two-tier pricing (`tool-call` / `tool-call-premium`) with a three-tier model aligned with Apify ecosystem per-result norms ($0.40–$1.50 per 1 000 results).

  | Tool | Tier | PPE Event | Price per call |
  | --- | --- | --- | --- |
  | `get_company_filings_summary` | Cheap | `tool-call` | $0.005 |
  | `get_insider_signal` | Standard | `tool-call-standard` | $0.05 |
  | `get_institutional_signal` | Standard | `tool-call-standard` | $0.05 |
  | `get_material_events_digest` | Premium | `tool-call-premium` | $0.50 |
  | `compare_disclosure_signals` | Premium | `tool-call-premium` | $0.50 |

- **Premium tier price increased from $0.02 → $0.50.** The previous $0.02 price was below the Apify ecosystem floor for compute-intensive per-result operations. Material events digests and cross-company comparison signals require multiple parallel EDGAR fetches and classification passes; $0.50 gross ($0.40 net after 20 % Apify commission) is consistent with comparable Apify actors in the data-enrichment category.

- **New Standard tier ($0.05) for insider and institutional signals.** These tools perform targeted form-type filtering over the full submissions feed and return structured signal data — higher value than a basic filing summary but materially cheaper than a full multi-document digest computation. The new `tool-call-standard` PPE event is added in the Apify Console after this release ships.

- **Default-demo free runs preserved.** No-input Actor invocations (directory health-check probes, first-time evaluators) continue to skip all PPE charges and serve from a 6-hour KV cache. No behaviour change from v0.1.1.

- **`src/actor.ts` refactored:** The `isPremium` boolean ternary is replaced by a `PRICING_TIER` lookup table (`Record<ActorInput['tool'], string>`), making future tier additions a one-line diff instead of a conditional chain.

---

## [0.1.1] - 2026-04-28

### Fixed

- **Apify input schema field names now match `actor.ts`.** Renamed `ticker` → `ticker_or_cik` and `tickers` → `tickers_or_ciks` in `.actor/input_schema.json` so user input from the Apify Console actually reaches the dispatcher. Previously, any value typed into the Console fell through to the hardcoded default because the actor read keys that the schema did not define.
- **Removed `default: 'get_company_filings_summary'`** from the `tool` field in `.actor/input_schema.json`. The default value made `rawInput.tool` always truthy, which disabled the no-charge default-demo branch entirely — every Console run hit a real EDGAR call and a `tool-call` charge attempt regardless of intent. Now an empty input genuinely produces an undefined `tool`, which routes through the cached default-demo path with no charge as designed.
- **Tool field title relabeled** to "Tool (optional)" with updated description so first-time evaluators see at a glance that they can leave it blank for a free demo run.

### Why this matters

Without these fixes, the no-charge default-demo + 6h cache pattern shipped in v0.1.0 was inert. Apify Console smoke tests on Apr 28 evening (run `q1z92Cd6FbXDLFj2v`) confirmed the actor was hitting EDGAR and attempting to charge on every empty-input run, exactly the behavior that suppressed the finance actor's discoverability ranking.

---

## [0.1.0] - 2026-04-27

### Added

- **`get_company_filings_summary`** — Overview of a company's SEC filing activity. Returns the last 20 filings and four computed signals: `filing_velocity` (ACCELERATING / NORMAL / SLOWING vs. trailing 365-day average), `material_event_count_90d` (8-K count in last 90 days), `disclosure_volume_trend` (RISING / STABLE / FALLING based on 10-K size comparison), and `latest_form_types` (unique form types in the last 90 days).

- **`get_insider_signal`** — Probes Form 3/4/4A insider filing activity within a configurable lookback window (default 90 days). Returns recent filing references with SEC URLs. v0.1 note: `insider_signal`, `buy_count`, and `sell_count` are null/0 — direction-aware Form 4 XML parsing ships in v0.2.

- **`get_institutional_signal`** — Returns `activist_risk_flag` (true if any SC 13D / 13D/A was filed in the last 365 days) and the list of activist filings. v0.1 note: `institutional_signal` and `recent_13f_count` are null/0 — quarterly 13F XBRL parsing ships in v0.2.

- **`get_material_events_digest`** (premium — $0.02 per call) — Severity-ranked digest of all 8-K and 8-K/A filings within a configurable lookback window (default 365 days). Maps each item code to a plain-English label, category, and severity (RED / YELLOW / GREEN) using the full SEC item catalog. Returns `redflag_count` and `category_counts`.

- **`compare_disclosure_signals`** — Side-by-side comparison of 2–5 companies across `filing_velocity`, `material_event_count_90d`, `redflag_count_365d`, `activist_risk_flag`, and `last_filing_date`. Lookups run in parallel. Returns winners for each dimension with deterministic tie-breaking by alphabetical CIK.

- **SEC EDGAR client** (`src/services/edgar.ts`) — Sliding-window rate limiter (8 rps target, 4 max concurrency, 3-attempt exponential backoff). All outbound SEC traffic passes through this single shared limiter.

- **Apify Actor** (`src/actor.ts`) — Default-demo behavior (no input → `get_company_filings_summary` for AAPL), 6-hour KV cache for default-demo results, premium PPE event (`tool-call-premium`) for `get_material_events_digest`, standard PPE event (`tool-call`) for all other tools.

- **MCP entry point** (`src/index.ts`) — stdio and Streamable HTTP transports. All five tools registered with Zod input/output schemas.

- **Smoke test** (`scripts/smoke-test.sh`) — Calls all five tools against the live Apify Actor and validates HTTP 2xx, `meta.source === 'sec_edgar_direct'`, and tool-specific sanity checks.

### Known limitations (addressed in v0.2)

- `insider_signal`, `buy_count`, `sell_count` — null/0 until Form 4 `ownershipDocument` XML parsing is implemented.
- `institutional_signal`, `recent_13f_count` — null/0 until quarterly 13F-HR XBRL/XML parsing is implemented.
- 8-K event descriptions — item codes only (no natural-language summaries) until primary-document HTML text extraction is implemented.
