export type Num = bigint | number | string

export type TxStage =
  | 'SIGNING'
  | 'SUBMITTED'
  | 'CONSENSUS'
  | 'ACCEPTED'
  | 'FINALIZED'
  | 'UNDETERMINED'
  | 'CANCELED'
  | 'TIMEOUT'
  | 'FAILED'

export interface TxVotes {
  agree: number
  disagree: number
  total: number
}

export type RecordKind = 'agent' | 'quote' | 'policy' | 'claim'

export interface RecordRef {
  kind: RecordKind
  id: string
}

export interface TxRun {
  id: string
  label: string
  fn: string
  hash?: string
  stage: TxStage
  status?: string
  startedAt: number
  endedAt?: number
  ok?: boolean
  execution?: string
  payload?: string
  votes?: TxVotes
  rounds?: number
  ai: boolean
  error?: string
  record?: RecordRef
}

export interface Terms {
  operator: string
  fee_bps: Num
  min_bond_atto: Num
  min_premium_atto: Num
  min_coverage_atto: Num
  max_coverage_atto: Num
  min_lp_deposit_atto: Num
  min_evidence_urls: Num
  quote_ttl: Num
  appeal_window: Num
  report_window: Num
  min_appeal_bond_atto: Num
}

export interface Pool {
  assets_atto: Num
  reserved_atto: Num
  free_atto: Num
  total_shares: Num
  treasury_atto: Num
  pending_payout_atto: Num
  payouts_total: Num
  share_price_atto: Num
}

export interface Stats {
  agents_registered: Num
  attestations: Num
  quotes: Num
  policies_bound: Num
  policies_closed: Num
  claims_filed: Num
  claims_approved: Num
  claims_denied: Num
  claims_paid: Num
  claims_undetermined: Num
  appeals: Num
  appeals_upheld: Num
  appeals_overturned: Num
  appeals_denied: Num
  lp_deposits: Num
  lp_withdrawals: Num
  paid_atto_total: Num
  premium_atto_total: Num
  bond_slashed_atto: Num
  corroboration_denials: Num
  agents_suspended: Num
  agents_total: Num
  policies_total: Num
  claims_total: Num
  evidence_min_urls: Num
}

export interface Agent {
  agent_id: string
  owner: string
  wallet: string
  name: string
  capabilities: string
  manifest_url: string
  bond_atto: Num
  status: string
  reputation: Num
  verified: boolean
  wallet_listed: boolean
  name_listed: boolean
  data_policy_present: boolean
  security_contact_present: boolean
  autonomy_level: string
  attestation_summary: string
  created_at: Num
  policies: Num
  claims: Num
  upheld_claims: Num
  paid_atto: Num
  bond_slashed_atto: Num
}

export interface Quote {
  quote_id: string
  agent_id: string
  requester: string
  coverage_atto: Num
  deductible_atto: Num
  term_days: Num
  perils: string
  data_scope: string
  decision: string
  risk_score: Num
  data_leak_risk: Num
  rate_bps: Num
  fee_bps: Num
  premium_atto: Num
  exclusions: string
  conditions: string
  rationale: string
  flags: string
  confidence: Num
  created_at: Num
  expires_at: Num
  bound: boolean
}

export interface Policy {
  policy_id: string
  quote_id: string
  agent_id: string
  holder: string
  coverage_atto: Num
  remaining_atto: Num
  deductible_atto: Num
  premium_atto: Num
  fee_atto: Num
  report_window: Num
  perils: string
  data_scope: string
  exclusions: string
  risk_score: Num
  start_at: Num
  end_at: Num
  status: string
  claims: Num
  open_claims: Num
  paid_atto: Num
}

export interface Claim {
  claim_id: string
  policy_id: string
  agent_id: string
  claimant: string
  incident_ref: string
  incident_type: string
  description: string
  claimed_atto: Num
  evidence: string
  status: string
  verdict: string
  covered_peril: string
  payout_ratio_bps: Num
  payout_atto: Num
  fraud_suspected: boolean
  confidence: Num
  evidence_quality: Num
  rationale: string
  cited_sources: string
  filed_at: Num
  adjudicated_at: Num
  appeal_deadline: Num
  attempts: Num
  appealed: boolean
  appellant: string
  appeal_bond_atto: Num
  shortfall_atto: Num
  settled: boolean
  defense_evidence: string
  defense_statement: string
  defense_deadline: Num
  defense_status: string
  response_waived: boolean
  appeal_expires_at: Num
  prior_status: string
  appeal_window: Num
  payout_id: string
  payout_status: string
  evidence_status: string
  evidence_digests: string
  corroboration_domains: string
  corroboration_required: boolean
  corroboration_met: boolean
  bond_slashed_atto: Num
}

export interface Payout {
  payout_id: string
  kind: string
  ref: string
  claim_id: string
  recipient: string
  amount_atto: Num
  status: string
  created_at: Num
  sent_at: Num
  attempts: Num
  reputation_penalty: Num
}

export interface Book {
  terms: Terms
  pool: Pool
  stats: Stats
  agents: Agent[]
  quotes: Quote[]
  policies: Policy[]
  claims: Claim[]
  shares?: { holder: string; shares: string; value_atto: string }
}
