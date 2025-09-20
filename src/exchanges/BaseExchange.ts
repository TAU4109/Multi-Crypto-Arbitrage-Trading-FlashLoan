import { ethers, BigNumber } from 'ethers';
import { QuoteResult, TokenInfo } from '../types';

export abstract class BaseExchange {
  protected provider: ethers.providers.Provider;
  protected name: string;
  protected routerAddress: string;

  constructor(
    provider: ethers.providers.Provider,
    name: string,
    routerAddress: string
  ) {
    this.provider = provider;
    this.name = name;
    this.routerAddress = routerAddress;
  }

  abstract getQuote(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    timeout?: number
  ): Promise<QuoteResult>;

  abstract executeSwap(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    recipient: string,
    deadline: number
  ): Promise<ethers.ContractTransaction>;

  getName(): string {
    return this.name;
  }

  getRouterAddress(): string {
    return this.routerAddress;
  }

  protected calculatePriceImpact(
    amountIn: BigNumber,
    amountOut: BigNumber,
    reserveIn: BigNumber,
    reserveOut: BigNumber
  ): number {
    if (reserveIn.isZero() || reserveOut.isZero()) {
      return 0;
    }

    const expectedPrice = reserveOut.mul(amountIn).div(reserveIn);
    const actualPrice = amountOut;
    
    if (expectedPrice.isZero()) {
      return 0;
    }

    const impact = expectedPrice.sub(actualPrice).mul(10000).div(expectedPrice);
    return impact.toNumber() / 100;
  }

  protected async estimateGas(
    contract: ethers.Contract,
    methodName: string,
    params: any[]
  ): Promise<BigNumber> {
    try {
      return await contract.estimateGas[methodName](...params);
    } catch (error) {
      return BigNumber.from(200000);
    }
  }
}