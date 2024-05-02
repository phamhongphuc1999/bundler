import type { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { BigNumber, ContractFactory, type BigNumberish } from 'ethers';
import { hexZeroPad, hexlify, type BytesLike, type Result } from 'ethers/lib/utils';
import type { PackedUserOperationStruct } from '../typechain/contracts/Account';

import {
  type IEntryPointSimulations,
  type IStakeManager,
} from '../typechain/@account-abstraction/contracts/interfaces/IEntryPointSimulations';
import type { UserOperation } from './ERC4337Utils';

export const erc4337RuntimeVersion = '1';

export type ValidationResultStructOutput = IEntryPointSimulations.ValidationResultStructOutput;
export type ExecutionResultStructOutput = IEntryPointSimulations.ExecutionResultStructOutput;
export type StakeInfoStructOutput = IStakeManager.StakeInfoStructOutput;

// reverse "Deferrable" or "PromiseOrValue" fields
export type NotPromise<T> = {
  [P in keyof T]: Exclude<T[P], Promise<any>>;
};

export type PackedUserOperation = NotPromise<PackedUserOperationStruct>;

export function tostr(s: BigNumberish): string {
  return BigNumber.from(s).toString();
}

export class RpcError extends Error {
  // error codes from: https://eips.ethereum.org/EIPS/eip-1474
  constructor(
    msg: string,
    readonly code?: number,
    readonly data: any = undefined,
  ) {
    super(msg);
  }
}

export function requireCond(
  cond: boolean,
  msg: string,
  code?: number,
  data: any = undefined,
): void {
  if (!cond) {
    throw new RpcError(msg, code, data);
  }
}

export interface SlotMap {
  [slot: string]: string;
}

/**
 * map of storage
 * for each address, either a root hash, or a map of slot:value
 */
export interface StorageMap {
  [address: string]: string | SlotMap;
}

export interface StakeInfo {
  addr: string;
  stake: BigNumberish;
  unstakeDelaySec: BigNumberish;
}

export enum ValidationErrors {
  InvalidFields = -32602,
  SimulateValidation = -32500,
  SimulatePaymasterValidation = -32501,
  OpcodeValidation = -32502,
  NotInTimeRange = -32503,
  Reputation = -32504,
  InsufficientStake = -32505,
  UnsupportedSignatureAggregator = -32506,
  InvalidSignature = -32507,
  UserOperationReverted = -32521,
}

export interface ReferencedCodeHashes {
  // addresses accessed during this user operation
  addresses: string[];

  // keccak over the code of all referenced addresses
  hash: string;
}

/**
 * merge all validationStorageMap objects into merged map
 * - entry with "root" (string) is always preferred over entry with slot-map
 * - merge slot entries
 * NOTE: slot values are supposed to be the value before the transaction started.
 *  so same address/slot in different validations should carry the same value
 * @param mergedStorageMap
 * @param validationStorageMap
 */
export function mergeStorageMap(
  mergedStorageMap: StorageMap,
  validationStorageMap: StorageMap,
): StorageMap {
  Object.entries(validationStorageMap).forEach(([addr, validationEntry]) => {
    if (typeof validationEntry === 'string') {
      // it's a root. override specific slots, if any
      mergedStorageMap[addr] = validationEntry;
    } else if (typeof mergedStorageMap[addr] === 'string') {
      // merged address already contains a root. ignore specific slot values
    } else {
      let slots: SlotMap;
      if (mergedStorageMap[addr] == null) {
        slots = mergedStorageMap[addr] = {};
      } else {
        slots = mergedStorageMap[addr] as SlotMap;
      }

      Object.entries(validationEntry).forEach(([slot, val]) => {
        slots[slot] = val;
      });
    }
  });
  return mergedStorageMap;
}

/**
 * run the constructor of the given type as a script: it is expected to revert with the script's return values.
 * @param provider provider to use fo rthe call
 * @param c - contract factory of the script class
 * @param ctrParams constructor parameters
 * @return an array of arguments of the error
 * example usasge:
 *     hashes = await runContractScript(provider, new GetUserOpHashes__factory(), [entryPoint.address, userOps]).then(ret => ret.userOpHashes)
 */
export async function runContractScript<T extends ContractFactory>(
  provider: Provider,
  c: T,
  ctrParams: Parameters<T['getDeployTransaction']>,
): Promise<Result> {
  const tx = c.getDeployTransaction(...ctrParams);
  const ret = await provider.call(tx);
  const parsed = ContractFactory.getInterface(c.interface).parseError(ret);
  if (parsed == null) throw new Error('unable to parse script (error) response: ' + ret);
  return parsed.args;
}

// extract address from initCode or paymasterAndData
export function getAddr(data?: BytesLike): string | undefined {
  if (data == null) {
    return undefined;
  }
  const str = hexlify(data);
  if (str.length >= 42) {
    return str.slice(0, 42);
  }
  return undefined;
}

export function requireAddressAndFields(
  userOp: UserOperation,
  addrField: string,
  mustFields: string[],
  optionalFields: string[] = [],
): void {
  const op = userOp as any;
  const addr = op[addrField];
  if (addr == null) {
    const unexpected = Object.entries(op).filter(
      ([name, value]) =>
        value != null && (mustFields.includes(name) || optionalFields.includes(name)),
    );
    requireCond(
      unexpected.length === 0,
      `no ${addrField} but got ${unexpected.join(',')}`,
      ValidationErrors.InvalidFields,
    );
  } else {
    requireCond(
      addr.match(/^0x[a-f0-9]{10,40}$/i),
      `invalid ${addrField}`,
      ValidationErrors.InvalidFields,
    );
    const missing = mustFields.filter((name) => op[name] == null);
    requireCond(
      missing.length === 0,
      `got ${addrField} but missing ${missing.join(',')}`,
      ValidationErrors.InvalidFields,
    );
  }
}

export function toBytes32(b: BytesLike | number): string {
  return hexZeroPad(hexlify(b).toLowerCase(), 32);
}

export function mapOf<T>(
  keys: Iterable<string>,
  mapper: (key: string) => T,
  filter?: (key: string) => boolean,
): {
  [key: string]: T;
} {
  const ret: { [key: string]: T } = {};
  for (const key of keys) {
    if (filter == null || filter(key)) {
      ret[key] = mapper(key);
    }
  }
  return ret;
}

export async function supportsRpcMethod(
  provider: JsonRpcProvider,
  method: string,
  params: any[],
): Promise<boolean> {
  const ret = await provider.send(method, params).catch((e) => e);
  const code = ret.error?.code ?? ret.code;
  return code === -32602; // wrong params (meaning, method exists)
}
