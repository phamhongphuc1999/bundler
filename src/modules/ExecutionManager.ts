import { Mutex } from 'async-mutex';
import Debug from 'debug';
import { clearInterval } from 'timers';
import { type UserOperation } from '../utils';
import { ValidationManager } from '../validation-manager';
import { BundleManager, type SendBundleReturn } from './BundleManager';
import { MempoolManager } from './MempoolManager';
import { ReputationManager } from './ReputationManager';

const debug = Debug('aa.exec');

export class ExecutionManager {
  private reputationCron: any;
  private autoBundleInterval: any;
  private maxMempoolSize = 0; // default to auto-mining
  private autoInterval = 0;
  private readonly mutex = new Mutex();

  constructor(
    private readonly reputationManager: ReputationManager,
    private readonly mempoolManager: MempoolManager,
    private readonly bundleManager: BundleManager,
    private readonly validationManager: ValidationManager,
  ) {}

  async sendUserOperation(userOp: UserOperation, entryPointInput: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      debug('sendUserOperation');
      this.validationManager.validateInputParameters(userOp, entryPointInput);
      const validationResult = await this.validationManager.validateUserOp(userOp, undefined);
      const userOpHash = await this.validationManager.entryPoint.getUserOpHash(userOp);
      this.mempoolManager.addUserOp(
        userOp,
        userOpHash,
        validationResult.returnInfo.prefund,
        validationResult.referencedContracts,
        validationResult.senderInfo,
        validationResult.paymasterInfo,
        validationResult.factoryInfo,
        validationResult.aggregatorInfo,
      );
      await this.attemptBundle(false);
    });
  }

  setReputationCron(interval: number): void {
    debug('set reputation interval to', interval);
    clearInterval(this.reputationCron);
    if (interval !== 0) {
      this.reputationCron = setInterval(() => this.reputationManager.hourlyCron(), interval);
    }
  }

  setAutoBundler(autoBundleInterval: number, maxMempoolSize: number): void {
    debug(
      'set auto-bundle autoBundleInterval=',
      autoBundleInterval,
      'maxMempoolSize=',
      maxMempoolSize,
    );
    clearInterval(this.autoBundleInterval);
    this.autoInterval = autoBundleInterval;
    if (autoBundleInterval !== 0) {
      this.autoBundleInterval = setInterval(() => {
        void this.attemptBundle(true).catch((e) => console.error('auto-bundle failed', e));
      }, autoBundleInterval * 1000);
    }
    this.maxMempoolSize = maxMempoolSize;
  }

  async attemptBundle(force = true): Promise<SendBundleReturn | undefined> {
    debug(
      'attemptBundle force=',
      force,
      'count=',
      this.mempoolManager.count(),
      'max=',
      this.maxMempoolSize,
    );
    if (force || this.mempoolManager.count() >= this.maxMempoolSize) {
      const ret = await this.bundleManager.sendNextBundle();
      if (this.maxMempoolSize === 0) await this.bundleManager.handlePastEvents();
      return ret;
    }
  }
}
