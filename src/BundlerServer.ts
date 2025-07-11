import { EntryPoint__factory, type UserOperationStruct } from '@account-abstraction/contracts';
import { Provider } from '@ethersproject/providers';
import bodyParser from 'body-parser';
import cors from 'cors';
import Debug from 'debug';
import { Signer } from 'ethers';
import { parseEther } from 'ethers/lib/utils';
import express, { type Express, type Request, type Response } from 'express';
import { Server } from 'http';
import { type BundlerConfig } from './BundlerConfig';
import { DebugMethodHandler } from './DebugMethodHandler';
import { UserOpMethodHandler } from './UserOpMethodHandler';
import { AddressZero, RpcError, deepHexlify, erc4337RuntimeVersion } from './utils';

const debug = Debug('aa.rpc');
export class BundlerServer {
  app: Express;
  private readonly httpServer: Server;

  constructor(
    readonly methodHandler: UserOpMethodHandler,
    readonly debugHandler: DebugMethodHandler,
    readonly config: BundlerConfig,
    readonly provider: Provider,
    readonly wallet: Signer,
  ) {
    this.app = express();
    this.app.use(cors());
    this.app.use(bodyParser.json());

    this.app.get('/', this.intro.bind(this));
    this.app.post('/', this.intro.bind(this));
    this.app.post('/rpc', this.rpc.bind(this));

    this.httpServer = this.app.listen(this.config.port);
    this.startingPromise = this._preflightCheck();
  }
  startingPromise: Promise<void>;

  async asyncStart(): Promise<void> {
    await this.startingPromise;
  }

  async stop(): Promise<void> {
    this.httpServer.close();
  }

  async _preflightCheck(): Promise<void> {
    if ((await this.provider.getCode(this.config.entryPoint)) === '0x') {
      this.fatal(`entrypoint not deployed at ${this.config.entryPoint}`);
    }

    const emptyUserOp: UserOperationStruct = {
      sender: AddressZero,
      callData: '0x',
      initCode: AddressZero,
      paymasterAndData: '0x',
      nonce: 0,
      preVerificationGas: 0,
      verificationGasLimit: 100000,
      callGasLimit: 0,
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      signature: '0x',
    };
    // await EntryPoint__factory.connect(this.config.entryPoint,this.provider).callStatic.addStake(0)
    const err = await EntryPoint__factory.connect(this.config.entryPoint, this.provider)
      .callStatic.simulateValidation(emptyUserOp)
      .catch((e) => e);
    if (err?.errorName !== 'FailedOp') {
      this.fatal(`Invalid entryPoint contract at ${this.config.entryPoint}. wrong version?`);
    }
    const signerAddress = await this.wallet.getAddress();
    const bal = await this.provider.getBalance(signerAddress);
    if (bal.eq(0)) this.fatal('cannot run with zero balance');
    else if (bal.lt(parseEther(this.config.minBalance))) {
      console.log('WARNING: initial balance below --minBalance ', this.config.minBalance);
    } else console.log('INFORMATION: balance ', bal.toString());
  }

  fatal(msg: string): never {
    console.error('FATAL:', msg);
    process.exit(1);
  }

  intro(req: Request, res: Response): void {
    res.send(`Account-Abstraction Bundler v.${erc4337RuntimeVersion}. please use "/rpc"`);
  }

  async rpc(req: Request, res: Response): Promise<void> {
    let resContent: any;
    if (Array.isArray(req.body)) {
      resContent = [];
      for (const reqItem of req.body) {
        resContent.push(await this.handleRpc(reqItem));
      }
    } else resContent = await this.handleRpc(req.body);

    try {
      res.send(resContent);
    } catch (err: any) {
      const error = { message: err.message, data: err.data, code: err.code };
      console.log('failed: ', 'rpc::res.send()', 'error:', JSON.stringify(error));
    }
  }

  async handleRpc(reqItem: any): Promise<any> {
    const { method, params, jsonrpc, id } = reqItem;
    debug('>>', { jsonrpc, id, method, params });
    try {
      const result = deepHexlify(await this.handleMethod(method, params));
      console.log('sent', method, '-', result);
      debug('<<', { jsonrpc, id, result });
      return { jsonrpc, id, result };
    } catch (err: any) {
      const error = { message: err.message, data: err.data, code: err.code };
      console.log('failed: ', method, 'error:', JSON.stringify(error));
      debug('<<', { jsonrpc, id, error });
      return { jsonrpc, id, error };
    }
  }

  async handleMethod(method: string, params: any[]): Promise<any> {
    let result: any;
    switch (method) {
      case 'eth_chainId':
        const { chainId } = await this.provider.getNetwork();
        result = chainId;
        break;
      case 'eth_supportedEntryPoints':
        result = await this.methodHandler.getSupportedEntryPoints();
        break;
      case 'eth_sendUserOperation':
        result = await this.methodHandler.sendUserOperation(params[0], params[1]);
        break;
      case 'eth_estimateUserOperationGas':
        result = await this.methodHandler.estimateUserOperationGas(params[0], params[1]);
        break;
      case 'eth_getUserOperationReceipt':
        result = await this.methodHandler.getUserOperationReceipt(params[0]);
        break;
      case 'eth_getUserOperationByHash':
        result = await this.methodHandler.getUserOperationByHash(params[0]);
        break;
      case 'web3_clientVersion':
        result = this.methodHandler.clientVersion();
        break;
      case 'debug_bundler_clearState':
        this.debugHandler.clearState();
        result = 'ok';
        break;
      case 'debug_bundler_dumpMempool':
        result = await this.debugHandler.dumpMempool();
        break;
      case 'debug_bundler_clearMempool':
        this.debugHandler.clearMempool();
        result = 'ok';
        break;
      case 'debug_bundler_setReputation':
        this.debugHandler.setReputation(params[0]);
        result = 'ok';
        break;
      case 'debug_bundler_dumpReputation':
        result = this.debugHandler.dumpReputation();
        break;
      case 'debug_bundler_clearReputation':
        this.debugHandler.clearReputation();
        result = 'ok';
        break;
      case 'debug_bundler_setBundlingMode':
        this.debugHandler.setBundlingMode(params[0]);
        result = 'ok';
        break;
      case 'debug_bundler_setBundleInterval':
        this.debugHandler.setBundleInterval(params[0], params[1]);
        result = 'ok';
        break;
      case 'debug_bundler_sendBundleNow':
        result = await this.debugHandler.sendBundleNow();
        if (result == null) {
          result = 'ok';
        }
        break;
      case 'debug_bundler_getStakeStatus':
        result = await this.debugHandler.getStakeStatus(params[0], params[1]);
        break;
      default:
        throw new RpcError(`Method ${method} is not supported`, -32601);
    }
    return result;
  }
}
