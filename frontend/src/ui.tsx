import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Pool } from './types'
import { atto, gen, genCompact, shortAddress } from './format'

const STAMPS: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  EXPIRED: { label: 'Expired', tone: 'muted' },
  EXHAUSTED: { label: 'Exhausted', tone: 'muted' },
  OPEN: { label: 'Open', tone: 'wait' },
  PAY_PENDING: { label: 'Pay pending', tone: 'wait' },
  PAY_FINAL: { label: 'Pay final', tone: 'ok' },
  DENY_PENDING: { label: 'Deny pending', tone: 'bad' },
  DENY_FINAL: { label: 'Denied', tone: 'bad' },
  PAID: { label: 'Paid', tone: 'stamp' },
  APPEALED: { label: 'On appeal', tone: 'wait' },
  ACCEPT: { label: 'Accept', tone: 'ok' },
  DECLINE: { label: 'Decline', tone: 'bad' },
  PAY: { label: 'Pay', tone: 'stamp' },
  DENY: { label: 'Deny', tone: 'bad' },
  UNDETERMINED: { label: 'No source', tone: 'muted' },
}

export function Stamp({ status }: { status: string }) {
  const meta = STAMPS[status] ?? { label: status.replaceAll('_', ' ').toLowerCase(), tone: 'muted' }
  return <span className={`stamp stamp-${meta.tone}`}>{meta.label}</span>
}

export function Confidence({
  value,
  label = 'model confidence',
}: {
  value: number
  label?: string
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  const tone = clamped >= 70 ? 'high' : clamped >= 45 ? 'mid' : 'low'
  return (
    <div className={`confidence confidence-${tone}`}>
      <div className="confidence-head">
        <span>{label}</span>
        <strong>{clamped}%</strong>
      </div>
      <div className="confidence-track">
        <span style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}

export function Reputation({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(1000, value))
  return (
    <span className="reputation" title={`${value} / 1000`}>
      <span className="reputation-track">
        <span className="reputation-fill" style={{ width: `${clamped / 10}%` }} />
      </span>
      <span className="reputation-value">{value}</span>
    </span>
  )
}

export function Metric({
  label,
  value,
  detail,
  accent,
}: {
  label: string
  value: string
  detail: string
  accent?: boolean
}) {
  return (
    <div className={`metric${accent ? ' metric-accent' : ''}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <span className="metric-detail">{detail}</span>
    </div>
  )
}

export function SolvencyGauge({ pool }: { pool: Pool }) {
  const assets = atto(pool.assets_atto)
  const reservedRaw = atto(pool.reserved_atto)
  const reserved = reservedRaw > assets ? assets : reservedRaw
  const reservedShare = assets > 0n ? Number((reserved * 10_000n) / assets) / 100 : 0
  const free = assets - reserved

  return (
    <figure className="gauge">
      <div
        className="gauge-track"
        role="img"
        aria-label={`${gen(pool.reserved_atto)} GEN reserved of ${gen(pool.assets_atto)} GEN in the pool`}
      >
        <div
          className="gauge-free"
          style={{ height: assets > 0n ? `${100 - reservedShare}%` : '0%' }}
        />
        <div className="gauge-reserved" style={{ height: `${reservedShare}%` }} />
        {[0, 25, 50, 75, 100].map((tick) => (
          <span key={tick} className="gauge-tick" style={{ bottom: `${tick}%` }} />
        ))}
      </div>
      <figcaption className="gauge-caption">
        <span className="gauge-eyebrow">Solvency</span>
        <strong className="gauge-number">{genCompact(pool.assets_atto)}</strong>
        <span className="gauge-unit">GEN under management</span>
        <dl className="gauge-legend">
          <div>
            <dt>
              <i className="swatch swatch-free" /> Free
            </dt>
            <dd>{gen(free)} GEN</dd>
          </div>
          <div>
            <dt>
              <i className="swatch swatch-reserved" /> Reserved
            </dt>
            <dd>{gen(reserved)} GEN</dd>
          </div>
          <div>
            <dt>In flight</dt>
            <dd>{gen(pool.pending_payout_atto)} GEN</dd>
          </div>
          <div>
            <dt>Share price</dt>
            <dd>{gen(pool.share_price_atto, 4)} GEN</dd>
          </div>
        </dl>
      </figcaption>
    </figure>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint ? <em>{hint}</em> : null}
      </span>
      {children}
    </label>
  )
}

export function CopyButton({
  value,
  label,
  className = '',
}: {
  value: string
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_400)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button
      type="button"
      className={`copy ${className}`.trim()}
      onClick={() => void copy()}
      title={`Copy ${value}`}
    >
      {copied ? 'copied' : label}
    </button>
  )
}

export function AddressChip({ address }: { address: string }) {
  return (
    <span className="address" title={address}>
      {shortAddress(address)}
    </span>
  )
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  )
}
