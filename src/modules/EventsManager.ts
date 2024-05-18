import { type EntryPoint } from '@account-abstraction/contracts';
import {
  type AccountDeployedEvent,
  type UserOperationEventEvent,
} from '@account-abstraction/contracts/dist/types/EntryPoint';
import { type TypedEvent } from '@account-abstraction/contracts/dist/types/common';
import { type SignatureAggregatorChangedEvent } from '@account-abstraction/contracts/types/EntryPoint';
import Debug from 'debug';
import { MempoolManager } from './MempoolManager';
import { ReputationManager } from './ReputationManager';

const debug = Debug('aa.events');

export class EventsManager {
  lastBlock?: number;

  constructor(
    readonly entryPoint: EntryPoint,
    readonly mempoolManager: MempoolManager,
    readonly reputationManager: ReputationManager,
  ) {}

  initEventListener(): void {
    this.entryPoint.on(this.entryPoint.filters.UserOperationEvent(), (...args) => {
      const ev = args.slice(-1)[0];
      void this.handleEvent(ev as any);
    });
  }

  async handlePastEvents(): Promise<void> {
    if (this.lastBlock === undefined) {
      this.lastBlock = Math.max(1, (await this.entryPoint.provider.getBlockNumber()) - 1000);
    }
    const events = await this.entryPoint.queryFilter(
      { address: this.entryPoint.address },
      this.lastBlock,
    );
    for (const ev of events) {
      this.handleEvent(ev);
    }
  }

  handleEvent(
    ev: UserOperationEventEvent | AccountDeployedEvent | SignatureAggregatorChangedEvent,
  ): void {
    switch (ev.event) {
      case 'UserOperationEvent':
        this.handleUserOperationEvent(ev as any);
        break;
      case 'AccountDeployed':
        this.handleAccountDeployedEvent(ev as any);
        break;
      case 'SignatureAggregatorForUserOperations':
        this.handleAggregatorChangedEvent(ev as any);
        break;
    }
    this.lastBlock = ev.blockNumber + 1;
  }

  handleAggregatorChangedEvent(ev: SignatureAggregatorChangedEvent): void {
    debug('handle ', ev.event, ev.args.aggregator);
    this.eventAggregator = ev.args.aggregator;
    this.eventAggregatorTxHash = ev.transactionHash;
  }

  eventAggregator: string | null = null;
  eventAggregatorTxHash: string | null = null;

  getEventAggregator(ev: TypedEvent): string | null {
    if (ev.transactionHash !== this.eventAggregatorTxHash) {
      this.eventAggregator = null;
      this.eventAggregatorTxHash = ev.transactionHash;
    }
    return this.eventAggregator;
  }

  handleAccountDeployedEvent(ev: AccountDeployedEvent): void {
    this._includedAddress(ev.args.factory);
  }

  handleUserOperationEvent(ev: UserOperationEventEvent): void {
    const hash = ev.args.userOpHash;
    this.mempoolManager.removeUserOp(hash);
    this._includedAddress(ev.args.sender);
    this._includedAddress(ev.args.paymaster);
    this._includedAddress(this.getEventAggregator(ev));
  }

  _includedAddress(data: string | null): void {
    if (data != null && data.length >= 42) {
      const addr = data.slice(0, 42);
      this.reputationManager.updateIncludedStatus(addr);
    }
  }
}
