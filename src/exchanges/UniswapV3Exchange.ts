import { ethers, BigNumber } from 'ethers';
import { BaseExchange } from './BaseExchange';
import { QuoteResult, TokenInfo } from '../types';

const UNISWAP_V3_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)'
];

const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
];

export class UniswapV3Exchange extends BaseExchange {
  private quoterAddress: string;
  private quoterContract: ethers.Contract;
  private routerContract: ethers.Contract;
  private fees: number[] = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

  constructor(
    provider: ethers.providers.Provider,
    routerAddress: string,
    quoterAddress: string
  ) {
    super(provider, 'Uniswap V3', routerAddress);
    this.quoterAddress = quoterAddress;
    this.quoterContract = new ethers.Contract(quoterAddress, UNISWAP_V3_QUOTER_ABI, provider);
    this.routerContract = new ethers.Contract(routerAddress, UNISWAP_V3_ROUTER_ABI, provider);
  }

  async getQuote(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber
  ): Promise<QuoteResult> {
    let bestQuote: QuoteResult | null = null;
    
    for (const fee of this.fees) {
      try {
        const amountOut = await this.quoterContract.callStatic.quoteExactInputSingle(
          tokenIn.address,
          tokenOut.address,
          fee,
          amountIn,
          0
        );

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
            priceImpact: 0, // Uniswap V3 doesn't provide direct price impact
            route: [tokenIn.address, tokenOut.address]
          };

          if (!bestQuote || amountOut.gt(bestQuote.amountOut)) {
            bestQuote = quote;
          }
        }
      } catch (error) {
        console.warn(`Uniswap V3 quote failed for fee ${fee}:`, error);
      }
    }

    if (!bestQuote) {
      throw new Error(`No valid Uniswap V3 quote found for ${tokenIn.symbol} -> ${tokenOut.symbol}`);
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
        // Fee tier might not exist for this pair
      }
    }

    return bestFee;
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