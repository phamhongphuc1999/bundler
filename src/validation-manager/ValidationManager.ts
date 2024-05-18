import { type IEntryPoint } from '@account-abstraction/contracts';
import { JsonRpcProvider } from '@ethersproject/providers';
import Debug from 'debug';
import { BigNumber, ethers, type BigNumberish, type BytesLike } from 'ethers';
import { calcPreVerificationGas } from '../sdk';
import { CodeHashGetter__factory } from '../typechain/factories/contracts/bundler';
import {
  AddressZero,
  RpcError,
  ValidationErrors,
  decodeErrorReason,
  getAddr,
  requireCond,
  runContractScript,
  type ReferencedCodeHashes,
  type StakeInfo,
  type StorageMap,
  type UserOperation,
} from '../utils';
import {
  bundlerCollectorTracer,
  type BundlerTracerResult,
  type ExitInfo,
} from './BundlerCollectorTracer';
import { debug_traceCall } from './GethTracer';
import { tracerResultParser } from './TracerResultParser';

const debug = Debug('aa.mgr.validate');

const VALID_UNTIL_FUTURE_SECONDS = 30;

export interface ValidationResult {
  returnInfo: {
    preOpGas: BigNumberish;
    prefund: BigNumberish;
    sigFailed: boolean;
    validAfter: number;
    validUntil: number;
  };

  senderInfo: StakeInfo;
  factoryInfo?: StakeInfo;
  paymasterInfo?: StakeInfo;
  aggregatorInfo?: StakeInfo;
}

export interface ValidateUserOpResult extends ValidationResult {
  referencedContracts: ReferencedCodeHashes;
  storageMap: StorageMap;
}

const HEX_REGEX = /^0x[a-fA-F\d]*$/i;

export class ValidationManager {
  constructor(
    readonly entryPoint: IEntryPoint,
    readonly unsafe: boolean,
  ) {}

  async _callSimulateValidation(userOp: UserOperation): Promise<ValidationResult> {
    const errorResult = await this.entryPoint.callStatic
      .simulateValidation(userOp, { gasLimit: 10e6 })
      .catch((e) => e);
    return this._parseErrorResult(userOp, errorResult);
  }

  _parseErrorResult(
    userOp: UserOperation,
    errorResult: { errorName: string; errorArgs: any },
  ): ValidationResult {
    if (!errorResult?.errorName?.startsWith('ValidationResult')) {
      let paymaster = errorResult.errorArgs.paymaster;
      if (paymaster === AddressZero) {
        paymaster = undefined;
      }
      const msg: string = errorResult.errorArgs?.reason ?? errorResult.toString();

      if (paymaster == null) {
        throw new RpcError(
          `account validation failed: ${msg}`,
          ValidationErrors.SimulateValidation,
        );
      } else {
        throw new RpcError(
          `paymaster validation failed: ${msg}`,
          ValidationErrors.SimulatePaymasterValidation,
          { paymaster },
        );
      }
    }

    const {
      returnInfo,
      senderInfo,
      factoryInfo,
      paymasterInfo,
      aggregatorInfo, // may be missing (exists only SimulationResultWithAggregator
    } = errorResult.errorArgs;
    function fillEntity(data: BytesLike, info: StakeInfo): StakeInfo | undefined {
      const addr = getAddr(data);
      return addr == null ? undefined : { ...info, addr };
    }

    return {
      returnInfo,
      senderInfo: { ...senderInfo, addr: userOp.sender },
      factoryInfo: fillEntity(userOp.initCode, factoryInfo),
      paymasterInfo: fillEntity(userOp.paymasterAndData, paymasterInfo),
      aggregatorInfo: fillEntity(aggregatorInfo?.actualAggregator, aggregatorInfo?.stakeInfo),
    };
  }

  async _geth_traceCall_SimulateValidation(
    userOp: UserOperation,
  ): Promise<[ValidationResult, BundlerTracerResult]> {
    const provider = this.entryPoint.provider as JsonRpcProvider;
    const simulateCall = this.entryPoint.interface.encodeFunctionData('simulateValidation', [
      userOp,
    ]);

    const simulationGas = BigNumber.from(userOp.preVerificationGas).add(
      userOp.verificationGasLimit,
    );

    const tracerResult: BundlerTracerResult = await debug_traceCall(
      provider,
      {
        from: ethers.constants.AddressZero,
        to: this.entryPoint.address,
        data: simulateCall,
        gasLimit: simulationGas,
      },
      { tracer: bundlerCollectorTracer },
    );

    const lastResult = tracerResult.calls.slice(-1)[0];
    if (lastResult.type !== 'REVERT') {
      throw new Error('Invalid response. simulateCall must revert');
    }
    const data = (lastResult as ExitInfo).data;
    if (data === '0x') return [data as any, tracerResult];
    try {
      const { name: errorName, args: errorArgs } = this.entryPoint.interface.parseError(data);
      const errFullName = `${errorName}(${errorArgs.toString()})`;
      const errorResult = this._parseErrorResult(userOp, {
        errorName,
        errorArgs,
      });
      if (!errorName.includes('Result')) throw new Error(errFullName);
      debug(
        '==dump tree=',
        JSON.stringify(tracerResult, null, 2)
          .replace(new RegExp(userOp.sender.toLowerCase()), '{sender}')
          .replace(
            new RegExp(getAddr(userOp.paymasterAndData) ?? '--no-paymaster--'),
            '{paymaster}',
          )
          .replace(new RegExp(getAddr(userOp.initCode) ?? '--no-initcode--'), '{factory}'),
      );
      return [errorResult, tracerResult];
    } catch (e: any) {
      if (e.code != null) throw e;
      const err = decodeErrorReason(data);
      throw new RpcError(err != null ? err.message : data, 111);
    }
  }

  async validateUserOp(
    userOp: UserOperation,
    previousCodeHashes?: ReferencedCodeHashes,
    checkStakes = true,
  ): Promise<ValidateUserOpResult> {
    if (previousCodeHashes != null && previousCodeHashes.addresses.length > 0) {
      const { hash: codeHashes } = await this.getCodeHashes(previousCodeHashes.addresses);
      requireCond(
        codeHashes === previousCodeHashes.hash,
        'modified code after first validation',
        ValidationErrors.OpcodeValidation,
      );
    }
    let res: ValidationResult;
    let codeHashes: ReferencedCodeHashes = {
      addresses: [],
      hash: '',
    };
    let storageMap: StorageMap = {};
    if (!this.unsafe) {
      let tracerResult: BundlerTracerResult;
      [res, tracerResult] = await this._geth_traceCall_SimulateValidation(userOp);
      let contractAddresses: string[];
      [contractAddresses, storageMap] = tracerResultParser(
        userOp,
        tracerResult,
        res,
        this.entryPoint,
      );
      if (previousCodeHashes == null) codeHashes = await this.getCodeHashes(contractAddresses);
      if ((res as any) === '0x')
        throw new Error('simulateValidation reverted with no revert string!');
    } else res = await this._callSimulateValidation(userOp);

    requireCond(
      !res.returnInfo.sigFailed,
      'Invalid UserOp signature or paymaster signature',
      ValidationErrors.InvalidSignature,
    );

    const now = Math.floor(Date.now() / 1000);
    requireCond(
      res.returnInfo.validAfter <= now,
      'time-range in the future time',
      ValidationErrors.NotInTimeRange,
    );

    requireCond(
      res.returnInfo.validUntil == null || res.returnInfo.validUntil >= now,
      'already expired',
      ValidationErrors.NotInTimeRange,
    );

    requireCond(
      res.returnInfo.validUntil == null ||
        res.returnInfo.validUntil > now + VALID_UNTIL_FUTURE_SECONDS,
      'expires too soon',
      ValidationErrors.NotInTimeRange,
    );

    requireCond(
      res.aggregatorInfo == null,
      'Currently not supporting aggregator',
      ValidationErrors.UnsupportedSignatureAggregator,
    );

    const verificationCost = BigNumber.from(res.returnInfo.preOpGas).sub(userOp.preVerificationGas);
    const extraGas = BigNumber.from(userOp.verificationGasLimit).sub(verificationCost).toNumber();
    requireCond(
      extraGas >= 2000,
      `verificationGas should have extra 2000 gas. has only ${extraGas}`,
      ValidationErrors.SimulateValidation,
    );

    return { ...res, referencedContracts: codeHashes, storageMap };
  }

  async getCodeHashes(addresses: string[]): Promise<ReferencedCodeHashes> {
    const { hash } = await runContractScript(
      this.entryPoint.provider,
      new CodeHashGetter__factory(),
      [addresses],
    );
    return { hash, addresses };
  }

  validateInputParameters(
    userOp: UserOperation,
    entryPointInput: string,
    requireSignature = true,
    requireGasParams = true,
  ): void {
    requireCond(entryPointInput != null, 'No entryPoint param', ValidationErrors.InvalidFields);
    requireCond(
      entryPointInput.toLowerCase() === this.entryPoint.address.toLowerCase(),
      `The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.entryPoint.address}`,
      ValidationErrors.InvalidFields,
    );

    requireCond(userOp != null, 'No UserOperation param', ValidationErrors.InvalidFields);

    const fields = ['sender', 'nonce', 'initCode', 'callData', 'paymasterAndData'];
    if (requireSignature) {
      fields.push('signature');
    }
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
      const value: string = (userOp as any)[key]?.toString();
      requireCond(
        value != null,
        'Missing userOp field: ' + key + ' ' + JSON.stringify(userOp),
        ValidationErrors.InvalidFields,
      );
      requireCond(
        value.match(HEX_REGEX) != null,
        `Invalid hex value for property ${key}:${value} in UserOp`,
        ValidationErrors.InvalidFields,
      );
    });

    requireCond(
      userOp.paymasterAndData.length === 2 || userOp.paymasterAndData.length >= 42,
      'paymasterAndData: must contain at least an address',
      ValidationErrors.InvalidFields,
    );

    requireCond(
      userOp.initCode.length === 2 || userOp.initCode.length >= 42,
      'initCode: must contain at least an address',
      ValidationErrors.InvalidFields,
    );

    const calcPreVerificationGas1 = calcPreVerificationGas(userOp);
    requireCond(
      BigNumber.from(userOp.preVerificationGas).toNumber() >= calcPreVerificationGas1,
      `preVerificationGas too low: expected at least ${calcPreVerificationGas1}`,
      ValidationErrors.InvalidFields,
    );
  }
}
