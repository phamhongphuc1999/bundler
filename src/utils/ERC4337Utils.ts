import { type UserOperationStruct } from '@account-abstraction/contracts';
import { abi as entryPointAbi } from '@account-abstraction/contracts/artifacts/IEntryPoint.json';
import Debug from 'debug';
import { ethers } from 'ethers';
import {
  defaultAbiCoder,
  hexConcat,
  hexlify,
  keccak256,
  resolveProperties,
} from 'ethers/lib/utils';

const debug = Debug('aa.utils');

const validateUserOpMethod = 'simulateValidation';
const UserOpType = entryPointAbi.find((entry) => entry.name === validateUserOpMethod)?.inputs[0];
if (UserOpType == null) {
  throw new Error(
    `unable to find method ${validateUserOpMethod} in EP ${entryPointAbi
      .filter((x) => x.type === 'function')
      .map((x) => x.name)
      .join(',')}`,
  );
}

export const AddressZero = ethers.constants.AddressZero;

export type NotPromise<T> = {
  [P in keyof T]: Exclude<T[P], Promise<any>>;
};

export function packUserOp(op: NotPromise<UserOperationStruct>, forSignature = true): string {
  if (forSignature) {
    return defaultAbiCoder.encode(
      [
        'address',
        'uint256',
        'bytes32',
        'bytes32',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'bytes32',
      ],
      [
        op.sender,
        op.nonce,
        keccak256(op.initCode),
        keccak256(op.callData),
        op.callGasLimit,
        op.verificationGasLimit,
        op.preVerificationGas,
        op.maxFeePerGas,
        op.maxPriorityFeePerGas,
        keccak256(op.paymasterAndData),
      ],
    );
  } else {
    return defaultAbiCoder.encode(
      [
        'address',
        'uint256',
        'bytes',
        'bytes',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'bytes',
        'bytes',
      ],
      [
        op.sender,
        op.nonce,
        op.initCode,
        op.callData,
        op.callGasLimit,
        op.verificationGasLimit,
        op.preVerificationGas,
        op.maxFeePerGas,
        op.maxPriorityFeePerGas,
        op.paymasterAndData,
        op.signature,
      ],
    );
  }
}

export function getUserOpHash(
  op: NotPromise<UserOperationStruct>,
  entryPoint: string,
  chainId: number,
): string {
  const userOpHash = keccak256(packUserOp(op, true));
  const enc = defaultAbiCoder.encode(
    ['bytes32', 'address', 'uint256'],
    [userOpHash, entryPoint, chainId],
  );
  return keccak256(enc);
}

const ErrorSig = keccak256(Buffer.from('Error(string)')).slice(0, 10); // 0x08c379a0
const FailedOpSig = keccak256(Buffer.from('FailedOp(uint256,string)')).slice(0, 10); // 0x220266b6

interface DecodedError {
  message: string;
  opIndex?: number;
}

export function decodeErrorReason(error: string): DecodedError | undefined {
  debug('decoding', error);
  if (error.startsWith(ErrorSig)) {
    const [message] = defaultAbiCoder.decode(['string'], '0x' + error.substring(10));
    return { message };
  } else if (error.startsWith(FailedOpSig)) {
    let [opIndex, message] = defaultAbiCoder.decode(
      ['uint256', 'string'],
      '0x' + error.substring(10),
    );
    message = `FailedOp: ${message as string}`;
    return { message, opIndex };
  }
}

export function rethrowError(e: any): any {
  let error = e;
  let parent = e;
  if (error?.error != null) error = error.error;
  while (error?.data != null) {
    parent = error;
    error = error.data;
  }
  const decoded =
    typeof error === 'string' && error.length > 2 ? decodeErrorReason(error) : undefined;
  if (decoded != null) {
    e.message = decoded.message;
    if (decoded.opIndex != null) {
      const errorWithMsg = hexConcat([
        ErrorSig,
        defaultAbiCoder.encode(['string'], [decoded.message]),
      ]);
      parent.data = errorWithMsg;
    }
  }
  throw e;
}

export function deepHexlify(obj: any): any {
  if (typeof obj === 'function') return undefined;
  if (obj == null || typeof obj === 'string' || typeof obj === 'boolean') {
    return obj;
  } else if (obj._isBigNumber != null || typeof obj !== 'object') {
    return hexlify(obj).replace(/^0x0/, '0x');
  }
  if (Array.isArray(obj)) return obj.map((member) => deepHexlify(member));
  return Object.keys(obj).reduce(
    (set, key) => ({
      ...set,
      [key]: deepHexlify(obj[key]),
    }),
    {},
  );
}

export async function resolveHexlify(a: any): Promise<any> {
  return deepHexlify(await resolveProperties(a));
}
