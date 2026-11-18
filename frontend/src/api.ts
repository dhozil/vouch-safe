import { createClient } from 'genlayer-js'
import { localnet, studionet, testnetAsimov, testnetBradbury } from 'genlayer-js/chains'
import type { Address } from 'viem'
import type { TxStage, TxVotes } from './types'

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
}

declare global {
  interface Window {
    ethereum?: Eip1193
  }
}

const NETWORKS = {
  localnet,
  studionet,
  'testnet-bradbury': testnetBradbury,
  'testnet-asimov': testnetAsimov,
} as const

export type NetworkKey = keyof typeof NETWORKS

export const NETWORK_NAME = (import.meta.env.VITE_NETWORK ?? 'studionet') as NetworkKey
const CONNECT_NETWORK = {
  localnet: 'localnet',
  studionet: 'studionet',
  'testnet-bradbury': 'testnetBradbury',
  'testnet-asimov': 'testnetAsimov',
} as const
export const CHAIN = NETWORKS[NETWORK_NAME] ?? studionet
export const CONTRACT = (import.meta.env.VITE_CONTRACT_ADDRESS ?? '').trim()
export const IS_CONFIGURED = /^0x[0-9a-fA-F]{40}$/.test(CONTRACT)
export const DEMO_MODE = import.meta.env.VITE_DEMO === '1'

const readClient = createClient({ chain: CHAIN })

export function walletClient(account: string, provider: Eip1193) {
  return createClient({
    chain: CHAIN,
    account: account as Address,
    provider: provider as never,
  })
}

const MAX_READS = 3
let activeReads = 0
const readWaiters: Array<() => void> = []

async function withReadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeReads >= MAX_READS) {
    await new Promise<void>((resolve) => readWaiters.push(resolve))
  }
  activeReads += 1
  try {
    return await task()
  } finally {
    activeReads -= 1
    readWaiters.shift()?.()
  }
}

export async function read<T>(functionName: string, args: unknown[] = []): Promise<T> {
  // Studio's public RPC allows ~30 non-eth_* calls a minute. A page refresh
  // asks for the whole book, so cap concurrency and retry a throttled read
  // with a longer backoff instead of firing the next burst too early.
  return withReadSlot(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await readClient.readContract({
          address: CONTRACT as Address,
          functionName,
          args: args as never[],
        })
        return result as T
      } catch (err) {
        const message = String((err as Error)?.message ?? err)
        const transient = /Failed to fetch|rate limit|429|timed out|unknown RPC/i.test(message)
        if (attempt >= 3 || !transient) {
          if (transient) {
            throw new Error('Studio RPC is throttling reads. Wait a moment, then retry.')
          }
          throw err
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)))
      }
    }
  })
}

export interface TxMeta {
  stage: TxStage
  status?: string
  hash?: string
}

export interface WriteResult {
  hash: string
  ok: boolean
  status: string
  execution: string
  payload: string
  votes: TxVotes
  rounds: number
}

const STATUS_BY_NUMBER: Record<number, string> = {
  0: 'UNINITIALIZED',
  1: 'PENDING',
  2: 'PROPOSING',
  3: 'COMMITTING',
  4: 'REVEALING',
  5: 'ACCEPTED',
  6: 'UNDETERMINED',
  7: 'FINALIZED',
  8: 'CANCELED',
  9: 'APPEAL_REVEALING',
  10: 'APPEAL_COMMITTING',
  11: 'READY_TO_FINALIZE',
  12: 'VALIDATORS_TIMEOUT',
  13: 'LEADER_TIMEOUT',
}

function stageFor(status: string): TxStage {
  if (status === 'FINALIZED') return 'FINALIZED'
  if (status === 'UNDETERMINED' || status === 'VALIDATORS_TIMEOUT' || status === 'LEADER_TIMEOUT') {
    return 'UNDETERMINED'
  }
  if (status === 'CANCELED') return 'CANCELED'
  if (status === 'ACCEPTED' || status === 'READY_TO_FINALIZE') return 'ACCEPTED'
  return 'CONSENSUS'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type RawTx = {
  status?: number
  statusName?: string
  num_of_rounds?: string
  numOfRounds?: string
  consensus_data?: {
    votes?: Record<string, string>
    leader_receipt?: Array<{
      execution_result?: string
      result?: { payload?: unknown }
    }>
  }
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim()
  if (payload && typeof payload === 'object') {
    const readable = (payload as { readable?: unknown }).readable
    if (typeof readable === 'string') return readable.trim()
    const raw = (payload as { raw?: unknown }).raw
    if (Array.isArray(raw)) {
      try {
        return new TextDecoder().decode(new Uint8Array(raw as number[])).trim()
      } catch {
        return ''
      }
    }
  }
  return ''
}

function readTx(tx: RawTx) {
  const leader = tx.consensus_data?.leader_receipt?.[0]
  const execution = leader?.execution_result ?? 'UNKNOWN'
  const payload = payloadText(leader?.result?.payload)
  const votes = Object.values(tx.consensus_data?.votes ?? {}).map((vote) =>
    String(vote).toLowerCase(),
  )
  return {
    execution,
    payload,
    votes: {
      agree: votes.filter((vote) => vote === 'agree').length,
      disagree: votes.filter((vote) => vote === 'disagree').length,
      total: votes.length,
    },
    rounds: Number(tx.numOfRounds ?? tx.num_of_rounds ?? 0),
  }
}

export async function write(
  client: ReturnType<typeof walletClient>,
  functionName: string,
  args: unknown[] = [],
  value = 0n,
  onStage?: (meta: TxMeta) => void,
): Promise<WriteResult> {
  onStage?.({ stage: 'SIGNING' })

  const hash = (await client.writeContract({
    address: CONTRACT as Address,
    functionName,
    args: args as never[],
    value,
  })) as string

  onStage?.({ stage: 'SUBMITTED', hash })

  let last = ''
  let tx: RawTx | null = null
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      tx = (await client.getTransaction({ hash: hash as never })) as unknown as RawTx
    } catch {
      await sleep(4_000)
      continue
    }
    const name = tx.statusName ?? (tx.status !== undefined ? STATUS_BY_NUMBER[tx.status] : '')
    if (name && name !== last) {
      last = name
      onStage?.({ stage: stageFor(name), status: name, hash })
    }
    if (
      name === 'FINALIZED' ||
      name === 'UNDETERMINED' ||
      name === 'CANCELED' ||
      name === 'VALIDATORS_TIMEOUT' ||
      name === 'LEADER_TIMEOUT'
    ) {
      break
    }
    await sleep(4_000)
  }

  if (!tx) {
    onStage?.({ stage: 'TIMEOUT', hash })
    throw new Error('The network did not answer for this transaction. Check the explorer before retrying.')
  }

  const detail = readTx(tx)
  const status = tx.statusName ?? (tx.status !== undefined ? STATUS_BY_NUMBER[tx.status] : 'UNKNOWN')
  if (status !== 'FINALIZED') {
    onStage?.({ stage: stageFor(status), status, hash })
  } else {
    onStage?.({ stage: 'FINALIZED', status, hash })
  }

  return {
    hash,
    ok:
      status === 'FINALIZED' &&
      (detail.execution === 'FINISHED_WITH_RETURN' || detail.execution === 'SUCCESS'),
    status,
    execution: detail.payload || detail.execution,
    payload: detail.payload,
    votes: detail.votes,
    rounds: detail.rounds,
  }
}

export async function connectWallet(): Promise<string> {
  if (!window.ethereum) {
    throw new Error('No browser wallet found. Install MetaMask or another EIP-1193 wallet.')
  }
  const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts?.length) throw new Error('Wallet returned no account.')
  const client = walletClient(accounts[0], window.ethereum)
  try {
    await client.connect(CONNECT_NETWORK[NETWORK_NAME])
  } catch {
    // Some wallets are already on the right chain and reject the switch request.
  }
  return accounts[0]
}

export function prettyError(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0]
  if (typeof error === 'string') return error.split('\n')[0]
  return 'Transaction failed. Open the explorer for the full trace.'
}
