import { type TransactionReceipt } from '@ethersproject/providers';
import { type BigNumberish } from 'ethers';
import { type UserOperation } from './utils';

export interface EstimateUserOpGasResult {
  preVerificationGas: BigNumberish;
  verificationGasLimit: BigNumberish;
  deadline?: BigNumberish;
  callGasLimit: BigNumberish;
}

export interface UserOperationByHashResponse {
  userOperation: UserOperation;
  entryPoint: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
}

export interface UserOperationReceipt {
  userOpHash: string;
  sender: string;
  nonce: BigNumberish;
  paymaster?: string;
  actualGasCost: BigNumberish;
  actualGasUsed: BigNumberish;
  success: boolean;
  reason?: string;
  logs: any[];
  receipt: TransactionReceipt;
}
