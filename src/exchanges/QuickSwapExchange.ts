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
    amountIn: BigNumber,
    timeout: number = 5000
  ): Promise<QuoteResult> {
    // Validate inputs
    if (!tokenIn.address || !tokenOut.address || amountIn.lte(0)) {
      throw new Error('Invalid input parameters for quote');
    }

    if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
      throw new Error('Cannot quote for same token');
    }

    try {
      // First check if pair exists
      const pairAddress = await Promise.race([
        this.factoryContract.getPair(tokenIn.address, tokenOut.address),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Factory call timeout')), 2000)
        )
      ]);

      if (pairAddress === ethers.constants.AddressZero) {
        throw new Error(`No QuickSwap pair found for ${tokenIn.symbol}/${tokenOut.symbol}`);
      }

      const path = [tokenIn.address, tokenOut.address];

      // Add timeout to the quote call
      const amountsPromise = this.routerContract.getAmountsOut(amountIn, path);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`QuickSwap quote timeout after ${timeout}ms`)), timeout);
      });

      const amounts = await Promise.race([amountsPromise, timeoutPromise]);
      const amountOut = amounts[amounts.length - 1];

      if (amountOut.isZero() || amountOut.lt(amountIn.div(1000))) {
        throw new Error('Insufficient liquidity or suspicious quote');
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
    } catch (error: any) {
      throw new Error(`QuickSwap quote failed for ${tokenIn.symbol} -> ${tokenOut.symbol}: ${error.message || error}`);
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
      const pairAddress = await Promise.race([
        this.factoryContract.getPair(tokenIn.address, tokenOut.address),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Factory timeout')), 2000)
        )
      ]);

      if (pairAddress === ethers.constants.AddressZero) {
        return 0;
      }

      const pairContract = new ethers.Contract(
        pairAddress,
        QUICKSWAP_PAIR_ABI,
        this.provider
      );

      const [reservesPromise, token0Promise] = await Promise.all([
        Promise.race([
          pairContract.getReserves(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Reserves timeout')), 2000)
          )
        ]),
        Promise.race([
          pairContract.token0(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Token0 timeout')), 2000)
          )
        ])
      ]);

      const [reserve0, reserve1] = reservesPromise;
      const token0 = token0Promise;

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
    } catch (error: any) {
      if (!error.message?.includes('timeout')) {
        console.warn('Price impact calculation failed:', error.message || error);
      }
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