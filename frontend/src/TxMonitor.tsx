import { useEffect, useState } from 'react'
import type { TxRun } from './types'
import { elapsed } from './format'
import { CopyButton } from './ui'

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'SIGNING', label: 'Signed' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'CONSENSUS', label: 'Consensus' },
  { key: 'ACCEPTED', label: 'Decided' },
  { key: 'FINALIZED', label: 'Final' },
]

function stepIndex(run: TxRun): number {
  if (run.stage === 'SIGNING') return 0
  if (run.stage === 'SUBMITTED') return 1
  if (run.stage === 'CONSENSUS') return 2
  if (run.stage === 'ACCEPTED') return 3
  if (run.stage === 'FINALIZED') return 4
  return 2
}

const STAGE_LABEL: Record<string, string> = {
  SIGNING: 'awaiting signature',
  SUBMITTED: 'broadcast',
  CONSENSUS: 'validators voting',
  ACCEPTED: 'decision reached',
  FINALIZED: 'finalized',
  UNDETERMINED: 'undetermined',
  CANCELED: 'canceled',
  TIMEOUT: 'timed out',
  FAILED: 'failed',
}

function settleLabel(run: TxRun): string {
  if (run.stage === 'FINALIZED') return run.ok ? 'executed' : 'reverted'
  return STAGE_LABEL[run.stage] ?? run.stage.toLowerCase()
}

function useTicker(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000)
    return () => window.clearInterval(id)
  }, [active])
}

export function TxMonitor({
  runs,
  onOpen,
  onDismiss,
}: {
  runs: TxRun[]
  onOpen: (run: TxRun) => void
  onDismiss: (id: string) => void
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const latest = runs[0]
  useTicker(Boolean(latest && !latest.endedAt))

  if (!latest) return null

  const active = !latest.endedAt
  const failed = latest.stage === 'FAILED' || latest.stage === 'TIMEOUT' || latest.stage === 'CANCELED'
  const undetermined = latest.stage === 'UNDETERMINED'
  const index = stepIndex(latest)
  const tone = failed ? 'bad' : undetermined ? 'wait' : latest.endedAt ? (latest.ok ? 'ok' : 'bad') : 'live'
  const duration = elapsed(latest.startedAt, latest.endedAt ?? Date.now())
  const history = runs.slice(1)

  return (
    <section className={`txmon txmon-${tone}`} aria-live="polite" aria-label="Transaction monitor">
      <header className="txmon-head">
        <span className="eyebrow">{active ? 'Transaction in flight' : 'Transaction record'}</span>
        <span className="txmon-stage">
          {active ? <i className="pulse" aria-hidden="true" /> : null}
          {latest.ai && !active ? <span className="txmon-ai-badge">AI</span> : null}
          {settleLabel(latest)}
        </span>
      </header>

      <div className="txmon-title">
        <strong>{latest.label}</strong>
        <code>{latest.fn}</code>
      </div>

      <ol className="txsteps" aria-label="Transaction stages">
        {STEPS.map((step, stepPosition) => {
          const done = stepPosition < index || (stepPosition === index && latest.endedAt && latest.ok)
          const current = stepPosition === index && active
          const bad = stepPosition === index && !active && !latest.ok && !undetermined
          return (
            <li
              key={step.key}
              className={`txstep${done ? ' txstep-done' : ''}${current ? ' txstep-current' : ''}${bad ? ' txstep-bad' : ''}`}
            >
              <span className="txstep-dot" />
              <span className="txstep-label">{step.label}</span>
            </li>
          )
        })}
      </ol>

      <div className="txmon-meta">
        <span className="txmon-clock" title="Elapsed since the wallet was asked to sign">
          {duration}
        </span>
        {latest.hash ? <CopyButton value={latest.hash} label={latest.hash.slice(0, 10) + '…' + latest.hash.slice(-6)} /> : null}
        {latest.votes && latest.votes.total > 0 ? (
          <span className={`txmon-votes${latest.votes.disagree > 0 ? ' txmon-votes-split' : ''}`}>
            {latest.votes.agree}/{latest.votes.total} agree
          </span>
        ) : null}
        {latest.rounds ? <span>{latest.rounds} round{latest.rounds === 1 ? '' : 's'}</span> : null}
      </div>

      {latest.ai && active ? (
        <p className="txmon-note">
          Leader is reading the manifest/evidence and proposing a judgement. Every validator re-runs the
          same read independently; disagreement rotates the leader.
        </p>
      ) : null}

      {latest.payload ? <p className="txmon-payload">{latest.payload}</p> : null}
      {latest.error ? <p className="txmon-payload">{latest.error}</p> : null}

      <footer className="txmon-foot">
        {latest.record && latest.ok ? (
          <button className="button button-quiet" type="button" onClick={() => onOpen(latest)}>
            Open AI record
          </button>
        ) : null}
        {!active ? (
          <button className="button button-quiet" type="button" onClick={() => onDismiss(latest.id)}>
            Dismiss
          </button>
        ) : null}
        {history.length ? (
          <button
            className="button button-quiet txmon-history-toggle"
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            {historyOpen ? 'Hide history' : `History · ${history.length}`}
          </button>
        ) : null}
      </footer>

      {historyOpen && history.length ? (
        <ol className="txhistory">
          {history.map((run) => (
            <li key={run.id}>
              <span className={`txhistory-dot${run.ok ? ' ok' : ''}`} />
              <div>
                <strong>{run.label}</strong>
                <span>
                  {run.fn} · {elapsed(run.startedAt, run.endedAt ?? Date.now())} ·{' '}
                  {run.hash ? run.hash.slice(0, 8) + '…' : 'no hash'}
                </span>
              </div>
              <em>{run.ok ? 'ok' : run.stage === 'FINALIZED' ? 'reverted' : settleLabel(run)}</em>
              {run.record && run.ok ? (
                <button className="txhistory-open" type="button" onClick={() => onOpen(run)}>
                  record
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
