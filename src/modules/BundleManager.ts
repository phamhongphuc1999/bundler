import { type EntryPoint } from '@account-abstraction/contracts';
import { ErrorDescription } from '@ethersproject/abi/lib/interface';
import { JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers';
import { Mutex } from 'async-mutex';
import Debug from 'debug';
import { BigNumber, type BigNumberish } from 'ethers';
import { GetUserOpHashes__factory } from '../typechain/factories/contracts/bundler/GetUserOpHashes__factory';
import {
  getAddr,
  mergeStorageMap,
  runContractScript,
  type StorageMap,
  type UserOperation,
} from '../utils';
import { ValidationManager, type ValidateUserOpResult } from '../validation-manager';
import { EventsManager } from './EventsManager';
import { MempoolManager } from './MempoolManager';
import { ReputationManager, ReputationStatus } from './ReputationManager';

const debug = Debug('aa.exec.cron');

const THROTTLED_ENTITY_BUNDLE_COUNT = 4;

export interface SendBundleReturn {
  transactionHash: string;
  userOpHashes: string[];
}

export class BundleManager {
  provider: JsonRpcProvider;
  signer: JsonRpcSigner;
  mutex = new Mutex();

  constructor(
    readonly entryPoint: EntryPoint,
    readonly eventsManager: EventsManager,
    readonly mempoolManager: MempoolManager,
    readonly validationManager: ValidationManager,
    readonly reputationManager: ReputationManager,
    readonly beneficiary: string,
    readonly minSignerBalance: BigNumberish,
    readonly maxBundleGas: number,
    readonly conditionalRpc: boolean,
    readonly mergeToAccountRootHash: boolean = false,
  ) {
    this.provider = entryPoint.provider as JsonRpcProvider;
    this.signer = entryPoint.signer as JsonRpcSigner;
  }

  async sendNextBundle(): Promise<SendBundleReturn | undefined> {
    return await this.mutex.runExclusive(async () => {
      debug('sendNextBundle');

      await this.handlePastEvents();
      const [bundle, storageMap] = await this.createBundle();
      if (bundle.length === 0) debug('sendNextBundle - no bundle to send');
      else {
        const beneficiary = await this._selectBeneficiary();
        const ret = await this.sendBundle(bundle, beneficiary, storageMap);
        debug(`sendNextBundle exit - after sent a bundle of ${bundle.length} `);
        return ret;
      }
    });
  }

  async handlePastEvents(): Promise<void> {
    await this.eventsManager.handlePastEvents();
  }

  async sendBundle(
    userOps: UserOperation[],
    beneficiary: string,
    storageMap: StorageMap,
  ): Promise<SendBundleReturn | undefined> {
    try {
      const feeData = await this.provider.getFeeData();
      const tx = await this.entryPoint.populateTransaction.handleOps(userOps, beneficiary, {
        type: 2,
        nonce: await this.signer.getTransactionCount(),
        gasLimit: 10e6,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0,
        maxFeePerGas: feeData.maxFeePerGas ?? 0,
      });
      tx.chainId = this.provider._network.chainId;
      const signedTx = await this.signer.signTransaction(tx);
      let ret: string;
      if (this.conditionalRpc) {
        debug('eth_sendRawTransactionConditional', storageMap);
        ret = await this.provider.send('eth_sendRawTransactionConditional', [
          signedTx,
          { knownAccounts: storageMap },
        ]);
        debug('eth_sendRawTransactionConditional ret=', ret);
      } else {
        ret = (await (await this.signer.sendTransaction(tx)).wait()).transactionHash;
        // ret = await this.provider.send('eth_sendRawTransaction', [signedTx]);
        debug('eth_sendRawTransaction ret=', ret);
      }
      debug('ret=', ret);
      debug('sent handleOps with', userOps.length, 'ops. removing from mempool');
      const hashes = await this.getUserOpHashes(userOps);
      return { transactionHash: ret, userOpHashes: hashes };
    } catch (e: any) {
      let parsedError: ErrorDescription;
      try {
        parsedError = this.entryPoint.interface.parseError(e.data?.data ?? e.data);
      } catch (e1) {
        this.checkFatal(e);
        console.warn('Failed handleOps, but non-FailedOp error', e);
        return;
      }
      const { opIndex, reason } = parsedError.args;
      const userOp = userOps[opIndex];
      const reasonStr: string = reason.toString();
      if (reasonStr.startsWith('AA3')) {
        this.reputationManager.crashedHandleOps(getAddr(userOp.paymasterAndData));
      } else if (reasonStr.startsWith('AA2')) {
        this.reputationManager.crashedHandleOps(userOp.sender);
      } else if (reasonStr.startsWith('AA1')) {
        this.reputationManager.crashedHandleOps(getAddr(userOp.initCode));
      } else {
        this.mempoolManager.removeUserOp(userOp);
        console.warn(`Failed handleOps sender=${userOp.sender} reason=${reasonStr}`);
      }
    }
  }

  checkFatal(e: any): void {
    if (e.error?.code === -32601) throw e;
  }

  async createBundle(): Promise<[UserOperation[], StorageMap]> {
    const entries = this.mempoolManager.getSortedForInclusion();
    const bundle: UserOperation[] = [];

    const paymasterDeposit: { [paymaster: string]: BigNumber } = {};
    const stakedEntityCount: { [addr: string]: number } = {};
    const senders = new Set<string>();
    const knownSenders = this.mempoolManager.getKnownSenders();

    const storageMap: StorageMap = {};
    let totalGas = BigNumber.from(0);
    debug('got mempool of ', entries.length);
    mainLoop: for (const entry of entries) {
      const paymaster = getAddr(entry.userOp.paymasterAndData);
      const factory = getAddr(entry.userOp.initCode);
      const paymasterStatus = this.reputationManager.getStatus(paymaster);
      const deployerStatus = this.reputationManager.getStatus(factory);
      if (
        paymasterStatus === ReputationStatus.BANNED ||
        deployerStatus === ReputationStatus.BANNED
      ) {
        this.mempoolManager.removeUserOp(entry.userOp);
        continue;
      }
      if (
        paymaster != null &&
        (paymasterStatus === ReputationStatus.THROTTLED ??
          (stakedEntityCount[paymaster] ?? 0) > THROTTLED_ENTITY_BUNDLE_COUNT)
      ) {
        debug('skipping throttled paymaster', entry.userOp.sender, entry.userOp.nonce);
        continue;
      }
      if (
        factory != null &&
        (deployerStatus === ReputationStatus.THROTTLED ??
          (stakedEntityCount[factory] ?? 0) > THROTTLED_ENTITY_BUNDLE_COUNT)
      ) {
        debug('skipping throttled factory', entry.userOp.sender, entry.userOp.nonce);
        continue;
      }
      if (senders.has(entry.userOp.sender)) {
        debug('skipping already included sender', entry.userOp.sender, entry.userOp.nonce);
        continue;
      }
      let validationResult: ValidateUserOpResult;
      try {
        validationResult = await this.validationManager.validateUserOp(
          entry.userOp,
          entry.referencedContracts,
          false,
        );
      } catch (e: any) {
        debug('failed 2nd validation:', e.message);
        this.mempoolManager.removeUserOp(entry.userOp);
        continue;
      }

      for (const storageAddress of Object.keys(validationResult.storageMap)) {
        if (
          storageAddress.toLowerCase() !== entry.userOp.sender.toLowerCase() &&
          knownSenders.includes(storageAddress.toLowerCase())
        ) {
          console.debug(
            `UserOperation from ${entry.userOp.sender} sender accessed a storage of another known sender ${storageAddress}`,
          );
          continue mainLoop;
        }
      }

      const userOpGasCost = BigNumber.from(validationResult.returnInfo.preOpGas).add(
        entry.userOp.callGasLimit,
      );
      const newTotalGas = totalGas.add(userOpGasCost);
      if (newTotalGas.gt(this.maxBundleGas)) break;
      if (paymaster != null) {
        if (paymasterDeposit[paymaster] == null) {
          paymasterDeposit[paymaster] = await this.entryPoint.balanceOf(paymaster);
        }
        if (paymasterDeposit[paymaster].lt(validationResult.returnInfo.prefund)) continue;
        stakedEntityCount[paymaster] = (stakedEntityCount[paymaster] ?? 0) + 1;
        paymasterDeposit[paymaster] = paymasterDeposit[paymaster].sub(
          validationResult.returnInfo.prefund,
        );
      }
      if (factory != null) stakedEntityCount[factory] = (stakedEntityCount[factory] ?? 0) + 1;
      if (this.mergeToAccountRootHash && this.conditionalRpc && entry.userOp.initCode.length <= 2) {
        const { storageHash } = await this.provider.send('eth_getProof', [
          entry.userOp.sender,
          [],
          'latest',
        ]);
        storageMap[entry.userOp.sender.toLowerCase()] = storageHash;
      }
      mergeStorageMap(storageMap, validationResult.storageMap);

      senders.add(entry.userOp.sender);
      bundle.push(entry.userOp);
      totalGas = newTotalGas;
    }
    return [bundle, storageMap];
  }

  async _selectBeneficiary(): Promise<string> {
    const currentBalance = await this.provider.getBalance(this.signer.getAddress());
    let beneficiary = this.beneficiary;
    if (currentBalance.lte(this.minSignerBalance)) {
      beneficiary = await this.signer.getAddress();
    }
    return beneficiary;
  }

  async getUserOpHashes(userOps: UserOperation[]): Promise<string[]> {
    const { userOpHashes } = await runContractScript(
      this.entryPoint.provider,
      new GetUserOpHashes__factory(),
      [this.entryPoint.address, userOps],
    );
    return userOpHashes;
  }
}
