export interface DecodedSequencerBatchTransaction {
  sig: {
    r: string
    s: string
    v: number
  }
  gasLimit: number
  gasPrice: number
  nonce: number
  target: string
  data: string
}

export interface EnqueueEntry {
  index: number
  target: string
  data: string
  gasLimit: number
  origin: string
  blockNumber: number
  timestamp: number
}

export interface TransactionEntry {
  index: number
  batchIndex: number
  data: string
  blockNumber: number
  timestamp: number
  gasLimit: number
  target: string
  origin: string
  queueOrigin: 'sequencer' | 'l1'
  queueIndex: number | null
  type: 'EIP155' | 'ETH_SIGN' | null
  decoded: DecodedSequencerBatchTransaction | null
}

interface BatchEntry {
  index: number
  blockNumber: number
  timestamp: number
  submitter: string
  size: number
  root: string
  prevTotalElements: number
  extraData: string
  l1TransactionHash: string
}

export type TransactionBatchEntry = BatchEntry
export type StateRootBatchEntry = BatchEntry

export interface StateRootEntry {
  index: number
  batchIndex: number
  value: string
}
