import { EntryPoint__factory, type EntryPoint } from '@account-abstraction/contracts';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Command } from 'commander';
import { Signer, Wallet, ethers } from 'ethers';
import { parseEther } from 'ethers/lib/utils';
import fs from 'fs';
import { bundlerConfigDefault } from './BundlerConfig';
import { BundlerServer } from './BundlerServer';
import { resolveConfiguration } from './Config';
import { DebugMethodHandler } from './DebugMethodHandler';
import { UserOpMethodHandler } from './UserOpMethodHandler';
import { initServer } from './modules/initServer';
import { DeterministicDeployer } from './sdk';
import { RpcError, erc4337RuntimeVersion, supportsRpcMethod } from './utils';
import { supportsDebugTraceCall } from './validation-manager';

export const inspectCustomSymbol = Symbol.for('nodejs.util.inspect.custom');
// @ts-ignore
ethers.BigNumber.prototype[inspectCustomSymbol] = function () {
  return `BigNumber ${parseInt(this._hex)}`;
};

const CONFIG_FILE_NAME = 'localconfig/bunlder.config.json';

export let showStackTraces = false;

export async function connectContracts(
  wallet: Signer,
  entryPointAddress: string,
): Promise<{ entryPoint: EntryPoint }> {
  const entryPoint = EntryPoint__factory.connect(entryPointAddress, wallet);
  return {
    entryPoint,
  };
}

export async function runBundler(argv: string[], overrideExit = true): Promise<BundlerServer> {
  const program = new Command();

  if (overrideExit) {
    (program as any)._exit = (exitCode: any, code: any, message: any) => {
      class CommandError extends Error {
        constructor(
          message: string,
          readonly code: any,
          readonly exitCode: any,
        ) {
          super(message);
        }
      }

      throw new CommandError(message, code, exitCode);
    };
  }

  program
    .version(erc4337RuntimeVersion)
    .option('--beneficiary <string>', 'address to receive funds')
    .option('--gasFactor <number>')
    .option(
      '--minBalance <number>',
      'below this signer balance, keep fee for itself, ignoring "beneficiary" address ',
    )
    .option('--network <string>', 'network name or url')
    .option('--mnemonic <file>', 'mnemonic/private-key file of signer account')
    .option('--entryPoint <string>', 'address of the supported EntryPoint contract')
    .option('--port <number>', `server listening port (default: ${bundlerConfigDefault.port})`)
    .option('--config <string>', 'path to config file', CONFIG_FILE_NAME)
    .option('--auto', 'automatic bundling (bypass config.autoBundleMempoolSize)', false)
    .option('--unsafe', 'UNSAFE mode: no storage or opcode checks (safe mode requires geth)')
    .option('--debugRpc', 'enable debug rpc methods (auto-enabled for test node')
    .option('--conditionalRpc', 'Use eth_sendRawTransactionConditional RPC)')
    .option('--show-stack-traces', 'Show stack traces.')
    .option('--createMnemonic <file>', 'create the mnemonic file');

  const programOpts = program.parse(argv).opts();
  showStackTraces = programOpts.showStackTraces;

  console.log('command-line arguments: ', program.opts());

  if (programOpts.createMnemonic != null) {
    const mnemonicFile: string = programOpts.createMnemonic;
    console.log('Creating mnemonic in file', mnemonicFile);
    if (fs.existsSync(mnemonicFile)) {
      throw new Error(`Can't --createMnemonic: out file ${mnemonicFile} already exists`);
    }
    const newMnemonic = Wallet.createRandom().mnemonic.phrase;
    fs.writeFileSync(mnemonicFile, newMnemonic);
    process.exit(1);
  }
  const { config, provider, wallet } = await resolveConfiguration(programOpts);
  const { chainId } = await provider.getNetwork();

  if (chainId === 31337 || chainId === 1337) {
    if (config.debugRpc == null) config.debugRpc = true;
    await new DeterministicDeployer(provider as any).deterministicDeploy(
      EntryPoint__factory.bytecode,
    );
    if ((await wallet.getBalance()).eq(0)) {
      console.log('=== testnet: fund signer');
      const signer = (provider as JsonRpcProvider).getSigner();
      await signer.sendTransaction({ to: await wallet.getAddress(), value: parseEther('1') });
    }
  }

  if (
    config.conditionalRpc &&
    !(await supportsRpcMethod(provider as any, 'eth_sendRawTransactionConditional', [{}, {}]))
  ) {
    console.error(
      'FATAL: --conditionalRpc requires a node that support eth_sendRawTransactionConditional',
    );
    process.exit(1);
  }
  if (!config.unsafe && !(await supportsDebugTraceCall(provider as any))) {
    console.error(
      'FATAL: full validation requires a node with debug_traceCall. for local UNSAFE mode: use --unsafe',
    );
    process.exit(1);
  }

  const { entryPoint } = await connectContracts(wallet, config.entryPoint);

  const execManagerConfig = { ...config };
  if (programOpts.auto === true) {
    execManagerConfig.autoBundleMempoolSize = 0;
    execManagerConfig.autoBundleInterval = 0;
  }

  const [execManager, eventsManager, reputationManager, mempoolManager] = initServer(
    execManagerConfig,
    entryPoint.signer,
  );
  const methodHandler = new UserOpMethodHandler(execManager, provider, wallet, config, entryPoint);
  eventsManager.initEventListener();
  const debugHandler =
    config.debugRpc ?? false
      ? new DebugMethodHandler(execManager, eventsManager, reputationManager, mempoolManager)
      : (new Proxy(
          {},
          {
            get(target: {}, method: string, receiver: any): any {
              throw new RpcError(`method debug_bundler_${method} is not supported`, -32601);
            },
          },
        ) as DebugMethodHandler);

  const bundlerServer = new BundlerServer(methodHandler, debugHandler, config, provider, wallet);

  void bundlerServer.asyncStart().then(async () => {
    console.log('Bundle interval (seconds)', execManagerConfig.autoBundleInterval);
    console.log(
      'connected to network',
      await provider.getNetwork().then((net) => {
        return { name: net.name, chainId: net.chainId };
      }),
    );
    console.log(`running on http://localhost:${config.port}/rpc`);
  });

  return bundlerServer;
}
