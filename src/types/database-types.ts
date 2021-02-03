export interface DecodedSequencerBatchTransaction {
  sig: {
    r: string
    s: string
    v: string
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

export interface TransactionBatchEntry {
  index: number
  blockNumber: number
  timestamp: number
  submitter: string
  size: number
  root: string
  prevTotalElements: number
  extraData: string
}

export interface StateRootEntry {
  index: number
  batchIndex: number
  value: string
}

export interface StateRootBatchEntry {
  index: number
  blockNumber: number
  timestamp: number
  submitter: string
  size: number
  root: string
  prevTotalElements: number
  extraData: string
}
