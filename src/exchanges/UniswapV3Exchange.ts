import { ethers, BigNumber } from 'ethers';
import { BaseExchange } from './BaseExchange';
import { QuoteResult, TokenInfo } from '../types';

const UNISWAP_V3_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)'
];

const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
];

const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

export class UniswapV3Exchange extends BaseExchange {
  private quoterAddress: string;
  private quoterContract: ethers.Contract;
  private routerContract: ethers.Contract;
  private factoryContract: ethers.Contract;
  private fees: number[] = [500, 3000, 10000]; // 0.05%, 0.3%, 1%
  private poolCache: Map<string, string> = new Map(); // Cache pool addresses
  private lastCacheClear: number = Date.now();

  constructor(
    provider: ethers.providers.Provider,
    routerAddress: string,
    quoterAddress: string
  ) {
    super(provider, 'Uniswap V3', routerAddress);
    this.quoterAddress = quoterAddress;
    this.quoterContract = new ethers.Contract(quoterAddress, UNISWAP_V3_QUOTER_ABI, provider);
    this.routerContract = new ethers.Contract(routerAddress, UNISWAP_V3_ROUTER_ABI, provider);

    // Factory contract for checking pool existence
    const factoryAddress = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
    this.factoryContract = new ethers.Contract(factoryAddress, UNISWAP_V3_FACTORY_ABI, provider);
  }

  async getQuote(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    timeout: number = 5000
  ): Promise<QuoteResult> {
    let bestQuote: QuoteResult | null = null;

    // Validate inputs
    if (!tokenIn.address || !tokenOut.address || amountIn.lte(0)) {
      throw new Error('Invalid input parameters for quote');
    }

    // Check if tokens are the same
    if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
      throw new Error('Cannot quote for same token');
    }

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Uniswap V3 quote timeout after ${timeout}ms`)), timeout);
    });

    try {
      const quotePromise = this.getQuoteInternal(tokenIn, tokenOut, amountIn);
      bestQuote = await Promise.race([quotePromise, timeoutPromise]);
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        throw error;
      }
      throw new Error(`No valid Uniswap V3 quote found for ${tokenIn.symbol} -> ${tokenOut.symbol}. ${error.message || 'Unknown error'}`);
    }

    if (!bestQuote) {
      throw new Error(`No valid Uniswap V3 quote found for ${tokenIn.symbol} -> ${tokenOut.symbol}. Pools may not exist or have insufficient liquidity.`);
    }

    return bestQuote;
  }

  private async getQuoteInternal(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber
  ): Promise<QuoteResult | null> {
    let bestQuote: QuoteResult | null = null;

    // Sort fees by popularity to check most liquid pools first
    const sortedFees = [3000, 500, 10000];

    for (const fee of sortedFees) {
      try {
        // First check if the pool exists by calling the factory
        const poolAddress = await this.getPoolAddress(tokenIn.address, tokenOut.address, fee);
        if (poolAddress === ethers.constants.AddressZero) {
          continue;
        }

        // Use a timeout for the quote call itself
        const quoteCallPromise = this.quoterContract.callStatic.quoteExactInputSingle(
          tokenIn.address,
          tokenOut.address,
          fee,
          amountIn,
          0
        );

        const amountOut = await Promise.race([
          quoteCallPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Quote call timeout')), 3000)
          )
        ]);

        if (amountOut.gt(0)) {
          const gasEstimate = await this.estimateSwapGas(
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            fee
          );

          const quote: QuoteResult = {
            dex: this.name,
            amountIn,
            amountOut,
            gasEstimate,
            priceImpact: 0,
            route: [tokenIn.address, tokenOut.address]
          };

          if (!bestQuote || amountOut.gt(bestQuote.amountOut)) {
            bestQuote = quote;
          }
        }
      } catch (error: any) {
        // Only log if it's not a timeout error
        if (!error.message?.includes('timeout')) {
          console.warn(`Uniswap V3 quote failed for ${tokenIn.symbol}/${tokenOut.symbol} fee ${fee}: ${error.message || 'Unknown error'}`);
        }
        continue;
      }
    }

    return bestQuote;
  }

  async executeSwap(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    recipient: string,
    deadline: number
  ): Promise<ethers.ContractTransaction> {
    const bestFee = await this.findBestFee(tokenIn, tokenOut, amountIn);
    
    const params = {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      fee: bestFee,
      recipient,
      deadline,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0
    };

    return this.routerContract.exactInputSingle(params);
  }

  private async findBestFee(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber
  ): Promise<number> {
    let bestFee = this.fees[0];
    let bestAmountOut = BigNumber.from(0);

    for (const fee of this.fees) {
      try {
        // Check if pool exists first
        const poolAddress = await this.getPoolAddress(tokenIn.address, tokenOut.address, fee);
        if (poolAddress === ethers.constants.AddressZero) {
          continue;
        }

        const amountOut = await this.quoterContract.callStatic.quoteExactInputSingle(
          tokenIn.address,
          tokenOut.address,
          fee,
          amountIn,
          0
        );

        if (amountOut.gt(bestAmountOut)) {
          bestAmountOut = amountOut;
          bestFee = fee;
        }
      } catch (error) {
        // Fee tier might not exist for this pair or have insufficient liquidity
        console.warn(`Failed to get quote for fee ${fee}:`, error);
      }
    }

    return bestFee;
  }

  private async getPoolAddress(
    tokenA: string,
    tokenB: string,
    fee: number
  ): Promise<string> {
    // Clear cache every hour to ensure freshness
    if (Date.now() - this.lastCacheClear > 3600000) {
      this.poolCache.clear();
      this.lastCacheClear = Date.now();
    }

    // Create cache key
    const cacheKey = `${tokenA.toLowerCase()}-${tokenB.toLowerCase()}-${fee}`;

    // Check cache first
    if (this.poolCache.has(cacheKey)) {
      return this.poolCache.get(cacheKey)!;
    }

    try {
      // Add timeout to factory call
      const poolAddressPromise = this.factoryContract.getPool(tokenA, tokenB, fee);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Factory call timeout')), 2000);
      });

      const poolAddress = await Promise.race([poolAddressPromise, timeoutPromise]);

      // Cache the result
      this.poolCache.set(cacheKey, poolAddress);

      return poolAddress;
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        console.warn(`Factory call timeout for ${tokenA}/${tokenB} fee ${fee}`);
      } else {
        console.warn(`Failed to get pool address for ${tokenA}/${tokenB} fee ${fee}:`, error.message || error);
      }

      // Cache the failure too to avoid repeated calls
      this.poolCache.set(cacheKey, ethers.constants.AddressZero);

      return ethers.constants.AddressZero;
    }
  }

  private async estimateSwapGas(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    fee: number
  ): Promise<BigNumber> {
    try {
      const params = {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee,
        recipient: ethers.constants.AddressZero,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0
      };

      return await this.routerContract.estimateGas.exactInputSingle(params);
    } catch (error) {
      return BigNumber.from(300000); // Default gas estimate
    }
  }
}