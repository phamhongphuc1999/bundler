import { type TransactionRequest } from '@ethersproject/abstract-provider';
import { Signer } from '@ethersproject/abstract-signer';
import { JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers';
import { BigNumber, ContractFactory, type BigNumberish } from 'ethers';
import { hexConcat, hexZeroPad, hexlify, keccak256 } from 'ethers/lib/utils';

export class DeterministicDeployer {
  static getAddress(ctrCode: string, salt: BigNumberish): string;
  static getAddress(ctrCode: string): string;
  static getAddress(ctrCode: ContractFactory, salt: BigNumberish, params: any[]): string;
  static getAddress(
    ctrCode: string | ContractFactory,
    salt: BigNumberish = 0,
    params: any[] = [],
  ): string {
    return DeterministicDeployer.getDeterministicDeployAddress(ctrCode, salt, params);
  }

  static async deploy(ctrCode: string, salt: BigNumberish): Promise<string>;
  static async deploy(ctrCode: string): Promise<string>;
  static async deploy(ctrCode: ContractFactory, salt: BigNumberish, params: any[]): Promise<string>;
  static async deploy(
    ctrCode: string | ContractFactory,
    salt: BigNumberish = 0,
    params: any[] = [],
  ): Promise<string> {
    return await DeterministicDeployer.instance.deterministicDeploy(ctrCode, salt, params);
  }

  static proxyAddress = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
  static deploymentTransaction =
    '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222';
  static deploymentSignerAddress = '0x3fab184622dc19b6109349b94811493bf2a45362';
  static deploymentGasPrice = 100e9;
  static deploymentGasLimit = 100000;

  constructor(
    readonly provider: JsonRpcProvider,
    readonly signer?: Signer,
  ) {}

  async isContractDeployed(address: string): Promise<boolean> {
    return await this.provider.getCode(address).then((code) => code.length > 2);
  }

  async isDeployerDeployed(): Promise<boolean> {
    return await this.isContractDeployed(DeterministicDeployer.proxyAddress);
  }

  async deployFactory(): Promise<void> {
    if (await this.isContractDeployed(DeterministicDeployer.proxyAddress)) {
      return;
    }
    const bal = await this.provider.getBalance(DeterministicDeployer.deploymentSignerAddress);
    const neededBalance = BigNumber.from(DeterministicDeployer.deploymentGasLimit).mul(
      DeterministicDeployer.deploymentGasPrice,
    );
    if (bal.lt(neededBalance)) {
      const signer = this.signer ?? this.provider.getSigner();
      await signer.sendTransaction({
        to: DeterministicDeployer.deploymentSignerAddress,
        value: neededBalance,
        gasLimit: DeterministicDeployer.deploymentGasLimit,
      });
    }
    await this.provider.send('eth_sendRawTransaction', [
      DeterministicDeployer.deploymentTransaction,
    ]);
    if (!(await this.isContractDeployed(DeterministicDeployer.proxyAddress))) {
      throw new Error("raw TX didn't deploy deployer!");
    }
  }

  async getDeployTransaction(
    ctrCode: string | ContractFactory,
    salt: BigNumberish = 0,
    params: any[] = [],
  ): Promise<TransactionRequest> {
    await this.deployFactory();
    const saltEncoded = hexZeroPad(hexlify(salt), 32);
    const ctrEncoded = DeterministicDeployer.getCtrCode(ctrCode, params);
    return {
      to: DeterministicDeployer.proxyAddress,
      data: hexConcat([saltEncoded, ctrEncoded]),
    };
  }

  static getCtrCode(ctrCode: string | ContractFactory, params: any[]): string {
    if (typeof ctrCode !== 'string') {
      return hexlify(ctrCode.getDeployTransaction(...params).data!);
    } else {
      if (params.length !== 0) {
        throw new Error('constructor params can only be passed to ContractFactory');
      }
      return ctrCode;
    }
  }

  static getDeterministicDeployAddress(
    ctrCode: string | ContractFactory,
    salt: BigNumberish = 0,
    params: any[] = [],
  ): string {
    const saltEncoded = hexZeroPad(hexlify(salt), 32);
    const ctrCode1 = DeterministicDeployer.getCtrCode(ctrCode, params);
    return (
      '0x' +
      keccak256(
        hexConcat(['0xff', DeterministicDeployer.proxyAddress, saltEncoded, keccak256(ctrCode1)]),
      ).slice(-40)
    );
  }

  async deterministicDeploy(
    ctrCode: string | ContractFactory,
    salt: BigNumberish = 0,
    params: any[] = [],
  ): Promise<string> {
    const addr = DeterministicDeployer.getDeterministicDeployAddress(ctrCode, salt, params);
    if (!(await this.isContractDeployed(addr))) {
      const signer = this.signer ?? this.provider.getSigner();
      await signer.sendTransaction(await this.getDeployTransaction(ctrCode, salt, params));
    }
    return addr;
  }

  private static _instance?: DeterministicDeployer;

  static init(provider: JsonRpcProvider, signer?: JsonRpcSigner): void {
    this._instance = new DeterministicDeployer(provider, signer);
  }

  static get instance(): DeterministicDeployer {
    if (this._instance == null) {
      throw new Error('must call "DeterministicDeployer.init(ethers.provider)" first');
    }
    return this._instance;
  }
}
