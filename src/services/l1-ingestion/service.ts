/* Imports: External */
import { BaseService } from '@eth-optimism/service-base'
import { JsonRpcProvider } from '@ethersproject/providers'
import colors from 'colors/safe'

/* Imports: Internal */
import { TransportDB } from '../../db/transport-db'
import {
  OptimismContracts,
  sleep,
  loadOptimismContracts,
  ZERO_ADDRESS,
} from '../../utils'
import {
  EventArgsAddressSet,
  TypedEthersEvent,
  EventHandlerSet,
} from '../../types'
import { handleEventsTransactionEnqueued } from './handlers/transaction-enqueued'
import { handleEventsSequencerBatchAppended } from './handlers/sequencer-batch-appended'
import { handleEventsStateBatchAppended } from './handlers/state-batch-appended'

export interface L1IngestionServiceOptions {
  db: any
  addressManager: string
  confirmations: number
  l1RpcProvider: string | JsonRpcProvider
  pollingInterval: number
  logsPerPollingInterval: number
  dangerouslyCatchAllErrors?: boolean
}

export class L1IngestionService extends BaseService<L1IngestionServiceOptions> {
  protected name = 'L1 Ingestion Service'

  // TODO: Double check these defaults.
  protected defaultOptions = {
    confirmations: 12,
    pollingInterval: 5000,
    logsPerPollingInterval: 2000,
    dangerouslyCatchAllErrors: false,
  }

  private state: {
    db: TransportDB
    contracts: OptimismContracts
    l1RpcProvider: JsonRpcProvider
    startingL1BlockNumber: number
  } = {} as any

  protected async _init(): Promise<void> {
    this.state.db = new TransportDB(this.options.db)

    this.state.l1RpcProvider =
      typeof this.options.l1RpcProvider === 'string'
        ? new JsonRpcProvider(this.options.l1RpcProvider)
        : this.options.l1RpcProvider

    // Would be nice if this weren't necessary, maybe one day.
    this.state.contracts = await loadOptimismContracts(
      this.state.l1RpcProvider,
      this.options.addressManager
    )

    // Assume we won't have too many of these events. Doubtful we'll ever have the 2000+ that would
    // break this statement when interacting with alchemy or infura. But probably worth figuring
    // out a better way to get this information, perhaps our contracts should always emit an event
    // upon creation.
    this.state.startingL1BlockNumber = (
      await this.state.contracts.Lib_AddressManager.queryFilter(
        this.state.contracts.Lib_AddressManager.filters.AddressSet()
      )
    )[0].blockNumber

    await this.state.db.putHighestL2BlockNumber(
      await this.state.contracts.OVM_CanonicalTransactionChain.getTotalElements()
    )
  }

  protected async _start(): Promise<void> {
    // This is our main function. It's basically just an infinite loop that attempts to stay in
    // sync with events coming from Ethereum. Loops as quickly as it can until it approaches the
    // tip of the chain, after which it starts waiting for a few seconds between each loop to avoid
    // unnecessary spam.
    while (this.running) {
      try {
        const highestSyncedL1Block =
          (await this.state.db.getHighestSyncedL1Block()) ||
          this.state.startingL1BlockNumber
        const currentL1Block = await this.state.l1RpcProvider.getBlockNumber()
        const targetL1Block = Math.min(
          highestSyncedL1Block + this.options.logsPerPollingInterval,
          currentL1Block - this.options.confirmations
        )

        // We're already at the head, so no point in attempting to sync.
        if (highestSyncedL1Block === targetL1Block) {
          await sleep(this.options.pollingInterval)
          continue
        }

        this.logger.info(
          `Synchronizing events from Layer 1 (Ethereum) from block ${colors.yellow(
            `${highestSyncedL1Block}`
          )} to block ${colors.yellow(`${targetL1Block}`)}`
        )

        // I prefer to do this in serial to avoid non-determinism. We could have a discussion about
        // using Promise.all if necessary, but I don't see a good reason to do so unless parsing is
        // really, really slow for all event types.
        await this._syncEvents(
          'OVM_CanonicalTransactionChain',
          'TransactionEnqueued',
          highestSyncedL1Block,
          targetL1Block,
          handleEventsTransactionEnqueued
        )

        await this._syncEvents(
          'OVM_CanonicalTransactionChain',
          'SequencerBatchAppended',
          highestSyncedL1Block,
          targetL1Block,
          handleEventsSequencerBatchAppended
        )

        await this._syncEvents(
          'OVM_StateCommitmentChain',
          'StateBatchAppended',
          highestSyncedL1Block,
          targetL1Block,
          handleEventsStateBatchAppended
        )

        await this.state.db.setHighestSyncedL1Block(targetL1Block)

        if (
          currentL1Block - highestSyncedL1Block <
          this.options.logsPerPollingInterval
        ) {
          await sleep(this.options.pollingInterval)
        }
      } catch (err) {
        if (!this.running || this.options.dangerouslyCatchAllErrors) {
          this.logger.error(`Caught an unhandled error: ${err}`)
          await sleep(this.options.pollingInterval)
        } else {
          // TODO: Is this the best thing to do here?
          throw err
        }
      }
    }
  }

  private async _syncEvents(
    contractName: string,
    eventName: string,
    fromL1Block: number,
    toL1Block: number,
    handlers: EventHandlerSet<any, any, any>
  ): Promise<void> {
    // Basic sanity checks.
    if (!this.state.contracts[contractName]) {
      throw new Error(`Contract ${contractName} does not exist.`)
    }

    // Basic sanity checks.
    if (!this.state.contracts[contractName].filters[eventName]) {
      throw new Error(
        `Event ${eventName} does not exist on contract ${contractName}`
      )
    }

    // We need to figure out how to make this work without Infura. Mark and I think that infura is
    // doing some indexing of events beyond Geth's native capabilities, meaning some event logic
    // will only work on Infura and not on a local geth instance. Not great.
    const addressSetEvents = ((await this.state.contracts.Lib_AddressManager.queryFilter(
      this.state.contracts.Lib_AddressManager.filters.AddressSet(),
      fromL1Block,
      toL1Block
    )) as TypedEthersEvent<EventArgsAddressSet>[]).filter((event) => {
      return event.args._name === contractName
    })

    // We're going to parse things out in ranges because the address of a given contract may have
    // changed in the range provided by the user.
    const eventRanges: {
      address: string
      fromBlock: number
      toBlock: number
    }[] = []

    // Add a range for each address change.
    let l1BlockRangeStart = fromL1Block
    for (const addressSetEvent of addressSetEvents) {
      eventRanges.push({
        address: await this._getContractAddressAtBlock(
          contractName,
          addressSetEvent.blockNumber
        ),
        fromBlock: l1BlockRangeStart,
        toBlock: addressSetEvent.blockNumber,
      })

      l1BlockRangeStart = addressSetEvent.blockNumber
    }

    // Add one more range to get us to the end of the user-provided block range.
    eventRanges.push({
      address: await this._getContractAddressAtBlock(contractName, toL1Block),
      fromBlock: l1BlockRangeStart,
      toBlock: toL1Block,
    })

    for (const eventRange of eventRanges) {
      // Find all relevant events within the range.
      const events: TypedEthersEvent<any>[] = await this.state.contracts[
        contractName
      ]
        .attach(eventRange.address)
        .queryFilter(
          this.state.contracts[contractName].filters[eventName](),
          eventRange.fromBlock,
          eventRange.toBlock
        )

      // Handle events, if any.
      if (events.length > 0) {
        const tick = Date.now()

        for (const event of events) {
          const extraData = await handlers.getExtraData(
            event,
            this.state.l1RpcProvider
          )
          const parsedEvent = await handlers.parseEvent(event, extraData)
          await handlers.storeEvent(parsedEvent, this.state.db)
        }

        const tock = Date.now()

        this.logger.success(
          `Processed ${colors.magenta(`${events.length}`)} ${colors.cyan(
            eventName
          )} events in ${colors.red(`${tock - tick}ms`)}.`
        )
      }
    }
  }

  /**
   * Gets the address of a contract at a particular block in the past.
   * @param contractName Name of the contract to get an address for.
   * @param blockNumber Block at which to get an address.
   * @return Contract address.
   */
  private async _getContractAddressAtBlock(
    contractName: string,
    blockNumber: number
  ): Promise<string> {
    // TODO: Should be much easier than this. Need to change the params of this event.
    const relevantAddressSetEvents = (
      await this.state.contracts.Lib_AddressManager.queryFilter(
        this.state.contracts.Lib_AddressManager.filters.AddressSet()
      )
    ).filter((event) => {
      return (
        event.args._name === contractName && event.blockNumber < blockNumber
      )
    })

    if (relevantAddressSetEvents.length > 0) {
      return relevantAddressSetEvents[relevantAddressSetEvents.length - 1].args
        ._newAddress
    } else {
      // Address wasn't set before this.
      return ZERO_ADDRESS
    }
  }
}
