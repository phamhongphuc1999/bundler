import { type EntryPoint, type UserOperationStruct } from '@account-abstraction/contracts';
import { type UserOperationEventEvent } from '@account-abstraction/contracts/dist/types/EntryPoint';
import { Provider, type Log } from '@ethersproject/providers';
import { BigNumber, Signer, type BigNumberish } from 'ethers';
import { resolveProperties } from 'ethers/lib/utils';
import { type BundlerConfig } from './BundlerConfig';
import { type UserOperationByHashResponse, type UserOperationReceipt } from './RpcTypes';
import { ExecutionManager } from './modules/ExecutionManager';
import { calcPreVerificationGas } from './sdk';
import {
  RpcError,
  ValidationErrors,
  deepHexlify,
  erc4337RuntimeVersion,
  getAddr,
  requireCond,
  tostr,
  type UserOperation,
} from './utils';

const HEX_REGEX = /^0x[a-fA-F\d]*$/i;

export interface EstimateUserOpGasResult {
  preVerificationGas: BigNumberish;
  verificationGasLimit: BigNumberish;
  validAfter?: BigNumberish;
  validUntil?: BigNumberish;
  callGasLimit: BigNumberish;
}

export class UserOpMethodHandler {
  constructor(
    readonly execManager: ExecutionManager,
    readonly provider: Provider,
    readonly signer: Signer,
    readonly config: BundlerConfig,
    readonly entryPoint: EntryPoint,
  ) {}

  async getSupportedEntryPoints(): Promise<string[]> {
    return [this.config.entryPoint];
  }

  async selectBeneficiary(): Promise<string> {
    const currentBalance = await this.provider.getBalance(this.signer.getAddress());
    let beneficiary = this.config.beneficiary;
    if (currentBalance.lte(this.config.minBalance)) {
      beneficiary = await this.signer.getAddress();
      console.log(
        'low balance. using ',
        beneficiary,
        'as beneficiary instead of ',
        this.config.beneficiary,
      );
    }
    return beneficiary;
  }

  async _validateParameters(
    userOp1: UserOperationStruct,
    entryPointInput: string,
    requireSignature = true,
    requireGasParams = true,
  ): Promise<void> {
    requireCond(entryPointInput != null, 'No entryPoint param', -32602);

    if (entryPointInput?.toString().toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw new Error(
        `The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.config.entryPoint}`,
      );
    }
    requireCond(userOp1 != null, 'No UserOperation param');
    const userOp = (await resolveProperties(userOp1)) as any;

    const fields = ['sender', 'nonce', 'initCode', 'callData', 'paymasterAndData'];
    if (requireSignature) fields.push('signature');
    if (requireGasParams) {
      fields.push(
        'preVerificationGas',
        'verificationGasLimit',
        'callGasLimit',
        'maxFeePerGas',
        'maxPriorityFeePerGas',
      );
    }
    fields.forEach((key) => {
      requireCond(
        userOp[key] != null,
        'Missing userOp field: ' + key + JSON.stringify(userOp),
        -32602,
      );
      const value: string = userOp[key].toString();
      requireCond(
        value.match(HEX_REGEX) != null,
        `Invalid hex value for property ${key}:${value} in UserOp`,
        -32602,
      );
    });
  }

  async estimateUserOperationGas(
    userOp1: UserOperationStruct,
    entryPointInput: string,
  ): Promise<EstimateUserOpGasResult> {
    const userOp = {
      paymasterAndData: '0x',
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      preVerificationGas: 0,
      verificationGasLimit: 10e6,
      ...((await resolveProperties(userOp1)) as any),
    };
    await this._validateParameters(deepHexlify(userOp), entryPointInput);
    const errorResult = await this.entryPoint.callStatic.simulateValidation(userOp).catch((e) => e);
    if (errorResult.errorName === 'FailedOp') {
      throw new RpcError(errorResult.errorArgs.at(-1), ValidationErrors.SimulateValidation);
    }
    if (errorResult.errorName !== 'ValidationResult') throw errorResult;

    const { returnInfo } = errorResult.errorArgs;
    let { preOpGas, validAfter, validUntil } = returnInfo;

    const callGasLimit = await this.provider
      .estimateGas({
        from: this.entryPoint.address,
        to: userOp.sender,
        data: userOp.callData,
      })
      .then((b) => b.toNumber())
      .catch((err) => {
        const message = err.message.match(/reason="(.*?)"/)?.at(1) ?? 'execution reverted';
        throw new RpcError(message, ValidationErrors.UserOperationReverted);
      });
    validAfter = BigNumber.from(validAfter);
    validUntil = BigNumber.from(validUntil);
    if ((validUntil as BigNumber).eq(0)) validUntil = undefined;
    if ((validAfter as BigNumber).eq(0)) validAfter = undefined;
    const preVerificationGas = calcPreVerificationGas(userOp);
    const verificationGasLimit = BigNumber.from(preOpGas).toNumber();
    return { preVerificationGas, verificationGasLimit, validAfter, validUntil, callGasLimit };
  }

  async sendUserOperation(userOp1: UserOperationStruct, entryPointInput: string): Promise<string> {
    await this._validateParameters(userOp1, entryPointInput);
    const userOp = await resolveProperties(userOp1);
    console.log(
      `UserOperation: Sender=${userOp.sender}  Nonce=${tostr(userOp.nonce)} EntryPoint=${entryPointInput}`,
    );
    await this.execManager.sendUserOperation(userOp, entryPointInput);
    return await this.entryPoint.getUserOpHash(userOp);
  }

  async _getUserOperationEvent(userOpHash: string): Promise<UserOperationEventEvent> {
    const event = await this.entryPoint.queryFilter(
      this.entryPoint.filters.UserOperationEvent(userOpHash),
    );
    return event[0];
  }

  _filterLogs(userOpEvent: UserOperationEventEvent, logs: Log[]): Log[] {
    let startIndex = -1;
    let endIndex = -1;
    const events = Object.values(this.entryPoint.interface.events);
    const beforeExecutionTopic = this.entryPoint.interface.getEventTopic(
      events.find((e) => e.name === 'BeforeExecution')!,
    );
    logs.forEach((log, index) => {
      if (log?.topics[0] === beforeExecutionTopic) {
        startIndex = endIndex = index;
      } else if (log?.topics[0] === userOpEvent.topics[0]) {
        if (log.topics[1] === userOpEvent.topics[1]) {
          endIndex = index;
        } else if (endIndex === -1) startIndex = index;
      }
    });
    if (endIndex === -1) throw new Error('fatal: no UserOperationEvent in logs');
    return logs.slice(startIndex + 1, endIndex);
  }

  async getUserOperationByHash(userOpHash: string): Promise<UserOperationByHashResponse | null> {
    requireCond(
      userOpHash?.toString()?.match(HEX_REGEX) != null,
      'Missing/invalid userOpHash',
      -32602,
    );
    const event = await this._getUserOperationEvent(userOpHash);
    if (event == null) return null;
    const tx = await event.getTransaction();
    if (tx.to !== this.entryPoint.address) throw new Error('unable to parse transaction');
    const parsed = this.entryPoint.interface.parseTransaction(tx);
    const ops: UserOperation[] = parsed?.args.ops;
    if (ops == null) throw new Error('failed to parse transaction');
    const op = ops.find(
      (op) => op.sender === event.args.sender && BigNumber.from(op.nonce).eq(event.args.nonce),
    );
    if (op == null) throw new Error('unable to find userOp in transaction');

    const {
      sender,
      nonce,
      initCode,
      callData,
      callGasLimit,
      verificationGasLimit,
      preVerificationGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData,
      signature,
    } = op;

    return deepHexlify({
      userOperation: {
        sender,
        nonce,
        initCode,
        callData,
        callGasLimit,
        verificationGasLimit,
        preVerificationGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        paymasterAndData,
        signature,
      },
      entryPoint: this.entryPoint.address,
      transactionHash: tx.hash,
      blockHash: tx.blockHash ?? '',
      blockNumber: tx.blockNumber ?? 0,
    });
  }

  async getUserOperationReceipt(userOpHash: string): Promise<UserOperationReceipt | null> {
    requireCond(
      userOpHash?.toString()?.match(HEX_REGEX) != null,
      'Missing/invalid userOpHash',
      -32602,
    );
    const event = await this._getUserOperationEvent(userOpHash);
    if (event == null) return null;
    const receipt = await event.getTransactionReceipt();
    const logs = this._filterLogs(event, receipt.logs);
    return deepHexlify({
      userOpHash,
      sender: event.args.sender,
      nonce: event.args.nonce,
      actualGasCost: event.args.actualGasCost,
      actualGasUsed: event.args.actualGasUsed,
      success: event.args.success,
      logs,
      receipt,
    });
  }

  clientVersion(): string {
    return 'aa-bundler/' + erc4337RuntimeVersion + (this.config.unsafe ? '/unsafe' : '');
  }
}
