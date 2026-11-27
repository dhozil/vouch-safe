import type { Num } from './types'

const ATTO = 10n ** 18n

export function atto(value: Num | undefined | null): bigint {
  if (value === undefined || value === null) return 0n
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.round(value))
  const text = String(value).trim()
  if (!/^-?\d+$/.test(text)) return 0n
  return BigInt(text)
}

export function gen(value: Num | undefined | null, digits = 2): string {
  const raw = atto(value)
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const whole = abs / ATTO
  const fraction = abs % ATTO
  const shown = fraction === 0n ? '' : '.' + fraction.toString().padStart(18, '0').slice(0, digits)
  const base = whole.toLocaleString('en-US')
  return (negative ? '-' : '') + base + shown
}

export function genCompact(value: Num | undefined | null): string {
  const raw = atto(value)
  const whole = Number(raw / ATTO)
  if (whole >= 1_000_000) return (whole / 1_000_000).toFixed(1) + 'M'
  if (whole >= 1_000) return (whole / 1_000).toFixed(1) + 'k'
  return gen(raw, 2)
}

export function parseGen(input: string): bigint {
  const text = input.trim().replace(/,/g, '')
  if (!/^\d*(\.\d*)?$/.test(text) || text === '' || text === '.') return 0n
  const [whole, fraction = ''] = text.split('.')
  const padded = (fraction + '0'.repeat(18)).slice(0, 18)
  return BigInt(whole || '0') * ATTO + BigInt(padded || '0')
}

export function parseDays(input: string): number {
  const text = input.trim()
  if (!/^\d+$/.test(text)) return 0
  const days = Number(text)
  return Number.isSafeInteger(days) ? days : 0
}

export function bps(value: Num | undefined | null): string {
  return (Number(atto(value)) / 100).toFixed(2) + '%'
}

export function num(value: Num | undefined | null): number {
  return Number(atto(value))
}

export function shortAddress(value: string | undefined | null): string {
  if (!value) return '—'
  if (value.length <= 12) return value
  return value.slice(0, 6) + '…' + value.slice(-4)
}

export function stampDate(value: Num | undefined | null): string {
  const seconds = num(value)
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function countdown(value: Num | undefined | null): string {
  const seconds = num(value) - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'closed'
  const days = Math.floor(seconds / 86_400)
  if (days >= 1) return days + 'd left'
  const hours = Math.floor(seconds / 3_600)
  if (hours >= 1) return hours + 'h left'
  return Math.max(1, Math.floor(seconds / 60)) + 'm left'
}

export function relativeSeconds(value: Num | undefined | null): string {
  const delta = num(value) - Math.floor(Date.now() / 1000)
  const abs = Math.abs(delta)
  const unit = abs >= 86_400 ? Math.round(abs / 86_400) + 'd' : Math.round(abs / 3_600) + 'h'
  return delta >= 0 ? 'in ' + unit : unit + ' ago'
}

export function stampDateTime(value: Num | undefined | null): string {
  const seconds = num(value)
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function elapsed(from: number, to = Date.now()): string {
  const ms = Math.max(0, to - from)
  if (ms < 1_000) return ms + 'ms'
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
}

export function percent(value: number, digits = 0): string {
  return value.toFixed(digits) + '%'
}


export function returnedId(payload: string | undefined, prefix: string): string | null {
  if (!payload) return null
  const clean = payload.trim().replace(/^"+|"+$/g, '').trim()
  if (!clean.startsWith(prefix)) return null
  return /^[A-Za-z]\d+$/.test(clean) ? clean : null
}


export function duration(value: Num, digits = 0): string {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  if (seconds < 3_600) return `${(seconds / 60).toFixed(digits)}m`
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(digits)}h`
  return `${(seconds / 86_400).toFixed(digits)}d`
}
