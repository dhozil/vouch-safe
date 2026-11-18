import { useCallback, useEffect, useState } from 'react'
import type { Agent, Book, Claim, RecordRef, TxRun } from './types'
import {
  CONTRACT,
  DEMO_MODE,
  IS_CONFIGURED,
  NETWORK_NAME,
  connectWallet,
  prettyError,
  read,
  walletClient,
  write,
  type WriteResult,
} from './api'
import { atto, countdown, gen, num, shortAddress, stampDate } from './format'
import { AddressChip, CopyButton, Empty, Metric, Reputation, SolvencyGauge, Stamp } from './ui'
import { Desk } from './Desk'
import { RecordDrawer } from './Record'
import { demoBook } from './demo'

type Notice = { kind: 'ok' | 'err' | 'info'; text: string }

const AI_METHODS = new Set(['attest_agent', 'request_quote', 'adjudicate_claim', 'resolve_appeal'])

export default function App() {
  const [book, setBook] = useState<Book | null>(DEMO_MODE ? demoBook() : null)
  const [loading, setLoading] = useState(!DEMO_MODE)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [runs, setRuns] = useState<TxRun[]>([])
  const [detail, setDetail] = useState<RecordRef | null>(null)

  const refresh = useCallback(async (): Promise<Book | null> => {
    if (DEMO_MODE) return demoBook()
    if (!IS_CONFIGURED) {
      setLoading(false)
      return null
    }
    try {
      const [terms, pool, stats, agentIds, policyIds, claimIds, quoteIds] = await Promise.all([
        read<Book['terms']>('get_terms'),
        read<Book['pool']>('get_pool'),
        read<Book['stats']>('get_stats'),
        read<string[]>('list_agents', [0, 100]),
        read<string[]>('list_policies', [0, 100]),
        read<string[]>('list_claims', [0, 100]),
        read<string[]>('list_quotes', [0, 100]),
      ])
      const [agents, policies, claims, quotes] = await Promise.all([
        Promise.all(agentIds.map((id) => read<Agent>('get_agent', [id]))),
        Promise.all(policyIds.map((id) => read<Book['policies'][number]>('get_policy', [id]))),
        Promise.all(claimIds.map((id) => read<Claim>('get_claim', [id]))),
        Promise.all(quoteIds.map((id) => read<Book['quotes'][number]>('get_quote', [id]))),
      ])
      let shares: Book['shares']
      if (account) {
        try {
          shares = await read<NonNullable<Book['shares']>>('get_shares', [account])
        } catch {
          shares = undefined
        }
      }
      const next: Book = {
        terms,
        pool,
        stats,
        agents,
        policies,
        claims,
        quotes,
        shares,
      }
      setBook(next)
      setLoadError(null)
      return next
    } catch (error) {
      setLoadError(prettyError(error))
      return null
    } finally {
      setLoading(false)
    }
  }, [account])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function onConnect() {
    try {
      const address = await connectWallet()
      setAccount(address)
      setNotice({ kind: 'ok', text: 'Wallet connected on ' + NETWORK_NAME + '.' })
    } catch (error) {
      setNotice({ kind: 'err', text: prettyError(error) })
    }
  }

  async function run(
    label: string,
    fn: string,
    args: unknown[],
    value = 0n,
    record?: RecordRef,
  ): Promise<WriteResult | null> {
    if (DEMO_MODE) {
      setNotice({ kind: 'info', text: 'This is a declared demo book — connect a contract to write.' })
      return null
    }
    if (!account || !window.ethereum) {
      setNotice({ kind: 'err', text: 'Connect a wallet before writing to the contract.' })
      return null
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const startedAt = Date.now()
    const ai = AI_METHODS.has(fn)
    const patch = (next: Partial<TxRun>) =>
      setRuns((prev) => prev.map((item) => (item.id === id ? { ...item, ...next } : item)))

    setBusy(label)
    setNotice(null)
    setRuns((prev) =>
      [
        { id, label, fn, stage: 'SIGNING' as const, startedAt, ai, record },
        ...prev,
      ].slice(0, 12),
    )

    try {
      const client = walletClient(account, window.ethereum)
      const result = await write(client, fn, args, value, (meta) => {
        const next: Partial<TxRun> = { stage: meta.stage }
        if (meta.status) next.status = meta.status
        if (meta.hash) next.hash = meta.hash
        patch(next)
      })
      const stage: TxRun['stage'] =
        result.status === 'FINALIZED'
          ? 'FINALIZED'
          : result.status === 'CANCELED'
            ? 'CANCELED'
            : 'UNDETERMINED'
      patch({
        stage,
        status: result.status,
        hash: result.hash,
        endedAt: Date.now(),
        ok: result.ok,
        execution: result.execution,
        payload: result.payload,
        votes: result.votes,
        rounds: result.rounds,
      })
      if (!result.ok) {
        setNotice({ kind: 'err', text: result.execution || 'Execution reverted.' })
        return null
      }
      return result
    } catch (error) {
      const message = prettyError(error)
      patch({ stage: 'FAILED', endedAt: Date.now(), ok: false, error: message })
      setNotice({ kind: 'err', text: message })
      return null
    } finally {
      setBusy(null)
    }
  }

  async function appeal(claim: Claim) {
    const minimum = atto(book?.terms.min_appeal_bond_atto)
    if (claim.status === 'PAY_PENDING') {
      const required = (atto(claim.payout_atto) * 2000n) / 10000n
      const bond = required > minimum ? required : minimum
      await run('Appeal filed', 'appeal_claim', [claim.claim_id], bond)
    } else {
      await run('Appeal filed', 'appeal_claim', [claim.claim_id], minimum)
    }
    await refresh()
  }

  async function confirmPayout(claim: Claim) {
    if (!claim.payout_id) return
    const result = await run('Payout confirmed', 'confirm_payout', [claim.payout_id], 0n, {
      kind: 'claim',
      id: claim.claim_id,
    })
    await refresh()
    if (result) setDetail({ kind: 'claim', id: claim.claim_id })
  }

  async function retryPayout(claim: Claim) {
    if (!claim.payout_id) return
    const result = await run('Payout retried', 'retry_payout', [claim.payout_id], 0n, {
      kind: 'claim',
      id: claim.claim_id,
    })
    await refresh()
    if (result) setDetail({ kind: 'claim', id: claim.claim_id })
  }

  async function act(label: string, fn: string, claim: Claim) {
    const result = await run(label, fn, [claim.claim_id], 0n, { kind: 'claim', id: claim.claim_id })
    await refresh()
    if (result) setDetail({ kind: 'claim', id: claim.claim_id })
  }

  if (!IS_CONFIGURED) {
    return (
      <main className="setup">
        <span className="eyebrow">Vouchsafe</span>
        <h1>Point the desk at a contract.</h1>
        <p>
          Set <code>VITE_CONTRACT_ADDRESS</code> in <code>frontend/.env.local</code> to a deployed
          <code>vouchsafe.py</code>, then restart the dev server.
        </p>
        <pre>
          {`# frontend/.env.local
VITE_NETWORK=studionet
VITE_CONTRACT_ADDRESS=0x…`}
        </pre>
        <p className="setup-note">
          Deploy one with <code>genlayer deploy --contract contracts/vouchsafe.py --args 500 500000000000000000</code>.
        </p>
      </main>
    )
  }

  if (loading) {
    return (
      <main className="setup">
        <span className="eyebrow">Vouchsafe</span>
        <h1>Reading the book…</h1>
        <p className="setup-note">First read from {NETWORK_NAME}. Large books take a moment to page in.</p>
      </main>
    )
  }

  if (!book) {
    return (
      <main className="setup">
        <span className="eyebrow">Vouchsafe</span>
        <h1>The book did not load.</h1>
        <p>{loadError ?? 'The contract did not answer.'}</p>
        <button className="button button-solid" type="button" onClick={() => void refresh()}>
          Try again
        </button>
      </main>
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const activePolicies = book.policies.filter((policy) => policy.status === 'ACTIVE')
  const coveredAgents = book.agents.filter((agent) => num(agent.policies) > 0).length
  const openClaims = book.claims.filter((claim) => !claim.settled)

  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="#top" aria-label="Vouchsafe home">
          <span className="brand-mark">VS</span>
          <span className="brand-word">Vouchsafe</span>
        </a>
        <nav className="rail-nav" aria-label="Ledger">
          <a href="#book">01 · The book</a>
          <a href="#agents">02 · Agents</a>
          <a href="#policies">03 · Policies</a>
          <a href="#claims">04 · Claims</a>
        </nav>
        <div className="rail-foot">
          <div className="rail-line">
            <span>Network</span>
            <strong>{NETWORK_NAME}{DEMO_MODE ? ' · demo' : ''}</strong>
          </div>
          <div className="rail-line">
            <span>Contract</span>
            <CopyButton value={CONTRACT} label={shortAddress(CONTRACT)} />
          </div>
          <div className="rail-line">
            <span>Signer</span>
            <strong>{account ? shortAddress(account) : 'read only'}</strong>
          </div>
          <p className="rail-note">
            Liability cover for autonomous agents. Misbehaviour and data leaks, judged on evidence, paid
            from a reserved pool.
          </p>
        </div>
      </aside>

      <main className="desk" id="top">
        <header className="masthead">
          <div className="masthead-copy">
            <span className="eyebrow">GenLayer · agentic commerce</span>
            <h1>
              Cover for agents
              <br />
              that act on their own.
            </h1>
            <p className="masthead-lede">
              Underwriting, claims, and a bonded appeal in one Intelligent Contract. Validators read the
              manifest and the evidence; the contract does the arithmetic.
            </p>
            <div className="masthead-tags">
              <span className="tag">Misbehaviour</span>
              <span className="tag">Data leak</span>
              <span className="tag">Bonded appeal</span>
              <span className="tag">{book.terms ? (num(book.terms.fee_bps) / 100).toFixed(1) + '% protocol fee' : ''}</span>
              {DEMO_MODE ? <span className="tag tag-demo">declared demo book</span> : null}
            </div>
          </div>
          <SolvencyGauge pool={book.pool} />
        </header>

        {notice ? (
          <div className={'notice notice-' + notice.kind} role="status">
            <span>{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ) : null}

        <section className="book" id="book">
          <div className="section-head">
            <span className="eyebrow">01 · The book</span>
            <h2>The risk ledger</h2>
            <p>
              Capital is reserved the moment cover binds. Premiums accrue to the pool; the protocol fee is
              ring-fenced.
            </p>
          </div>
          <div className="metrics">
            <Metric
              label="Capital"
              value={gen(book.pool.assets_atto) + ' GEN'}
              detail={
                gen(book.pool.reserved_atto) +
                ' GEN reserved against ' +
                activePolicies.length +
                ' live policies · ' +
                gen(book.pool.pending_payout_atto) +
                ' GEN in flight'
              }
              accent
            />
            <Metric
              label="Premium earned"
              value={gen(book.stats.premium_atto_total ?? 0) + ' GEN'}
              detail={num(book.stats.policies_bound) + ' policies bound'}
            />
            <Metric
              label="Claims paid"
              value={num(book.stats.claims_paid) + ' · ' + gen(book.stats.paid_atto_total) + ' GEN'}
              detail={num(book.stats.claims_filed) + ' filed, ' + num(book.stats.appeals) + ' appealed'}
            />
            <Metric
              label="Agents covered"
              value={String(coveredAgents)}
              detail={num(book.stats.agents_registered) + ' registered, ' + num(book.stats.attestations) + ' attested'}
            />
          </div>
        </section>

        <section className="section" id="agents">
          <div className="section-head">
            <span className="eyebrow">02 · Agents</span>
            <h2>Who is on the hook</h2>
            <p>An agent earns cover by publishing a manifest and putting a bond behind its behaviour.</p>
          </div>
          {book.agents.length === 0 ? (
            <Empty title="No agents registered">
              Register an agent in the desk. The manifest must name the operator wallet for attestation to pass.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Wallet</th>
                    <th>Reputation</th>
                    <th>Bond · GEN</th>
                    <th>Cover · GEN</th>
                    <th>Record</th>
                    <th>Standing</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {book.agents.map((agent) => (
                    <tr key={agent.agent_id}>
                      <td>
                        <strong>{agent.name}</strong>
                        <span className="cell-sub">{agent.agent_id} · {agent.autonomy_level.toLowerCase()}</span>
                      </td>
                      <td>
                        <AddressChip address={agent.wallet} />
                        {agent.verified ? <span className="verified" title={agent.attestation_summary}>verified</span> : <span className="unverified">unverified</span>}
                      </td>
                      <td>
                        <Reputation value={num(agent.reputation)} />
                      </td>
                      <td className="num">{gen(agent.bond_atto)}</td>
                      <td className="num">
                        {num(agent.policies)} issued
                        <span className="cell-sub">{num(agent.claims)} paid · {num(agent.upheld_claims)} upheld</span>
                      </td>
                      <td className="num">
                        {gen(agent.paid_atto)} GEN
                        <span className="cell-sub">lifetime payouts</span>
                      </td>
                      <td>
                        <Stamp status={agent.status} />
                      </td>
                      <td className="cell-action">
                        <div className="row-actions">
                          <button
                            className="button button-quiet"
                            type="button"
                            onClick={() => setDetail({ kind: 'agent', id: agent.agent_id })}
                          >
                            Record
                          </button>
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={async () => {
                              const result = await run('Manifest fetched', 'attest_agent', [agent.agent_id], 0n, {
                                kind: 'agent',
                                id: agent.agent_id,
                              })
                              await refresh()
                              if (result) setDetail({ kind: 'agent', id: agent.agent_id })
                            }}
                          >
                            Attest
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section" id="policies">
          <div className="section-head">
            <span className="eyebrow">03 · Policies</span>
            <h2>Cover in force</h2>
            <p>
              Every policy carries its perils, scope, and remaining limit. Deductibles apply before the pool
              pays.
            </p>
          </div>
          {book.policies.length === 0 ? (
            <Empty title="Nothing bound yet">Request a quote, then bind it with the exact premium.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th>Agent</th>
                    <th>Perils</th>
                    <th>Cover · GEN</th>
                    <th>Remaining · GEN</th>
                    <th>Risk</th>
                    <th>Ends</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {book.policies.map((policy) => (
                    <tr key={policy.policy_id}>
                      <td>
                        <strong>{policy.policy_id}</strong>
                        <span className="cell-sub">{policy.quote_id} · {gen(policy.premium_atto, 4)} GEN premium</span>
                      </td>
                      <td>{policy.agent_id}</td>
                      <td>
                        {policy.perils.split(',').map((peril) => (
                          <span key={peril} className="peril">
                            {peril === 'DATA_LEAK' ? 'leak' : 'misbehaviour'}
                          </span>
                        ))}
                      </td>
                      <td className="num">
                        {gen(policy.coverage_atto)}
                        <span className="cell-sub">{gen(policy.deductible_atto)} deductible</span>
                      </td>
                      <td className="num">{gen(policy.remaining_atto)}</td>
                      <td className="num">{num(policy.risk_score)}</td>
                      <td className="num">
                        {stampDate(policy.end_at)}
                        <span className="cell-sub">{countdown(policy.end_at)}</span>
                      </td>
                      <td>
                        <Stamp status={policy.status} />
                      </td>
                      <td className="cell-action">
                        <button
                          className="button button-quiet"
                          type="button"
                          onClick={() => setDetail({ kind: 'policy', id: policy.policy_id })}
                        >
                          Record
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section" id="claims">
          <div className="section-head">
            <span className="eyebrow">04 · Claims</span>
            <h2>The register</h2>
            <p>
              {openClaims.length} open {openClaims.length === 1 ? 'entry' : 'entries'}. A verdict becomes
              money only after its appeal window closes.
            </p>
          </div>
          {book.claims.length === 0 ? (
            <Empty title="No claims filed">
              A counterparty files with a description and at least one evidence URL. Nothing is paid on the
              description alone.
            </Empty>
          ) : (
            <div className="claims">
              {book.claims.map((claim) => {
                const policy = book.policies.find((item) => item.policy_id === claim.policy_id)
                const settleable =
                  now >= num(claim.appeal_deadline) &&
                  !claim.settled &&
                  !claim.payout_id &&
                  claim.status !== 'OPEN' &&
                  claim.status !== 'APPEALED' &&
                  claim.status !== 'PAY_SENT'
                const appealable = !claim.appealed && now <= num(claim.appeal_deadline) && (claim.status === 'PAY_PENDING' || claim.status === 'DENY_PENDING')
                const canRespond =
                  Boolean(account && policy && policy.holder.toLowerCase() === account.toLowerCase()) &&
                  claim.status === 'OPEN' &&
                  claim.defense_status === 'OPEN' &&
                  now <= num(claim.defense_deadline)
                const appealExpired =
                  claim.status === 'APPEALED' && now > num(claim.appeal_expires_at)
                const canConfirm =
                  claim.status === 'PAY_SENT' &&
                  claim.payout_status === 'SENT' &&
                  Boolean(account && claim.claimant.toLowerCase() === account.toLowerCase())
                const canRetry = claim.status === 'PAY_SENT' && claim.payout_status === 'FAILED'
                return (
                  <article className="claim" key={claim.claim_id}>
                    <header className="claim-head">
                      <div>
                        <span className="eyebrow">{claim.claim_id} · {claim.policy_id}</span>
                        <h3>{claim.incident_ref}</h3>
                      </div>
                      <Stamp status={claim.status} />
                    </header>
                    <div className="claim-grid">
                      <div className="claim-narrative">
                        <p>{claim.description}</p>
                        <p className="claim-rationale">
                          <strong>{claim.verdict ? claim.verdict.toLowerCase() : 'unjudged'}</strong>
                          {claim.rationale ? ' — ' + claim.rationale : ''}
                        </p>
                        {claim.evidence ? (
                          <div className="evidence">
                            {claim.evidence.split('\n').map((url) => (
                              <a key={url} href={url} target="_blank" rel="noreferrer">
                                {url.replace(/^https?:\/\//, '')}
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <dl className="claim-figures">
                        <div>
                          <dt>Claimed</dt>
                          <dd>{gen(claim.claimed_atto)} GEN</dd>
                        </div>
                        <div>
                          <dt>Approved</dt>
                          <dd>{gen(claim.payout_atto)} GEN</dd>
                        </div>
                        <div>
                          <dt>Proven</dt>
                          <dd>{claim.verdict === 'PAY' ? (num(claim.payout_ratio_bps) / 100).toFixed(0) + '%' : '—'}</dd>
                        </div>
                        <div>
                          <dt>Peril</dt>
                          <dd>{claim.covered_peril || '—'}</dd>
                        </div>
                      </dl>
                    </div>
                    <div className="claim-signals">
                      <div className="signal">
                        <span>AI verdict</span>
                        <strong>{claim.verdict || 'unjudged'}</strong>
                      </div>
                      <div className="signal">
                        <span>Confidence</span>
                        <strong>{num(claim.confidence)}%</strong>
                      </div>
                      <div className="signal">
                        <span>Evidence</span>
                        <strong>{num(claim.evidence_quality)}/100</strong>
                      </div>
                      <div className="signal">
                        <span>Payout ratio</span>
                        <strong>
                          {claim.verdict === 'PAY' ? (num(claim.payout_ratio_bps) / 100).toFixed(0) + '%' : '—'}
                        </strong>
                      </div>
                      <div className="signal">
                        <span>Payout</span>
                        <strong>{claim.payout_status ? claim.payout_status.toLowerCase() : '—'}</strong>
                      </div>
                    </div>
                    <footer className="claim-foot">
                      <span className="claim-meta">
                        {claim.fraud_suspected ? 'fraud flagged · ' : ''}
                        {claim.attempts.toString()} review{num(claim.attempts) === 1 ? '' : 's'} ·{' '}
                        {claim.settled ? 'settled' : claim.status === 'PAY_SENT' ? 'payout ' + (claim.payout_status || 'sent').toLowerCase() : 'appeal window ' + countdown(claim.appeal_deadline)}
                        {claim.defense_status && claim.defense_status !== 'OPEN'
                          ? ' · defence ' + claim.defense_status.toLowerCase()
                          : ''}
                        {num(claim.bond_slashed_atto) > 0
                          ? ' · bond ' + gen(claim.bond_slashed_atto) + ' GEN applied'
                          : ''}
                        {claim.corroboration_required
                          ? ' · corroboration ' + (claim.corroboration_met ? 'met' : 'not met')
                          : ''}
                      </span>
                      <div className="claim-actions">
                        <button
                          className="button button-quiet"
                          type="button"
                          onClick={() => setDetail({ kind: 'claim', id: claim.claim_id })}
                        >
                          Record
                        </button>
                        {claim.status === 'OPEN' ? (
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => act('Evidence read', 'adjudicate_claim', claim)}
                          >
                            Adjudicate
                          </button>
                        ) : null}
                        {claim.status === 'APPEALED' ? (
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => act('Appeal resolved', 'resolve_appeal', claim)}
                          >
                            Resolve appeal
                          </button>
                        ) : null}
                        {appealable ? (
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => void appeal(claim)}
                          >
                            Appeal
                          </button>
                        ) : null}
                        {appealExpired ? (
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => act('Appeal expired', 'expire_appeal', claim)}
                          >
                            Expire appeal
                          </button>
                        ) : null}
                        {settleable ? (
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => act('Claim settled', 'settle_claim', claim)}
                          >
                            Settle
                          </button>
                        ) : null}
                        {canConfirm ? (
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => void confirmPayout(claim)}
                          >
                            Confirm receipt
                          </button>
                        ) : null}
                        {canRetry ? (
                          <button
                            className="button button-quiet"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => void retryPayout(claim)}
                          >
                            Retry payout
                          </button>
                        ) : null}
                        {canRespond ? (
                          <ClaimResponse
                            claim={claim}
                            busy={busy}
                            run={run}
                            refresh={refresh}
                          />
                        ) : null}
                      </div>
                    </footer>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <footer className="colophon">
          <span>Vouchsafe · GenLayer</span>
          <span>{book.terms.operator ? 'Operator ' + shortAddress(book.terms.operator) : ''}</span>
          <span>Evidence read, not trusted.</span>
        </footer>
      </main>

      <Desk
        book={book}
        account={account}
        busy={busy}
        runs={runs}
        run={run}
        refresh={refresh}
        onConnect={onConnect}
        onRecord={setDetail}
        onOpenRun={(txRun) => {
          if (txRun.record) setDetail(txRun.record)
        }}
        onDismissRun={(id) => setRuns((prev) => prev.filter((item) => item.id !== id))}
      />

      {detail ? (
        <RecordDrawer
          book={book}
          record={detail}
          onClose={() => setDetail(null)}
          onOpen={(next) => setDetail(next)}
        />
      ) : null}
    </div>
  )
}

function ClaimResponse({
  claim,
  busy,
  run,
  refresh,
}: {
  claim: Claim
  busy: string | null
  run: (label: string, fn: string, args: unknown[], value?: bigint, record?: RecordRef) => Promise<WriteResult | null>
  refresh: () => Promise<Book | null>
}) {
  const [open, setOpen] = useState(false)
  const [statement, setStatement] = useState('')
  const [url, setUrl] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const result = await run('Defence filed', 'respond_to_claim', [claim.claim_id, statement, url], 0n, {
      kind: 'claim',
      id: claim.claim_id,
    })
    if (result) {
      setOpen(false)
      setStatement('')
      setUrl('')
      await refresh()
    }
  }

  async function waive() {
    const result = await run('Response waived', 'waive_response', [claim.claim_id], 0n, {
      kind: 'claim',
      id: claim.claim_id,
    })
    if (result) {
      setOpen(false)
      await refresh()
    }
  }

  if (!open) {
    return (
      <button className="button button-quiet" type="button" disabled={Boolean(busy)} onClick={() => setOpen(true)}>
        Respond
      </button>
    )
  }

  return (
    <form className="claim-response" onSubmit={submit}>
      <label>
        <span className="eyebrow">Insured response</span>
        <textarea
          rows={3}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          placeholder="What did the agent actually do, and why is the claim wrong or overstated?"
        />
      </label>
      <label>
        <span className="eyebrow">Defence evidence URL</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…/approval-log"
          spellCheck={false}
        />
      </label>
      <div className="claim-response-actions">
        <button className="button button-solid" type="submit" disabled={Boolean(busy) || statement.trim().length < 20 || !url.trim()}>
          {busy ?? 'File defence'}
        </button>
        <button className="button button-quiet" type="button" disabled={Boolean(busy)} onClick={() => void waive()}>
          Waive window
        </button>
        <button className="button button-quiet" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}
