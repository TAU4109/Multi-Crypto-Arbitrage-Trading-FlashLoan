import { ethers, BigNumber } from 'ethers';
import { QuoteResult, TokenInfo, EXCHANGES } from '../types';
import { UniswapV3Exchange } from '../exchanges/UniswapV3Exchange';
import { QuickSwapExchange } from '../exchanges/QuickSwapExchange';
import { BaseExchange } from '../exchanges/BaseExchange';

interface MultiCallResult {
  success: boolean;
  returnData: string;
}

const MULTICALL_ABI = [
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) public view returns (tuple(bool success, bytes returnData)[] returnData)'
];

export class BatchQuoteEngine {
  private provider: ethers.providers.Provider;
  private exchanges: Map<string, BaseExchange>;
  private multicallAddress: string = '0x1F98415757620B543A52E61c46B32eB19261F984';
  private multicallContract: ethers.Contract;

  constructor(provider: ethers.providers.Provider) {
    this.provider = provider;
    this.exchanges = new Map();
    this.multicallContract = new ethers.Contract(
      this.multicallAddress,
      MULTICALL_ABI,
      provider
    );
    this.initializeExchanges();
  }

  private initializeExchanges(): void {
    this.exchanges.set(
      'UNISWAP_V3',
      new UniswapV3Exchange(
        this.provider,
        EXCHANGES.UNISWAP_V3.router,
        EXCHANGES.UNISWAP_V3.quoter!
      )
    );

    this.exchanges.set(
      'QUICKSWAP',
      new QuickSwapExchange(
        this.provider,
        EXCHANGES.QUICKSWAP.router,
        EXCHANGES.QUICKSWAP.factory!
      )
    );
  }

  async getBatchQuotes(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber
  ): Promise<QuoteResult[]> {
    const promises = Array.from(this.exchanges.entries())
      .filter(([_, exchange]) => EXCHANGES[exchange.getName().replace(' ', '_').toUpperCase()]?.enabled)
      .map(async ([name, exchange]) => {
        try {
          const quote = await exchange.getQuote(tokenIn, tokenOut, amountIn);
          return { ...quote, dex: name };
        } catch (error) {
          console.warn(`Quote failed for ${name}:`, error);
          return null;
        }
      });

    const results = await Promise.allSettled(promises);
    
    return results
      .filter((result): result is PromiseFulfilledResult<QuoteResult | null> => 
        result.status === 'fulfilled' && result.value !== null
      )
      .map(result => result.value!)
      .sort((a, b) => b.amountOut.sub(a.amountOut).gt(0) ? 1 : -1);
  }

  async getMulticallQuotes(
    tokenPairs: Array<{ tokenIn: TokenInfo; tokenOut: TokenInfo; amountIn: BigNumber }>
  ): Promise<Map<string, QuoteResult[]>> {
    const calls: Array<{ target: string; callData: string }> = [];
    const callMappings: Array<{ 
      pairKey: string; 
      exchangeName: string; 
      tokenIn: TokenInfo; 
      tokenOut: TokenInfo; 
      amountIn: BigNumber 
    }> = [];

    // Prepare multicall data for all pairs and exchanges
    for (const pair of tokenPairs) {
      const pairKey = `${pair.tokenIn.symbol}-${pair.tokenOut.symbol}`;
      
      // Uniswap V3 calls
      const uniswapQuoter = EXCHANGES.UNISWAP_V3.quoter!;
      const fees = [500, 3000, 10000];
      
      for (const fee of fees) {
        const callData = this.encodeUniswapQuoteCall(
          pair.tokenIn.address,
          pair.tokenOut.address,
          fee,
          pair.amountIn
        );
        
        calls.push({
          target: uniswapQuoter,
          callData
        });

        callMappings.push({
          pairKey,
          exchangeName: 'UNISWAP_V3',
          tokenIn: pair.tokenIn,
          tokenOut: pair.tokenOut,
          amountIn: pair.amountIn
        });
      }

      // QuickSwap calls
      const quickswapRouter = EXCHANGES.QUICKSWAP.router;
      const path = [pair.tokenIn.address, pair.tokenOut.address];
      const callData = this.encodeQuickSwapQuoteCall(pair.amountIn, path);
      
      calls.push({
        target: quickswapRouter,
        callData
      });

      callMappings.push({
        pairKey,
        exchangeName: 'QUICKSWAP',
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        amountIn: pair.amountIn
      });
    }

    try {
      const results: MultiCallResult[] = await this.multicallContract.callStatic.tryAggregate(
        false,
        calls
      );

      return this.parseMulticallResults(results, callMappings);
    } catch (error) {
      console.error('Multicall failed:', error);
      throw error;
    }
  }

  private encodeUniswapQuoteCall(
    tokenIn: string,
    tokenOut: string,
    fee: number,
    amountIn: BigNumber
  ): string {
    const iface = new ethers.utils.Interface([
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)'
    ]);

    return iface.encodeFunctionData('quoteExactInputSingle', [
      tokenIn,
      tokenOut,
      fee,
      amountIn,
      0
    ]);
  }

  private encodeQuickSwapQuoteCall(
    amountIn: BigNumber,
    path: string[]
  ): string {
    const iface = new ethers.utils.Interface([
      'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'
    ]);

    return iface.encodeFunctionData('getAmountsOut', [amountIn, path]);
  }

  private parseMulticallResults(
    results: MultiCallResult[],
    callMappings: Array<{ 
      pairKey: string; 
      exchangeName: string; 
      tokenIn: TokenInfo; 
      tokenOut: TokenInfo; 
      amountIn: BigNumber 
    }>
  ): Map<string, QuoteResult[]> {
    const quotesMap = new Map<string, QuoteResult[]>();

    results.forEach((result, index) => {
      if (!result.success || !callMappings[index]) {
        return;
      }

      const mapping = callMappings[index];
      const { pairKey, exchangeName, tokenIn, tokenOut, amountIn } = mapping;

      try {
        let amountOut: BigNumber;

        if (exchangeName === 'UNISWAP_V3') {
          const decoded = ethers.utils.defaultAbiCoder.decode(['uint256'], result.returnData);
          amountOut = decoded[0];
        } else if (exchangeName === 'QUICKSWAP') {
          const decoded = ethers.utils.defaultAbiCoder.decode(['uint256[]'], result.returnData);
          const amounts = decoded[0];
          amountOut = amounts[amounts.length - 1];
        } else {
          return;
        }

        if (amountOut.gt(0)) {
          const quote: QuoteResult = {
            dex: exchangeName,
            amountIn,
            amountOut,
            gasEstimate: BigNumber.from(200000), // Default estimate
            priceImpact: 0,
            route: [tokenIn.address, tokenOut.address]
          };

          if (!quotesMap.has(pairKey)) {
            quotesMap.set(pairKey, []);
          }

          quotesMap.get(pairKey)!.push(quote);
        }
      } catch (error) {
        console.warn(`Failed to parse result for ${pairKey} on ${exchangeName}:`, error);
      }
    });

    // Sort quotes by best price for each pair
    quotesMap.forEach((quotes, pairKey) => {
      quotes.sort((a, b) => b.amountOut.sub(a.amountOut).gt(0) ? 1 : -1);
      quotesMap.set(pairKey, quotes);
    });

    return quotesMap;
  }

  async getOptimalRoute(
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    amountIn: BigNumber,
    maxHops: number = 2
  ): Promise<QuoteResult | null> {
    // Direct route
    const directQuotes = await this.getBatchQuotes(tokenIn, tokenOut, amountIn);
    let bestQuote = directQuotes.length > 0 ? directQuotes[0] : null;

    if (maxHops > 1) {
      // Try indirect routes through common tokens
      const intermediateTokens = [
        EXCHANGES.UNISWAP_V3.router, // WETH often used as intermediate
        '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'  // USDC
      ];

      for (const intermediateAddress of intermediateTokens) {
        if (intermediateAddress === tokenIn.address || intermediateAddress === tokenOut.address) {
          continue;
        }

        try {
          // This is a simplified indirect routing - in production you'd want more sophisticated routing
          const firstHopQuotes = await this.getBatchQuotes(
            tokenIn,
            { address: intermediateAddress, symbol: 'INTERMEDIATE', decimals: 18, name: 'Intermediate' },
            amountIn
          );

          if (firstHopQuotes.length > 0) {
            const secondHopQuotes = await this.getBatchQuotes(
              { address: intermediateAddress, symbol: 'INTERMEDIATE', decimals: 18, name: 'Intermediate' },
              tokenOut,
              firstHopQuotes[0].amountOut
            );

            if (secondHopQuotes.length > 0) {
              const combinedGas = firstHopQuotes[0].gasEstimate.add(secondHopQuotes[0].gasEstimate);
              const finalAmountOut = secondHopQuotes[0].amountOut;

              if (!bestQuote || finalAmountOut.gt(bestQuote.amountOut)) {
                bestQuote = {
                  dex: `${firstHopQuotes[0].dex}->${secondHopQuotes[0].dex}`,
                  amountIn,
                  amountOut: finalAmountOut,
                  gasEstimate: combinedGas,
                  priceImpact: firstHopQuotes[0].priceImpact + secondHopQuotes[0].priceImpact,
                  route: [tokenIn.address, intermediateAddress, tokenOut.address]
                };
              }
            }
          }
        } catch (error) {
          console.warn(`Indirect routing failed through ${intermediateAddress}:`, error);
        }
      }
    }

    return bestQuote;
  }

  getExchange(name: string): BaseExchange | undefined {
    return this.exchanges.get(name);
  }

  getAllExchanges(): BaseExchange[] {
    return Array.from(this.exchanges.values());
  }
}