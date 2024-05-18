import { type UserOperationStruct } from '@account-abstraction/contracts';
import { arrayify, hexlify } from 'ethers/lib/utils';
import { packUserOp, type NotPromise } from '../utils';

export interface GasOverheads {
  fixed: number;
  perUserOp: number;
  perUserOpWord: number;
  zeroByte: number;
  nonZeroByte: number;
  bundleSize: number;
  sigSize: number;
}

export const DefaultGasOverheads: GasOverheads = {
  fixed: 21000,
  perUserOp: 18300,
  perUserOpWord: 4,
  zeroByte: 4,
  nonZeroByte: 16,
  bundleSize: 1,
  sigSize: 65,
};

export function calcPreVerificationGas(
  userOp: Partial<NotPromise<UserOperationStruct>>,
  overheads?: Partial<GasOverheads>,
): number {
  const ov = { ...DefaultGasOverheads, ...(overheads ?? {}) };
  const p: NotPromise<UserOperationStruct> = {
    signature: hexlify(Buffer.alloc(ov.sigSize, 1)),
    ...userOp,
    preVerificationGas: 21000,
  } as any;
  const packed = arrayify(packUserOp(p, false));
  const lengthInWord = (packed.length + 31) / 32;
  const callDataCost = packed
    .map((x) => (x === 0 ? ov.zeroByte : ov.nonZeroByte))
    .reduce((sum, x) => sum + x);
  const ret = Math.round(
    callDataCost + ov.fixed / ov.bundleSize + ov.perUserOp + ov.perUserOpWord * lengthInWord,
  );
  return ret;
}
