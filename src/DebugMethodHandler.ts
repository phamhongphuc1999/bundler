import { type SendBundleReturn } from './modules/BundleManager';
import { EventsManager } from './modules/EventsManager';
import { ExecutionManager } from './modules/ExecutionManager';
import { MempoolManager } from './modules/MempoolManager';
import { ReputationManager, type ReputationDump } from './modules/ReputationManager';
import { type StakeInfo } from './utils';

export class DebugMethodHandler {
  constructor(
    readonly execManager: ExecutionManager,
    readonly eventsManager: EventsManager,
    readonly repManager: ReputationManager,
    readonly mempoolMgr: MempoolManager,
  ) {}

  setBundlingMode(mode: 'manual' | 'auto'): void {
    this.setBundleInterval(mode);
  }

  setBundleInterval(interval: number | 'manual' | 'auto', maxPoolSize = 100): void {
    if (interval == null) throw new Error('must specify interval <number>|manual|auto');
    if (interval === 'auto') this.execManager.setAutoBundler(0, 0);
    else if (interval === 'manual') this.execManager.setAutoBundler(0, 1000);
    else this.execManager.setAutoBundler(interval, maxPoolSize);
  }

  async sendBundleNow(): Promise<SendBundleReturn | undefined> {
    const ret = await this.execManager.attemptBundle(true);
    await this.eventsManager.handlePastEvents();
    return ret;
  }

  clearState(): void {
    this.mempoolMgr.clearState();
    this.repManager.clearState();
  }

  async dumpMempool(): Promise<any> {
    return this.mempoolMgr.dump();
  }

  clearMempool(): void {
    this.mempoolMgr.clearState();
  }

  setReputation(param: any): ReputationDump {
    return this.repManager.setReputation(param);
  }

  dumpReputation(): ReputationDump {
    return this.repManager.dump();
  }

  clearReputation(): void {
    this.repManager.clearState();
  }

  async getStakeStatus(
    address: string,
    entryPoint: string,
  ): Promise<{ stakeInfo: StakeInfo; isStaked: boolean }> {
    return await this.repManager.getStakeStatus(address, entryPoint);
  }
}
