import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Book, Claim, Policy, Quote, RecordRef, TxRun } from './types'
import { atto, gen, num, parseGen, returnedId, shortAddress } from './format'
import { Confidence, Empty, Field, Stamp } from './ui'
import { TxMonitor } from './TxMonitor'
import type { WriteResult } from './api'

type Tab = 'underwrite' | 'claim' | 'agent' | 'capital'

export interface DeskProps {
  book: Book
  account: string | null
  busy: string | null
  runs: TxRun[]
  run: (label: string, fn: string, args: unknown[], value?: bigint, record?: RecordRef) => Promise<WriteResult | null>
  refresh: () => Promise<Book | null>
  onConnect: () => void
  onRecord: (ref: RecordRef) => void
  onOpenRun: (run: TxRun) => void
  onDismissRun: (id: string) => void
}

export function Desk({
  book,
  account,
  busy,
  runs,
  run,
  refresh,
  onConnect,
  onRecord,
  onOpenRun,
  onDismissRun,
}: DeskProps) {
  const [tab, setTab] = useState<Tab>('underwrite')
  const agents = book.agents
  const policies = book.policies.filter((policy) => policy.status === 'ACTIVE')
  const [quote, setQuote] = useState<Quote | null>(null)

  return (
    <aside className="docket" aria-label="Underwriting desk">
      <header className="docket-head">
        <span className="eyebrow">The desk</span>
        <h2>Write, bind, claim</h2>
        {!account ? (
          <button className="button button-solid" onClick={onConnect} type="button">
            Connect wallet
          </button>
        ) : (
          <span className="docket-account">{shortAddress(account)}</span>
        )}
      </header>

      <nav className="tabs" aria-label="Desk sections">
        {(
          [
            ['underwrite', 'Underwrite'],
            ['claim', 'Claim'],
            ['agent', 'Agent'],
            ['capital', 'Capital'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <TxMonitor runs={runs} onOpen={onOpenRun} onDismiss={onDismissRun} />

      <div className="docket-body">
        {tab === 'underwrite' ? (
          <UnderwriteForm
            agents={agents}
            busy={busy}
            run={run}
            refresh={refresh}
            quote={quote}
            setQuote={setQuote}
            onRecord={onRecord}
          />
        ) : null}
        {tab === 'claim' ? (
          <ClaimForm policies={policies} busy={busy} run={run} refresh={refresh} onRecord={onRecord} />
        ) : null}
        {tab === 'agent' ? <AgentForm busy={busy} run={run} refresh={refresh} onRecord={onRecord} /> : null}
        {tab === 'capital' ? <CapitalForm book={book} busy={busy} run={run} refresh={refresh} /> : null}
      </div>

      <footer className="docket-foot">
        <div className="gate-note">
          <span className="eyebrow">Underwriting rails</span>
          <ul>
            <li>Decline at risk ≥ 85 or leak risk ≥ 90</li>
            <li>Decline at 3 upheld claims or reputation &lt; 250</li>
            <li>Premium is coverage × rate × days / 365</li>
          </ul>
        </div>
        <p>
          Every judgement is read twice: once by the leader, once by each validator. Money is reserved by
          deterministic arithmetic, then becomes final only after the appeal window closes and the recipient
          confirms the payout.
        </p>
      </footer>
    </aside>
  )
}

function UnderwriteForm({
  agents,
  busy,
  run,
  refresh,
  quote,
  setQuote,
  onRecord,
}: {
  agents: Book['agents']
  busy: string | null
  run: DeskProps['run']
  refresh: DeskProps['refresh']
  quote: Quote | null
  setQuote: (quote: Quote | null) => void
  onRecord: DeskProps['onRecord']
}) {
  const [agentId, setAgentId] = useState(agents[0]?.agent_id ?? '')
  const [coverage, setCoverage] = useState('100')
  const [deductible, setDeductible] = useState('5')
  const [term, setTerm] = useState('30')
  const [perils, setPerils] = useState<string[]>(['MISBEHAVIOR', 'DATA_LEAK'])
  const [dataScope, setDataScope] = useState('customer names, emails, order history')
  const quoteCard = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].agent_id)
  }, [agents, agentId])

  useEffect(() => {
    if (quote) quoteCard.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [quote])

  const togglePeril = (peril: string) => {
    setPerils((current) =>
      current.includes(peril) ? current.filter((item) => item !== peril) : [...current, peril],
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await run('Quote requested', 'request_quote', [
      agentId,
      parseGen(coverage),
      parseGen(deductible),
      parseGen(term),
      perils.join(','),
      dataScope,
    ])
    if (!result) return
    const quoteId = returnedId(result.payload, 'Q')
    const next = await refresh()
    if (!next) return
    const created = quoteId ? next.quotes.find((item) => item.quote_id === quoteId) : undefined
    setQuote(created ?? null)
  }

  async function bind() {
    if (!quote) return
    const result = await run('Cover bound', 'bind_policy', [quote.quote_id], atto(quote.premium_atto))
    if (!result) return
    const policyId = returnedId(result.payload, 'P')
    setQuote(null)
    const next = await refresh()
    const policy = policyId
      ? next?.policies.find((item) => item.policy_id === policyId)
      : next?.policies.find((item) => item.quote_id === quote.quote_id)
    if (policy) onRecord({ kind: 'policy', id: policy.policy_id })
  }

  return (
    <form className="form" onSubmit={submit}>
      {agents.length === 0 ? (
        <Empty title="No agents on the book">Register an agent first, then price cover for it.</Empty>
      ) : (
        <>
          <Field label="Agent">
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  {agent.name} · {agent.reputation.toString()} rep
                </option>
              ))}
            </select>
          </Field>
          <div className="field-row">
            <Field label="Cover" hint="GEN">
              <input value={coverage} onChange={(event) => setCoverage(event.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Deductible" hint="GEN">
              <input
                value={deductible}
                onChange={(event) => setDeductible(event.target.value)}
                inputMode="decimal"
              />
            </Field>
          </div>
          <Field label="Term" hint="days">
            <input value={term} onChange={(event) => setTerm(event.target.value)} inputMode="numeric" />
          </Field>
          <fieldset className="field checks">
            <legend className="field-label">Perils</legend>
            {['MISBEHAVIOR', 'DATA_LEAK'].map((peril) => (
              <label key={peril} className="check">
                <input
                  type="checkbox"
                  checked={perils.includes(peril)}
                  onChange={() => togglePeril(peril)}
                />
                <span>{peril === 'DATA_LEAK' ? 'Data leak' : 'Misbehaviour'}</span>
              </label>
            ))}
          </fieldset>
          {perils.includes('DATA_LEAK') ? (
            <Field label="Data in scope" hint="required for leak cover">
              <input value={dataScope} onChange={(event) => setDataScope(event.target.value)} />
            </Field>
          ) : null}
          <button className="button button-solid" type="submit" disabled={Boolean(busy)}>
            {busy ?? 'Request quote'}
          </button>
        </>
      )}

      {quote ? (
        <article className="quote-card" ref={quoteCard}>
          <header>
            <span className="eyebrow">{quote.quote_id}</span>
            <Stamp status={quote.decision} />
          </header>
          <dl className="quote-figures">
            <div>
              <dt>Premium</dt>
              <dd>{gen(quote.premium_atto, 4)} GEN</dd>
            </div>
            <div>
              <dt>Rate</dt>
              <dd>{(num(quote.rate_bps) / 100).toFixed(2)}%</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>
                {num(quote.risk_score)} / {num(quote.data_leak_risk)} leak
              </dd>
            </div>
          </dl>
          <Confidence value={num(quote.confidence)} label="underwriter confidence" />
          <p className="quote-reason">“{quote.rationale}”</p>
          {quote.flags ? (
            <div className="flags">
              {quote.flags.split(',').map((flag) => (
                <span key={flag} className="flag">
                  {flag.toLowerCase().replaceAll('_', ' ')}
                </span>
              ))}
            </div>
          ) : null}
          {quote.exclusions ? (
            <p className="quote-terms">
              <strong>Excludes</strong> {quote.exclusions}
            </p>
          ) : null}
          {quote.conditions ? (
            <p className="quote-terms">
              <strong>Conditions</strong> {quote.conditions}
            </p>
          ) : null}
          <div className="quote-actions">
            {quote.decision === 'ACCEPT' ? (
              <button className="button button-stamp" type="button" onClick={bind} disabled={Boolean(busy)}>
                Bind for {gen(quote.premium_atto, 4)} GEN
              </button>
            ) : (
              <button className="button" type="button" onClick={() => setQuote(null)}>
                Clear declined quote
              </button>
            )}
            <button
              className="button button-quiet"
              type="button"
              onClick={() => onRecord({ kind: 'quote', id: quote.quote_id })}
            >
              Full AI record
            </button>
          </div>
        </article>
      ) : null}
    </form>
  )
}

function ClaimForm({
  policies,
  busy,
  run,
  refresh,
  onRecord,
}: {
  policies: Policy[]
  busy: string | null
  run: DeskProps['run']
  refresh: DeskProps['refresh']
  onRecord: DeskProps['onRecord']
}) {
  const [policyId, setPolicyId] = useState(policies[0]?.policy_id ?? '')
  const [kind, setKind] = useState('MISBEHAVIOR')
  const [reference, setReference] = useState('INC-' + new Date().toISOString().slice(0, 10))
  const [description, setDescription] = useState('')
  const [claimed, setClaimed] = useState('25')
  const [evidence, setEvidence] = useState('')
  const [filed, setFiled] = useState<Claim | null>(null)

  useEffect(() => {
    if (!policyId && policies[0]) setPolicyId(policies[0].policy_id)
  }, [policies, policyId])

  const selected = policies.find((policy) => policy.policy_id === policyId)
  const availablePerils = useMemo(
    () => (selected ? selected.perils.split(',') : ['MISBEHAVIOR', 'DATA_LEAK']),
    [selected],
  )

  useEffect(() => {
    if (selected && !availablePerils.includes(kind)) setKind(availablePerils[0] ?? 'MISBEHAVIOR')
  }, [selected, availablePerils, kind])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await run('Claim filed', 'file_claim', [
      policyId,
      reference,
      kind,
      description,
      parseGen(claimed),
      evidence,
    ])
    if (!result) return
    const claimId = returnedId(result.payload, 'C')
    const next = await refresh()
    if (!next) return
    const created = claimId ? next.claims.find((claim) => claim.claim_id === claimId) : undefined
    setFiled(created ?? null)
    if (created) onRecord({ kind: 'claim', id: created.claim_id })
    setDescription('')
    setEvidence('')
  }

  return (
    <form className="form" onSubmit={submit}>
      {policies.length === 0 ? (
        <Empty title="No policy in force">Bind cover before filing a claim against an agent.</Empty>
      ) : (
        <>
          <Field label="Policy">
            <select value={policyId} onChange={(event) => setPolicyId(event.target.value)}>
              {policies.map((policy) => (
                <option key={policy.policy_id} value={policy.policy_id}>
                  {policy.policy_id} · {policy.agent_id} · {gen(policy.remaining_atto)} GEN left
                </option>
              ))}
            </select>
          </Field>
          <div className="field-row">
            <Field label="Incident" hint="reference">
              <input value={reference} onChange={(event) => setReference(event.target.value)} />
            </Field>
            <Field label="Peril">
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                {availablePerils.map((peril) => (
                  <option key={peril} value={peril}>
                    {peril === 'DATA_LEAK' ? 'Data leak' : 'Misbehaviour'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="What happened" hint="min 40 characters">
            <textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Dates, actions, amount lost, and why the agent was outside its mandate."
            />
          </Field>
          <Field label="Claimed" hint="GEN">
            <input value={claimed} onChange={(event) => setClaimed(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Evidence" hint="one URL per line · two independent hosts for large payouts">
            <textarea
              rows={3}
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder={'https://…/incident-report\nhttps://…/independent-log'}
            />
          </Field>
          <button className="button button-solid" type="submit" disabled={Boolean(busy)}>
            {busy ?? 'File claim'}
          </button>
        </>
      )}

      {filed ? (
        <article className="filed-card">
          <span className="eyebrow">{filed.claim_id}</span>
          <strong>Claim is in the register.</strong>
          <p>Adjudication is the next entry in the claims table. Validators read the evidence there.</p>
        </article>
      ) : null}
    </form>
  )
}

function AgentForm({
  busy,
  run,
  refresh,
  onRecord,
}: {
  busy: string | null
  run: DeskProps['run']
  refresh: DeskProps['refresh']
  onRecord: DeskProps['onRecord']
}) {
  const [agentId, setAgentId] = useState('helios')
  const [name, setName] = useState('Helios Trader')
  const [wallet, setWallet] = useState('')
  const [capabilities, setCapabilities] = useState('quote, swap, rebalance')
  const [manifest, setManifest] = useState('https://')
  const [bond, setBond] = useState('1')

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await run('Agent registered', 'register_agent', [
      agentId,
      name,
      wallet,
      capabilities,
      manifest,
    ], parseGen(bond), { kind: 'agent', id: agentId })
    if (result) {
      await refresh()
      onRecord({ kind: 'agent', id: agentId })
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="form-note">
        A bond and a public manifest are what make the agent insurable. The wallet must appear in the manifest
        before attestation passes.
      </p>
      <div className="field-row">
        <Field label="Agent id" hint="slug">
          <input value={agentId} onChange={(event) => setAgentId(event.target.value)} />
        </Field>
        <Field label="Bond" hint="GEN">
          <input value={bond} onChange={(event) => setBond(event.target.value)} inputMode="decimal" />
        </Field>
      </div>
      <Field label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Agent wallet">
        <input
          value={wallet}
          onChange={(event) => setWallet(event.target.value)}
          placeholder="0x…"
          spellCheck={false}
        />
      </Field>
      <Field label="Capabilities">
        <input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} />
      </Field>
      <Field label="Manifest URL">
        <input
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          placeholder="https://your.agent/manifest.json"
          spellCheck={false}
        />
      </Field>
      <button className="button button-solid" type="submit" disabled={Boolean(busy)}>
        {busy ?? 'Register agent'}
      </button>
      <p className="form-note">After registering, attest the manifest from the agents table.</p>
    </form>
  )
}

function CapitalForm({
  book,
  busy,
  run,
  refresh,
}: {
  book: Book
  busy: string | null
  run: DeskProps['run']
  refresh: DeskProps['refresh']
}) {
  const [amount, setAmount] = useState('100')
  const shares = book.shares

  async function fund(event: FormEvent) {
    event.preventDefault()
    const result = await run('Capital deposited', 'fund_pool', [], parseGen(amount))
    if (result) await refresh()
  }

  async function withdraw() {
    if (!shares) return
    const result = await run('Capital withdrawn', 'withdraw_pool', [atto(shares.shares)])
    if (result) await refresh()
  }

  return (
    <div className="form">
      <div className="capital-figures">
        <div>
          <span className="eyebrow">Your shares</span>
          <strong>{gen(shares?.shares, 4)}</strong>
        </div>
        <div>
          <span className="eyebrow">Redeemable</span>
          <strong>{gen(shares?.value_atto)} GEN</strong>
        </div>
      </div>
      <p className="form-note">
        Underwriting capital earns the premium. It cannot leave while it is reserved against cover in force.
      </p>
      <form onSubmit={fund} className="form">
        <Field label="Deposit" hint="GEN">
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
        </Field>
        <button className="button button-solid" type="submit" disabled={Boolean(busy)}>
          {busy ?? 'Deposit capital'}
        </button>
      </form>
      <button
        className="button"
        type="button"
        onClick={withdraw}
        disabled={Boolean(busy) || !shares || atto(shares.shares) === 0n}
      >
        Withdraw all shares
      </button>
    </div>
  )
}
