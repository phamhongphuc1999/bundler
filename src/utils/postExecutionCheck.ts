import { type EntryPoint, type UserOperationStruct } from '@account-abstraction/contracts';
import Debug from 'debug';
import { resolveProperties } from 'ethers/lib/utils';
import { type NotPromise } from './ERC4337Utils';

const debug = Debug('aa.postExec');

export async function postExecutionDump(entryPoint: EntryPoint, userOpHash: string): Promise<void> {
  const { gasPaid, gasUsed, success, userOp } = await postExecutionCheck(entryPoint, userOpHash);
  debug(
    '==== used=',
    gasUsed,
    'paid',
    gasPaid,
    'over=',
    gasPaid - gasUsed,
    'callLen=',
    userOp?.callData?.length,
    'initLen=',
    userOp?.initCode?.length,
    success ? 'success' : 'failed',
  );
}

export async function postExecutionCheck(
  entryPoint: EntryPoint,
  userOpHash: string,
): Promise<{
  gasUsed: number;
  gasPaid: number;
  success: boolean;
  userOp: NotPromise<UserOperationStruct>;
}> {
  const req = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(userOpHash));
  if (req.length === 0) {
    debug('postExecutionCheck: failed to read event (not mined)');
    // @ts-ignore
    return { gasUsed: 0, gasPaid: 0, success: false, userOp: {} };
  }
  const transactionReceipt = await req[0].getTransactionReceipt();

  const tx = await req[0].getTransaction();
  const { ops } = entryPoint.interface.decodeFunctionData('handleOps', tx.data);
  const userOp = await resolveProperties(ops[0] as UserOperationStruct);
  const { actualGasUsed, success } = req[0].args;
  const gasPaid = actualGasUsed.toNumber();
  const gasUsed = transactionReceipt.gasUsed.toNumber();
  return { gasUsed, gasPaid, success, userOp };
}
