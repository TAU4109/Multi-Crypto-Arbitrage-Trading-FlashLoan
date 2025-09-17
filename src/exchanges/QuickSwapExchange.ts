import { ethers, BigNumber } from 'ethers';
import { BaseExchange } from './BaseExchange';
import { QuoteResult, TokenInfo } from '../types';

const QUICKSWAP_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)'
];

const QUICKSWAP_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)'
];

const QUICKSWAP_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

export class QuickSwapExchange extends BaseExchange {
  private factoryAddress: string;
  private routerContract: ethers.Contract;
  private factoryContract: ethers.Contract;

  constructor(
    provider: ethers.providers.Provider,
    routerAddress: string,
    factoryAddress: string
  ) {
    super(provider, 'QuickSwap', routerAddress);
    this.factoryAddress = factoryAddress;
    this.routerContract = new ethers.Contract(routerAddress, QUICKSWAP_ROUTER_ABI, provider);
    this.factoryContract = new ethers.Contract(factoryAddress, QUICKSWAP_FACTORY_ABI, provider);
  }

  async getQuote(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber
  ): Promise<QuoteResult> {
    try {
      const path = [tokenIn.address, tokenOut.address];
      const amounts = await this.routerContract.getAmountsOut(amountIn, path);
      const amountOut = amounts[amounts.length - 1];

      if (amountOut.isZero()) {
        throw new Error('No liquidity available');
      }

      const priceImpact = await this.calculatePriceImpactForPair(
        tokenIn,
        tokenOut,
        amountIn,
        amountOut
      );

      const gasEstimate = await this.estimateSwapGas(
        tokenIn,
        tokenOut,
        amountIn,
        amountOut
      );

      return {
        dex: this.name,
        amountIn,
        amountOut,
        gasEstimate,
        priceImpact,
        route: path
      };
    } catch (error) {
      throw new Error(`QuickSwap quote failed: ${error}`);
    }
  }

  async executeSwap(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    recipient: string,
    deadline: number
  ): Promise<ethers.ContractTransaction> {
    const path = [tokenIn.address, tokenOut.address];
    
    return this.routerContract.swapExactTokensForTokens(
      amountIn,
      amountOutMin,
      path,
      recipient,
      deadline
    );
  }

  private async calculatePriceImpactForPair(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    amountOut: BigNumber
  ): Promise<number> {
    try {
      const pairAddress = await this.factoryContract.getPair(
        tokenIn.address,
        tokenOut.address
      );

      if (pairAddress === ethers.constants.AddressZero) {
        return 0;
      }

      const pairContract = new ethers.Contract(
        pairAddress,
        QUICKSWAP_PAIR_ABI,
        this.provider
      );

      const [reserve0, reserve1] = await pairContract.getReserves();
      const token0 = await pairContract.token0();
      
      let reserveIn: BigNumber;
      let reserveOut: BigNumber;
      
      if (token0.toLowerCase() === tokenIn.address.toLowerCase()) {
        reserveIn = reserve0;
        reserveOut = reserve1;
      } else {
        reserveIn = reserve1;
        reserveOut = reserve0;
      }

      return this.calculatePriceImpact(amountIn, amountOut, reserveIn, reserveOut);
    } catch (error) {
      console.warn('Price impact calculation failed:', error);
      return 0;
    }
  }

  private async estimateSwapGas(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    amountOutMin: BigNumber
  ): Promise<BigNumber> {
    try {
      const path = [tokenIn.address, tokenOut.address];
      const deadline = Math.floor(Date.now() / 1000) + 300;
      
      return await this.routerContract.estimateGas.swapExactTokensForTokens(
        amountIn,
        amountOutMin,
        path,
        ethers.constants.AddressZero,
        deadline
      );
    } catch (error) {
      return BigNumber.from(200000); // Default gas estimate
    }
  }
}