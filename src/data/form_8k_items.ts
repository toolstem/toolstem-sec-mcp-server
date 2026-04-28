/**
 * 8-K Item code -> plain-English mapping with severity classification.
 *
 * Source: SEC Form 8-K General Instructions (https://www.sec.gov/files/form8-k.pdf)
 * and 17 CFR § 249.308. Item codes are stable since 2004 (last major revision)
 * with one set of additions in 2010 (Item 5.07/5.08) and 2023 (Item 1.05 –
 * cybersecurity incidents).
 *
 * Severity tagging is editorial:
 *   - RED:    likely material adverse — auditor changes (4.02), bankruptcy (1.03),
 *             going-concern (2.06), failure to satisfy listing (3.01), restatement (4.02),
 *             cybersecurity incident (1.05), departure of named executives (5.02 with
 *             specific signals), failure to make timely SEC filing (4.02)
 *   - YELLOW: structural change worth attention — acquisitions/divestitures (2.01),
 *             material agreements (1.01), new debt (2.03), unregistered sales (3.02),
 *             code-of-ethics changes (5.05), executive comp triggers (5.02),
 *             change in registrant's certifying accountant (4.01)
 *   - GREEN:  routine — Reg FD disclosure (7.01), other events (8.01), shareholder
 *             votes (5.07), changes in fiscal year (5.03 minor amendments)
 *
 * The list intentionally covers ALL valid 8-K items so unknown items don't
 * silently fall through. Update when the SEC adds a new item (rare — last
 * was 1.05 in July 2023).
 */

export type ItemSeverity = 'RED' | 'YELLOW' | 'GREEN';

export type ItemCategory =
  | 'material_agreements'
  | 'bankruptcy_or_receivership'
  | 'cybersecurity_incident'
  | 'mine_safety'
  | 'acquisitions_divestitures'
  | 'results_of_operations'
  | 'asset_impairments'
  | 'creation_of_obligation'
  | 'triggering_events_obligations'
  | 'cost_associated_exit_or_disposal'
  | 'going_concern_or_impairment'
  | 'delisting_or_listing_failure'
  | 'unregistered_sales'
  | 'modification_of_rights'
  | 'auditor_change'
  | 'restatement'
  | 'iframework'
  | 'control_change'
  | 'executive_changes'
  | 'amendments_charter_bylaws'
  | 'temporary_suspension_trading'
  | 'code_of_ethics_change'
  | 'shareholder_director_nominations'
  | 'shareholder_vote_results'
  | 'shareholder_director_nominations_proxy'
  | 'asset_backed_securities'
  | 'regulation_fd_disclosure'
  | 'other_events'
  | 'financial_statements_exhibits'
  | 'unknown';

export interface ItemDefinition {
  code: string;
  label: string;
  category: ItemCategory;
  severity: ItemSeverity;
}

const RAW_ITEMS: ItemDefinition[] = [
  // Section 1 — Registrant's Business and Operations
  { code: '1.01', label: 'Entry into a Material Definitive Agreement', category: 'material_agreements', severity: 'YELLOW' },
  { code: '1.02', label: 'Termination of a Material Definitive Agreement', category: 'material_agreements', severity: 'YELLOW' },
  { code: '1.03', label: 'Bankruptcy or Receivership', category: 'bankruptcy_or_receivership', severity: 'RED' },
  { code: '1.04', label: 'Mine Safety – Reporting of Shutdowns and Patterns of Violations', category: 'mine_safety', severity: 'YELLOW' },
  { code: '1.05', label: 'Material Cybersecurity Incidents', category: 'cybersecurity_incident', severity: 'RED' },

  // Section 2 — Financial Information
  { code: '2.01', label: 'Completion of Acquisition or Disposition of Assets', category: 'acquisitions_divestitures', severity: 'YELLOW' },
  { code: '2.02', label: 'Results of Operations and Financial Condition', category: 'results_of_operations', severity: 'GREEN' },
  { code: '2.03', label: 'Creation of a Direct Financial Obligation or Off-Balance-Sheet Arrangement', category: 'creation_of_obligation', severity: 'YELLOW' },
  { code: '2.04', label: 'Triggering Events That Accelerate or Increase a Direct Financial Obligation', category: 'triggering_events_obligations', severity: 'RED' },
  { code: '2.05', label: 'Costs Associated with Exit or Disposal Activities', category: 'cost_associated_exit_or_disposal', severity: 'YELLOW' },
  { code: '2.06', label: 'Material Impairments', category: 'going_concern_or_impairment', severity: 'RED' },

  // Section 3 — Securities and Trading Markets
  { code: '3.01', label: 'Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard', category: 'delisting_or_listing_failure', severity: 'RED' },
  { code: '3.02', label: 'Unregistered Sales of Equity Securities', category: 'unregistered_sales', severity: 'YELLOW' },
  { code: '3.03', label: 'Material Modification to Rights of Security Holders', category: 'modification_of_rights', severity: 'YELLOW' },

  // Section 4 — Matters Related to Accountants and Financial Statements
  { code: '4.01', label: 'Changes in Registrant\'s Certifying Accountant', category: 'auditor_change', severity: 'YELLOW' },
  { code: '4.02', label: 'Non-Reliance on Previously Issued Financial Statements (Restatement)', category: 'restatement', severity: 'RED' },

  // Section 5 — Corporate Governance and Management
  { code: '5.01', label: 'Changes in Control of Registrant', category: 'control_change', severity: 'RED' },
  { code: '5.02', label: 'Departure/Election/Appointment of Directors or Principal Officers; Compensatory Arrangements', category: 'executive_changes', severity: 'YELLOW' },
  { code: '5.03', label: 'Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year', category: 'amendments_charter_bylaws', severity: 'GREEN' },
  { code: '5.04', label: 'Temporary Suspension of Trading Under Registrant\'s Employee Benefit Plans', category: 'temporary_suspension_trading', severity: 'YELLOW' },
  { code: '5.05', label: 'Amendments to the Registrant\'s Code of Ethics, or Waiver of a Provision', category: 'code_of_ethics_change', severity: 'YELLOW' },
  { code: '5.06', label: 'Change in Shell Company Status', category: 'control_change', severity: 'YELLOW' },
  { code: '5.07', label: 'Submission of Matters to a Vote of Security Holders', category: 'shareholder_vote_results', severity: 'GREEN' },
  { code: '5.08', label: 'Shareholder Director Nominations', category: 'shareholder_director_nominations_proxy', severity: 'GREEN' },

  // Section 6 — Asset-Backed Securities
  { code: '6.01', label: 'ABS Informational and Computational Material', category: 'asset_backed_securities', severity: 'GREEN' },
  { code: '6.02', label: 'Change of Servicer or Trustee', category: 'asset_backed_securities', severity: 'YELLOW' },
  { code: '6.03', label: 'Change in Credit Enhancement or Other External Support', category: 'asset_backed_securities', severity: 'YELLOW' },
  { code: '6.04', label: 'Failure to Make a Required Distribution', category: 'asset_backed_securities', severity: 'RED' },
  { code: '6.05', label: 'Securities Act Updating Disclosure', category: 'asset_backed_securities', severity: 'GREEN' },

  // Section 7 — Regulation FD
  { code: '7.01', label: 'Regulation FD Disclosure', category: 'regulation_fd_disclosure', severity: 'GREEN' },

  // Section 8 — Other Events
  { code: '8.01', label: 'Other Events', category: 'other_events', severity: 'GREEN' },

  // Section 9 — Financial Statements and Exhibits
  { code: '9.01', label: 'Financial Statements and Exhibits', category: 'financial_statements_exhibits', severity: 'GREEN' },
];

const ITEM_MAP: Map<string, ItemDefinition> = new Map(
  RAW_ITEMS.map((item) => [item.code, item]),
);

/**
 * Look up an 8-K item code (e.g., "2.01" or "Item 2.01") and return its
 * definition. Returns a synthetic "unknown" record if the code is malformed
 * or not in our catalog (rather than null) so consumers can render
 * gracefully instead of dropping the event.
 */
export function lookupItem(code: string): ItemDefinition {
  const trimmed = (code || '').trim().replace(/^Item\s+/i, '');
  const found = ITEM_MAP.get(trimmed);
  if (found) return found;
  return {
    code: trimmed || 'unknown',
    label: `Unrecognized Item ${trimmed || '?'}`,
    category: 'unknown',
    severity: 'YELLOW', // unknown -> default to attention rather than silently green
  };
}

/** All known 8-K item definitions, exported for tests and docs. */
export const ALL_ITEMS: ReadonlyArray<ItemDefinition> = RAW_ITEMS;
