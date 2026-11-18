import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Agent, Book, Claim, Policy, Quote, RecordRef } from './types'
import { countdown, duration, gen, num, relativeSeconds, stampDate, stampDateTime } from './format'
import { AddressChip, CopyButton, Stamp } from './ui'
import { CONTRACT, DEMO_MODE, NETWORK_NAME, read } from './api'

const METHOD: Record<RecordRef['kind'], string> = {
  agent: 'get_agent',
  quote: 'get_quote',
  policy: 'get_policy',
  claim: 'get_claim',
}

const FLAG_LABELS: Record<string, string> = {
  UNVERIFIED_MANIFEST: 'manifest unbound',
  NO_DATA_POLICY: 'no data policy',
  HIGH_AUTONOMY: 'high autonomy',
  THIN_RECORD: 'thin record',
  PRIOR_CLAIMS: 'prior claims',
}

function findRecord(book: Book, ref: RecordRef): Agent | Quote | Policy | Claim | undefined {
  if (ref.kind === 'agent') return book.agents.find((row) => row.agent_id === ref.id)
  if (ref.kind === 'quote') return book.quotes.find((row) => row.quote_id === ref.id)
  if (ref.kind === 'policy') return book.policies.find((row) => row.policy_id === ref.id)
  return book.claims.find((row) => row.claim_id === ref.id)
}

function statusFor(ref: RecordRef, data: Agent | Quote | Policy | Claim): string {
  if (ref.kind === 'agent') return (data as Agent).status
  if (ref.kind === 'quote') return (data as Quote).decision
  if (ref.kind === 'policy') return (data as Policy).status
  return (data as Claim).status
}

function headerFor(
  ref: RecordRef,
  data: Agent | Quote | Policy | Claim | undefined,
): { title: string; sub: string } {
  if (!data) return { title: ref.id, sub: 'record not in view' }
  if (ref.kind === 'agent') {
    const agent = data as Agent
    return { title: agent.name, sub: agent.agent_id + ' · agent record' }
  }
  if (ref.kind === 'claim') {
    const claim = data as Claim
    return { title: claim.incident_ref, sub: claim.claim_id + ' · ' + claim.policy_id }
  }
  if (ref.kind === 'policy') {
    const policy = data as Policy
    return { title: policy.policy_id, sub: policy.agent_id + ' · cover in force' }
  }
  const quote = data as Quote
  return { title: quote.quote_id, sub: quote.agent_id + ' · underwriting quote' }
}

export function RecordDrawer({
  book,
  record,
  onClose,
  onOpen,
}: {
  book: Book
  record: RecordRef
  onClose: () => void
  onOpen: (ref: RecordRef) => void
}) {
  const base = findRecord(book, record)
  const [live, setLive] = useState<unknown>(null)
  const [reading, setReading] = useState(false)
  const [readInfo, setReadInfo] = useState<{ at: Date; ms: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rawOpen, setRawOpen] = useState(false)

  useEffect(() => {
    setLive(null)
    setReadInfo(null)
    setError(null)
    setRawOpen(false)
  }, [record.kind, record.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.classList.add('record-open')
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('record-open')
    }
  }, [onClose])

  const reread = useCallback(async () => {
    setReading(true)
    setError(null)
    const started = performance.now()
    try {
      const next = await read<unknown>(METHOD[record.kind], [record.id])
      setLive(next)
      setReadInfo({ at: new Date(), ms: Math.round(performance.now() - started) })
    } catch (err) {
      setError(String((err as Error)?.message ?? err).split('\n')[0])
    } finally {
      setReading(false)
    }
  }, [record.kind, record.id])

  const data = (live ?? base) as Agent | Quote | Policy | Claim | undefined
  const header = headerFor(record, data)

  return (
    <>
      <div className="record-backdrop" onMouseDown={onClose} />
      <aside
        className="record"
        role="dialog"
        aria-modal="true"
        aria-label={`${record.kind} ${record.id} on-chain record`}
      >
        <header className="record-head">
          <div>
            <span className="eyebrow">On-chain record · {METHOD[record.kind]}</span>
            <h2>{header.title}</h2>
            <p className="record-sub">{header.sub}</p>
            {data ? <Stamp status={statusFor(record, data)} /> : null}
          </div>
          <button className="record-close" type="button" onClick={onClose} aria-label="Close record" autoFocus>
            ×
          </button>
        </header>

        {!data ? (
          <div className="record-missing">
            <strong>Not in the current page of the book.</strong>
            <p>
              Read <code>{METHOD[record.kind]}</code> directly to check whether this record still exists.
            </p>
            <button className="button button-solid" type="button" onClick={() => void reread()} disabled={reading}>
              {reading ? 'Reading…' : 'Read from contract'}
            </button>
          </div>
        ) : (
          <div className="record-body">
            {record.kind === 'agent' ? <AgentRecord agent={data as Agent} /> : null}
            {record.kind === 'quote' ? <QuoteRecord quote={data as Quote} onOpen={onOpen} /> : null}
            {record.kind === 'policy' ? <PolicyRecord policy={data as Policy} book={book} onOpen={onOpen} /> : null}
            {record.kind === 'claim' ? <ClaimRecord claim={data as Claim} book={book} onOpen={onOpen} /> : null}

            <section className="record-section record-provenance">
              <div className="record-section-head">
                <span className="eyebrow">Provenance</span>
                <h3>Read, not trusted</h3>
              </div>
              <dl className="record-grid">
                <Field label="Method" value={<code>{METHOD[record.kind]}</code>} />
                <Field
                  label="Contract"
                  value={<CopyButton value={CONTRACT} label={`${CONTRACT.slice(0, 10)}…${CONTRACT.slice(-6)}`} />}
                />
                <Field label="Network" value={NETWORK_NAME} />
                <Field
                  label="Last read"
                  value={readInfo ? `${readInfo.at.toLocaleTimeString()} · ${readInfo.ms}ms` : 'page load'}
                />
              </dl>
              {error ? <p className="record-error">{error}</p> : null}
              <div className="record-actions">
                {DEMO_MODE ? (
                  <span className="record-demo">Declared demo book — this record is not on chain.</span>
                ) : (
                  <button className="button button-quiet" type="button" onClick={() => void reread()} disabled={reading}>
                    {reading ? 'Reading…' : 'Re-read from contract'}
                  </button>
                )}
                <button className="button button-quiet" type="button" onClick={() => setRawOpen((open) => !open)}>
                  {rawOpen ? 'Hide raw JSON' : 'Show raw JSON'}
                </button>
              </div>
              {rawOpen ? <pre className="record-raw">{stringify(data)}</pre> : null}
            </section>
          </div>
        )}
      </aside>
    </>
  )
}

function AgentRecord({ agent }: { agent: Agent }) {
  return (
    <>
      <section className="record-section record-ai">
        <div className="record-section-head">
          <span className="eyebrow">AI consensus · attestation</span>
          <h3>{agent.verified ? 'Manifest bound to the wallet' : 'Manifest not yet accepted'}</h3>
        </div>
        <div className="record-verdict">
          <strong>{agent.verified ? 'ATTESTED' : 'UNVERIFIED'}</strong>
          <span>{agent.autonomy_level.toLowerCase()} autonomy</span>
          <span className="record-verdict-side">{num(agent.reputation)} / 1000 reputation</span>
        </div>
        <p className="record-reason">“{agent.attestation_summary || 'No attestation summary recorded.'}”</p>
        <div className="traits">
          <Trait label="Operator wallet named" value={agent.wallet_listed} />
          <Trait label="Agent name named" value={agent.name_listed} />
          <Trait label="Data policy published" value={agent.data_policy_present} />
          <Trait label="Security contact" value={agent.security_contact_present} />
        </div>
        <p className="record-note">
          The contract checks the wallet and name substrings itself. The model only classifies the manifest
          fields; validators must return the same six derived values.
        </p>
      </section>

      <section className="record-section">
        <div className="record-section-head">
          <span className="eyebrow">Contract record</span>
          <h3>Exposure</h3>
        </div>
        <dl className="record-grid">
          <Field label="Operator" value={<AddressChip address={agent.owner} />} />
          <Field label="Agent wallet" value={<AddressChip address={agent.wallet} />} />
          <Field label="Bond" value={`${gen(agent.bond_atto)} GEN`} />
          <Field label="Status" value={<Stamp status={agent.status} />} />
          <Field label="Policies issued" value={num(agent.policies)} />
          <Field label="Claims / upheld" value={`${num(agent.claims)} / ${num(agent.upheld_claims)}`} />
          <Field label="Lifetime payouts" value={`${gen(agent.paid_atto)} GEN`} />
          <Field label="Registered" value={stampDate(agent.created_at)} />
        </dl>
        <p className="record-terms">
          <strong>Capabilities</strong> {agent.capabilities || '—'}
        </p>
        <p className="record-terms">
          <strong>Manifest</strong>{' '}
          <a href={agent.manifest_url} target="_blank" rel="noreferrer">
            {agent.manifest_url}
          </a>
        </p>
      </section>
    </>
  )
}

function QuoteRecord({ quote, onOpen }: { quote: Quote; onOpen: (ref: RecordRef) => void }) {
  const coverage = num(quote.coverage_atto) / 1e18
  const rate = num(quote.rate_bps) / 100
  const days = num(quote.term_days)
  return (
    <>
      <section className="record-section record-ai">
        <div className="record-section-head">
          <span className="eyebrow">AI consensus · underwriting</span>
          <h3>{quote.decision === 'ACCEPT' ? 'Cover priced' : 'Cover refused'}</h3>
        </div>
        <div className="record-verdict">
          <strong>{quote.decision}</strong>
          <span>{rate.toFixed(2)}% rate</span>
          <span className="record-verdict-side">{num(quote.confidence)}% model confidence</span>
        </div>
        <div className="score-row">
          <Score label="Misbehaviour risk" value={num(quote.risk_score)} />
          <Score label="Data-leak risk" value={num(quote.data_leak_risk)} />
        </div>
        {quote.flags ? (
          <div className="flags">
            {quote.flags.split(',').map((flag) => (
              <span key={flag} className="flag">
                {FLAG_LABELS[flag] ?? flag.toLowerCase()}
              </span>
            ))}
          </div>
        ) : null}
        <p className="record-reason">“{quote.rationale}”</p>
        <p className="record-note">
          Validators accept the decision exactly. Risk, leak, and flags are derived from the attestation and
          the on-chain record, not from model prose, so the premium below is identical on every node.
        </p>
      </section>

      <section className="record-section">
        <div className="record-section-head">
          <span className="eyebrow">Contract arithmetic</span>
          <h3>Premium</h3>
        </div>
        <dl className="record-grid">
          <Field label="Coverage" value={`${gen(quote.coverage_atto)} GEN`} />
          <Field label="Deductible" value={`${gen(quote.deductible_atto)} GEN`} />
          <Field label="Rate" value={`${rate.toFixed(2)}%`} />
          <Field label="Protocol fee" value={`${(num(quote.fee_bps) / 100).toFixed(2)}%`} />
          <Field label="Term" value={`${days} days`} />
          <Field label="Data in scope" value={quote.data_scope || '—'} />
          <Field label="Premium" value={`${gen(quote.premium_atto, 4)} GEN`} accent />
          <Field label="Quote expires" value={`${stampDate(quote.expires_at)} · ${countdown(quote.expires_at)}`} />
          <Field label="Bound" value={quote.bound ? 'yes' : 'no'} />
          <Field label="Requester" value={<AddressChip address={quote.requester} />} />
        </dl>
        <pre className="formula">
          {`${coverage.toLocaleString('en-US')} GEN × ${rate.toFixed(2)}% × ${days} / 365\n= ${gen(quote.premium_atto, 4)} GEN`}
        </pre>
        <p className="record-terms">
          <strong>Excludes</strong> {quote.exclusions || '—'}
        </p>
        <p className="record-terms">
          <strong>Conditions</strong> {quote.conditions || '—'}
        </p>
        <button
          className="button button-quiet"
          type="button"
          onClick={() => onOpen({ kind: 'agent', id: quote.agent_id })}
        >
          Open agent record
        </button>
      </section>
    </>
  )
}

function PolicyRecord({
  policy,
  book,
  onOpen,
}: {
  policy: Policy
  book: Book
  onOpen: (ref: RecordRef) => void
}) {
  const quote = book.quotes.find((row) => row.quote_id === policy.quote_id)
  const utilisation =
    num(policy.coverage_atto) > 0 ? (num(policy.paid_atto) / num(policy.coverage_atto)) * 100 : 0
  return (
    <>
      <section className="record-section">
        <div className="record-section-head">
          <span className="eyebrow">Cover in force</span>
          <h3>{policy.status === 'ACTIVE' ? 'Live exposure' : policy.status.toLowerCase()}</h3>
        </div>
        <dl className="record-grid">
          <Field label="Agent" value={policy.agent_id} />
          <Field label="Holder" value={<AddressChip address={policy.holder} />} />
          <Field label="Coverage" value={`${gen(policy.coverage_atto)} GEN`} accent />
          <Field label="Remaining" value={`${gen(policy.remaining_atto)} GEN`} />
          <Field label="Deductible" value={`${gen(policy.deductible_atto)} GEN`} />
          <Field label="Premium paid" value={`${gen(policy.premium_atto, 4)} GEN`} />
          <Field label="Protocol fee" value={`${gen(policy.fee_atto, 4)} GEN`} />
          <Field label="Report window" value={`${duration(policy.report_window)} after expiry`} />
          <Field
            label="Underwriting"
            value={quote ? `${quote.decision} · ${(num(quote.rate_bps) / 100).toFixed(2)}%` : '—'}
          />
          <Field label="Claims / open" value={`${num(policy.claims)} / ${num(policy.open_claims)}`} />
          <Field label="Paid out" value={`${gen(policy.paid_atto)} GEN`} />
          <Field label="Starts" value={stampDate(policy.start_at)} />
          <Field label="Ends" value={`${stampDate(policy.end_at)} · ${countdown(policy.end_at)}`} />
        </dl>
        <div className="utilisation">
          <div className="utilisation-head">
            <span>Limit used</span>
            <strong>{utilisation.toFixed(1)}%</strong>
          </div>
          <div className="utilisation-track">
            <span style={{ width: `${Math.min(100, utilisation)}%` }} />
          </div>
        </div>
        <p className="record-terms">
          <strong>Perils</strong> {policy.perils}
        </p>
        <p className="record-terms">
          <strong>Data in scope</strong> {policy.data_scope || '—'}
        </p>
        <p className="record-terms">
          <strong>Excludes</strong> {policy.exclusions || '—'}
        </p>
        <div className="record-actions">
          <button className="button button-quiet" type="button" onClick={() => onOpen({ kind: 'quote', id: policy.quote_id })}>
            Underwriting record
          </button>
          <button className="button button-quiet" type="button" onClick={() => onOpen({ kind: 'agent', id: policy.agent_id })}>
            Agent record
          </button>
        </div>
      </section>

      {quote ? (
        <section className="record-section record-ai">
          <div className="record-section-head">
            <span className="eyebrow">AI consensus inherited</span>
            <h3>
              {quote.decision} at {num(quote.risk_score)} risk
            </h3>
          </div>
          <div className="score-row">
            <Score label="Misbehaviour risk" value={num(quote.risk_score)} />
            <Score label="Data-leak risk" value={num(quote.data_leak_risk)} />
          </div>
          <p className="record-reason">“{quote.rationale}”</p>
        </section>
      ) : null}
    </>
  )
}

function ClaimRecord({
  claim,
  book,
  onOpen,
}: {
  claim: Claim
  book: Book
  onOpen: (ref: RecordRef) => void
}) {
  const policy = book.policies.find((row) => row.policy_id === claim.policy_id)
  const sources = claim.cited_sources
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean)
  const fingerprints = (claim.evidence_digests || '').split('; ').filter(Boolean)
  return (
    <>
      <section className="record-section record-ai">
        <div className="record-section-head">
          <span className="eyebrow">AI consensus · adjudication</span>
          <h3>
            {claim.verdict === 'PAY'
              ? 'Loss proven, payout approved'
              : claim.verdict === 'DENY'
                ? 'Loss not proven'
                : 'Evidence did not settle'}
          </h3>
        </div>
        <div className="record-verdict">
          <strong>{claim.verdict || 'UNJUDGED'}</strong>
          <span>{claim.covered_peril || 'peril pending'}</span>
          <span className="record-verdict-side">
            {claim.verdict === 'PAY' ? `${(num(claim.payout_ratio_bps) / 100).toFixed(0)}% of claim` : 'no payout'}
          </span>
        </div>
        <div className="score-row score-row-three">
          <Score label="Confidence" value={num(claim.confidence)} tone="trust" />
          <Score label="Evidence quality" value={num(claim.evidence_quality)} tone="trust" />
          <Score label="Payout ratio" value={num(claim.payout_ratio_bps) / 100} suffix="%" tone="trust" />
        </div>
        {claim.fraud_suspected ? <p className="record-alert">Fraud indicators were flagged on this claim.</p> : null}
        <p className="record-reason">“{claim.rationale || 'No adjudication rationale recorded yet.'}”</p>
        {sources.length ? (
          <div className="record-sources">
            <span className="eyebrow">Cited sources</span>
            <ul>
              {sources.map((source) => (
                <li key={source}>
                  {/^https?:\/\//.test(source) ? (
                    <a href={source} target="_blank" rel="noreferrer">
                      {source.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    source
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {claim.corroboration_required ? (
          <p className="record-alert">
            Large payout rule: {claim.corroboration_met ? 'met' : 'not met'} —{' '}
            {claim.corroboration_domains || 'no usable claimant host'}.
          </p>
        ) : null}
        {fingerprints.length ? (
          <div className="record-sources">
            <span className="eyebrow">Source fingerprints</span>
            <ul>
              {fingerprints.map((row) => {
                const [index, digest] = row.split(':', 2)
                return (
                  <li key={row}>
                    <span>source {index}</span> <code title={digest}>{digest}</code>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
        <p className="record-note">
          Validators re-read the same evidence and must agree on the verdict, covered peril, and usable source
          hosts exactly. A payout above 10% of the limit (floor 100 GEN) needs two independent claimant hosts.
          The payout ratio is snapped to five-percent bands, so the money is the same on every node.
        </p>
      </section>

      <section className="record-section">
        <div className="record-section-head">
          <span className="eyebrow">Contract arithmetic</span>
          <h3>Payout</h3>
        </div>
        <dl className="record-grid">
          <Field label="Claimed" value={`${gen(claim.claimed_atto)} GEN`} />
          <Field label="Ratio" value={`${(num(claim.payout_ratio_bps) / 100).toFixed(2)}%`} />
          <Field label="Deductible" value={policy ? `${gen(policy.deductible_atto)} GEN` : '—'} />
          <Field label="Approved" value={`${gen(claim.payout_atto)} GEN`} accent />
          <Field label="Bond applied" value={`${gen(claim.bond_slashed_atto)} GEN`} />
          <Field label="Shortfall" value={`${gen(claim.shortfall_atto)} GEN`} />
          <Field
            label="Corroboration"
            value={
              claim.corroboration_required
                ? `${claim.corroboration_met ? 'met' : 'not met'} · ${claim.corroboration_domains || 'none'}`
                : 'not required'
            }
          />
          <Field label="Appeal bond" value={`${gen(claim.appeal_bond_atto)} GEN`} />
          <Field label="Appeal window" value={duration(claim.appeal_window)} />
          <Field label="Payout obligation" value={claim.payout_status ? claim.payout_status.toLowerCase() : '—'} />
          <Field label="Payout id" value={claim.payout_id || '—'} />
          <Field label="Response" value={(claim.defense_status || 'OPEN').toLowerCase()} />
          <Field label="Attempts" value={num(claim.attempts)} />
          <Field label="Settled" value={claim.settled ? 'yes' : 'no'} />
        </dl>
        <pre className="formula">
          {`min(${gen(claim.claimed_atto)} × ${(num(claim.payout_ratio_bps) / 100).toFixed(0)}%, limit now ${policy ? gen(policy.remaining_atto) : '—'})\n− deductible ${policy ? gen(policy.deductible_atto) : '—'} = ${gen(claim.payout_atto)} GEN`}
        </pre>
        {num(claim.payout_atto) > 0 && !claim.settled ? (
          <p className="record-note">
            Money leaves the pool through a payout obligation. It becomes settled only when the recipient
            confirms delivery; a returned transfer reopens the obligation for retry.
          </p>
        ) : null}
      </section>

      <section className="record-section">
        <div className="record-section-head">
          <span className="eyebrow">Docket</span>
          <h3>Lifecycle</h3>
        </div>
        <ol className="timeline">
          <TimelineItem label="Filed" at={claim.filed_at} done />
          <TimelineItem
            label={claim.defense_status === 'FILED' ? 'Defence filed' : 'Response window closes'}
            at={claim.defense_status === 'FILED' ? claim.adjudicated_at : claim.defense_deadline}
            done={claim.defense_status === 'FILED' || num(claim.adjudicated_at) > 0}
          />
          <TimelineItem label="Adjudicated" at={claim.adjudicated_at} done={num(claim.adjudicated_at) > 0} />
          <TimelineItem
            label={claim.appealed ? 'Appealed' : 'Appeal window closes'}
            at={claim.appealed ? claim.adjudicated_at : claim.appeal_deadline}
            done={claim.appealed}
          />
          <TimelineItem
            label="Payout sent"
            at={claim.settled || claim.payout_id ? claim.appeal_deadline : 0}
            done={Boolean(claim.payout_id)}
          />
          <TimelineItem label="Payout confirmed" at={claim.settled ? claim.appeal_deadline : 0} done={claim.settled} />
        </ol>
        <p className="record-terms">
          <strong>Policy</strong> {claim.policy_id} · {claim.agent_id}
        </p>
        <p className="record-terms">
          <strong>Claimant</strong> <AddressChip address={claim.claimant} />
        </p>
        <p className="record-terms">
          <strong>Evidence on file</strong>{' '}
          {claim.evidence ? claim.evidence.split('\n').filter(Boolean).length + ' source(s)' : 'none yet'}
        </p>
        {claim.evidence ? (
          <div className="record-sources">
            <ul>
              {claim.evidence
                .split('\n')
                .filter(Boolean)
                .map((url) => (
                  <li key={url}>
                    <a href={url} target="_blank" rel="noreferrer">
                      {url.replace(/^https?:\/\//, '')}
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        <div className="record-actions">
          <button className="button button-quiet" type="button" onClick={() => onOpen({ kind: 'policy', id: claim.policy_id })}>
            Policy record
          </button>
          <button className="button button-quiet" type="button" onClick={() => onOpen({ kind: 'agent', id: claim.agent_id })}>
            Agent record
          </button>
        </div>
      </section>
    </>
  )
}

function Score({
  label,
  value,
  suffix = '',
  tone = 'risk',
}: {
  label: string
  value: number
  suffix?: string
  tone?: 'risk' | 'trust'
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  const band =
    tone === 'risk'
      ? clamped >= 70
        ? 'bad'
        : clamped >= 40
          ? 'warn'
          : 'good'
      : clamped >= 70
        ? 'good'
        : clamped >= 40
          ? 'warn'
          : 'bad'
  return (
    <div className={`score score-${band}`}>
      <div className="score-head">
        <span>{label}</span>
        <strong>
          {Number.isInteger(value) ? value : value.toFixed(1)}
          {suffix}
        </strong>
      </div>
      <div className="score-track">
        <span style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}

function Trait({ label, value }: { label: string; value: boolean }) {
  return (
    <div className={value ? 'trait trait-yes' : 'trait trait-no'}>
      <span className="trait-mark">{value ? '✓' : '—'}</span>
      <span>{label}</span>
    </div>
  )
}

function Field({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className={accent ? 'field-accent' : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function TimelineItem({ label, at, done }: { label: string; at: number | bigint | string; done?: boolean }) {
  return (
    <li className={done ? 'timeline-done' : 'timeline-wait'}>
      <span className="timeline-dot" />
      <div>
        <strong>{label}</strong>
        <span>{num(at) > 0 ? `${stampDateTime(at)} · ${relativeSeconds(at)}` : 'pending'}</span>
      </div>
    </li>
  )
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === 'bigint' ? item.toString() : item),
    2,
  )
}
