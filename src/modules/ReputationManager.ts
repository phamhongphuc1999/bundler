import { Provider } from '@ethersproject/providers';
import Debug from 'debug';
import { BigNumber } from 'ethers';
import { IStakeManager__factory } from '../typechain';
import { ValidationErrors, requireCond, tostr, type StakeInfo } from '../utils';

const debug = Debug('aa.rep');

export enum ReputationStatus {
  OK,
  THROTTLED,
  BANNED,
}

export interface ReputationParams {
  minInclusionDenominator: number;
  throttlingSlack: number;
  banSlack: number;
}

export const BundlerReputationParams: ReputationParams = {
  minInclusionDenominator: 10,
  throttlingSlack: 10,
  banSlack: 50,
};

export const NonBundlerReputationParams: ReputationParams = {
  minInclusionDenominator: 100,
  throttlingSlack: 10,
  banSlack: 10,
};

interface ReputationEntry {
  address: string;
  opsSeen: number;
  opsIncluded: number;
  status?: ReputationStatus;
}

export type ReputationDump = ReputationEntry[];

export class ReputationManager {
  constructor(
    readonly provider: Provider,
    readonly params: ReputationParams,
    readonly minStake: BigNumber,
    readonly minUnstakeDelay: number,
  ) {}

  private entries: { [address: string]: ReputationEntry } = {};
  readonly blackList = new Set<string>();
  readonly whitelist = new Set<string>();

  dump(): ReputationDump {
    Object.values(this.entries).forEach((entry) => {
      entry.status = this.getStatus(entry.address);
    });
    return Object.values(this.entries);
  }

  hourlyCron(): void {
    Object.keys(this.entries).forEach((addr) => {
      const entry = this.entries[addr];
      entry.opsSeen = Math.floor((entry.opsSeen * 23) / 24);
      entry.opsIncluded = Math.floor((entry.opsSeen * 23) / 24);
      if (entry.opsIncluded === 0 && entry.opsSeen === 0) {
        delete this.entries[addr];
      }
    });
  }

  addWhitelist(...params: string[]): void {
    params.forEach((item) => this.whitelist.add(item));
  }

  addBlacklist(...params: string[]): void {
    params.forEach((item) => this.blackList.add(item));
  }

  _getOrCreate(addr: string): ReputationEntry {
    addr = addr.toLowerCase();
    let entry = this.entries[addr];
    if (entry == null) {
      this.entries[addr] = entry = { address: addr, opsSeen: 0, opsIncluded: 0 };
    }
    return entry;
  }

  updateSeenStatus(addr?: string): void {
    if (addr == null) return;
    const entry = this._getOrCreate(addr);
    entry.opsSeen++;
    debug('after seen++', addr, entry);
  }

  updateIncludedStatus(addr: string): void {
    const entry = this._getOrCreate(addr);
    entry.opsIncluded++;
    debug('after Included++', addr, entry);
  }

  isWhitelisted(addr: string): boolean {
    return this.whitelist.has(addr);
  }

  getStatus(addr?: string): ReputationStatus {
    addr = addr?.toLowerCase();
    if (addr == null || this.whitelist.has(addr)) return ReputationStatus.OK;
    if (this.blackList.has(addr)) return ReputationStatus.BANNED;
    const entry = this.entries[addr];
    if (entry == null) return ReputationStatus.OK;
    const minExpectedIncluded = Math.floor(entry.opsSeen / this.params.minInclusionDenominator);
    if (minExpectedIncluded <= entry.opsIncluded + this.params.throttlingSlack) {
      return ReputationStatus.OK;
    } else if (minExpectedIncluded <= entry.opsIncluded + this.params.banSlack) {
      return ReputationStatus.THROTTLED;
    } else return ReputationStatus.BANNED;
  }

  async getStakeStatus(
    address: string,
    entryPointAddress: string,
  ): Promise<{
    stakeInfo: StakeInfo;
    isStaked: boolean;
  }> {
    const sm = IStakeManager__factory.connect(entryPointAddress, this.provider);
    const info = await sm.getDepositInfo(address);
    const isStaked =
      BigNumber.from(info.stake).gte(this.minStake) &&
      BigNumber.from(info.unstakeDelaySec).gte(this.minUnstakeDelay);
    return {
      stakeInfo: {
        addr: address,
        stake: info.stake.toString(),
        unstakeDelaySec: info.unstakeDelaySec.toString(),
      },
      isStaked,
    };
  }

  crashedHandleOps(addr: string | undefined): void {
    if (addr == null) return;
    const entry = this._getOrCreate(addr);
    entry.opsSeen += 10000;
    entry.opsIncluded = 0;
    debug('crashedHandleOps', addr, entry);
  }

  clearState(): void {
    this.entries = {};
  }

  setReputation(reputations: ReputationDump): ReputationDump {
    reputations.forEach((rep) => {
      this.entries[rep.address.toLowerCase()] = {
        address: rep.address,
        opsSeen: rep.opsSeen,
        opsIncluded: rep.opsIncluded,
      };
    });
    return this.dump();
  }

  checkBanned(title: 'account' | 'paymaster' | 'aggregator' | 'deployer', info: StakeInfo): void {
    requireCond(
      this.getStatus(info.addr) !== ReputationStatus.BANNED,
      `${title} ${info.addr} is banned`,
      ValidationErrors.Reputation,
      { [title]: info.addr },
    );
  }

  checkThrottled(
    title: 'account' | 'paymaster' | 'aggregator' | 'deployer',
    info: StakeInfo,
  ): void {
    requireCond(
      this.getStatus(info.addr) !== ReputationStatus.THROTTLED,
      `${title} ${info.addr} is throttled`,
      ValidationErrors.Reputation,
      { [title]: info.addr },
    );
  }

  checkStake(title: 'account' | 'paymaster' | 'aggregator' | 'deployer', info?: StakeInfo): void {
    if (info?.addr == null || this.isWhitelisted(info.addr)) return;
    requireCond(
      this.getStatus(info.addr) !== ReputationStatus.BANNED,
      `${title} ${info.addr} is banned`,
      ValidationErrors.Reputation,
      { [title]: info.addr },
    );

    requireCond(
      BigNumber.from(info.stake).gte(this.minStake),
      `${title} ${info.addr} ${tostr(info.stake) === '0' ? 'is unstaked' : `stake ${tostr(info.stake)} is too low (min=${tostr(this.minStake)})`}`,
      ValidationErrors.InsufficientStake,
    );
    requireCond(
      BigNumber.from(info.unstakeDelaySec).gte(this.minUnstakeDelay),
      `${title} ${info.addr} unstake delay ${tostr(info.unstakeDelaySec)} is too low (min=${tostr(this.minUnstakeDelay)})`,
      ValidationErrors.InsufficientStake,
    );
  }

  calculateMaxAllowedMempoolOpsUnstaked(entity: string): number {
    entity = entity.toLowerCase();
    const SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT = 10;
    const entry = this.entries[entity];
    if (entry == null) return SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT;
    const INCLUSION_RATE_FACTOR = 10;
    let inclusionRate = entry.opsIncluded / entry.opsSeen;
    if (entry.opsSeen === 0) inclusionRate = 0;
    return (
      SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT +
      Math.floor(inclusionRate * INCLUSION_RATE_FACTOR) +
      Math.min(entry.opsIncluded, 10000)
    );
  }
}
