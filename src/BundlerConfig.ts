import ow from 'ow';

const MIN_UNSTAKE_DELAY = 86400;
const MIN_STAKE_VALUE = (1e18).toString();
export interface BundlerConfig {
  beneficiary: string;
  entryPoint: string;
  gasFactor: string;
  minBalance: string;
  mnemonic: string;
  network: string;
  port: string;
  unsafe: boolean;
  debugRpc?: boolean;
  conditionalRpc: boolean;

  whitelist?: string[];
  blacklist?: string[];
  maxBundleGas: number;
  minStake: string;
  minUnstakeDelay: number;
  autoBundleInterval: number;
  autoBundleMempoolSize: number;
}

export const BundlerConfigShape = {
  beneficiary: ow.string,
  entryPoint: ow.string,
  gasFactor: ow.string,
  minBalance: ow.string,
  mnemonic: ow.string,
  network: ow.string,
  port: ow.string,
  unsafe: ow.boolean,
  debugRpc: ow.optional.boolean,
  conditionalRpc: ow.boolean,

  whitelist: ow.optional.array.ofType(ow.string),
  blacklist: ow.optional.array.ofType(ow.string),
  maxBundleGas: ow.number,
  minStake: ow.string,
  minUnstakeDelay: ow.number,
  autoBundleInterval: ow.number,
  autoBundleMempoolSize: ow.number,
};

export const bundlerConfigDefault: Partial<BundlerConfig> = {
  port: '3000',
  // entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  entryPoint: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  unsafe: false,
  conditionalRpc: false,
  minStake: MIN_STAKE_VALUE,
  minUnstakeDelay: MIN_UNSTAKE_DELAY,
};
