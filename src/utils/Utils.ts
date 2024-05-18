import { type UserOperationStruct } from '@account-abstraction/contracts';
import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { BigNumber, ContractFactory, type BytesLike } from 'ethers';
import { type BigNumberish } from 'ethers/lib/ethers';
import { hexZeroPad, hexlify, type Result } from 'ethers/lib/utils';
import { type NotPromise } from './ERC4337Utils';

export interface SlotMap {
  [slot: string]: string;
}

export interface StorageMap {
  [address: string]: string | SlotMap;
}

export interface StakeInfo {
  addr: string;
  stake: BigNumberish;
  unstakeDelaySec: BigNumberish;
}

export type UserOperation = NotPromise<UserOperationStruct>;

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
  addresses: string[];
  hash: string;
}

export class RpcError extends Error {
  constructor(
    msg: string,
    readonly code?: number,
    readonly data: any = undefined,
  ) {
    super(msg);
  }
}

export function tostr(s: BigNumberish): string {
  return BigNumber.from(s).toString();
}

export function requireCond(
  cond: boolean,
  msg: string,
  code?: number,
  data: any = undefined,
): void {
  if (!cond) throw new RpcError(msg, code, data);
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
    if (filter == null || filter(key)) ret[key] = mapper(key);
  }
  return ret;
}

export async function sleep(sleepTime: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, sleepTime));
}

export async function waitFor<T>(
  func: () => T | undefined,
  timeout = 10000,
  interval = 500,
): Promise<T> {
  const endTime = Date.now() + timeout;
  while (true) {
    const ret = await func();
    if (ret != null) return ret;
    if (Date.now() > endTime) {
      throw new Error(`Timed out waiting for ${func as unknown as string}`);
    }
    await sleep(interval);
  }
}

export async function supportsRpcMethod(
  provider: JsonRpcProvider,
  method: string,
  params: any[],
): Promise<boolean> {
  const ret = await provider.send(method, params).catch((e) => e);
  const code = ret.error?.code ?? ret.code;
  return code === -32602;
}

export function getAddr(data?: BytesLike): string | undefined {
  if (data == null) return undefined;
  const str = hexlify(data);
  if (str.length >= 42) return str.slice(0, 42);
  return undefined;
}

export function mergeStorageMap(
  mergedStorageMap: StorageMap,
  validationStorageMap: StorageMap,
): StorageMap {
  Object.entries(validationStorageMap).forEach(([addr, validationEntry]) => {
    if (typeof validationEntry === 'string') {
      mergedStorageMap[addr] = validationEntry;
    } else if (typeof mergedStorageMap[addr] === 'string') {
    } else {
      let slots: SlotMap;
      if (mergedStorageMap[addr] == null) slots = mergedStorageMap[addr] = {};
      else slots = mergedStorageMap[addr] as SlotMap;

      Object.entries(validationEntry).forEach(([slot, val]) => {
        slots[slot] = val;
      });
    }
  });
  return mergedStorageMap;
}

export function toBytes32(b: BytesLike | number): string {
  return hexZeroPad(hexlify(b).toLowerCase(), 32);
}

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
