import { ethers, BigNumber } from 'ethers';
import { BatchQuoteEngine } from './BatchQuoteEngine';
import { GasManager, GasCostAnalysis } from './GasManager';
import { ArbitrageOpportunity, QuoteResult, TokenInfo, TradeResult, TOKENS } from '../types';
import { EventEmitter } from 'events';

export interface ArbitrageConfig {
  minProfitThreshold: number; // Minimum profit in USD
  maxSlippagePercent: number; // Maximum acceptable slippage
  maxTradeAmountUSD: number; // Maximum trade size
  gasLimitGwei: number; // Maximum gas price in Gwei
  profitBufferPercent: number; // Safety buffer for profit calculations
  updateIntervalMs: number; // How often to scan for opportunities
}

export class ArbitrageEngine extends EventEmitter {
  private provider: ethers.providers.Provider;
  private batchQuoteEngine: BatchQuoteEngine;
  private gasManager: GasManager;
  private config: ArbitrageConfig;
  private isRunning: boolean = false;
  private scanInterval?: NodeJS.Timeout;
  private lastScanTimestamp: number = 0;
  private opportunityHistory: Map<string, ArbitrageOpportunity[]> = new Map();
  private consecutiveEmptyScans: number = 0;
  private dynamicScanInterval: number;

  constructor(
    provider: ethers.providers.Provider,
    config: ArbitrageConfig
  ) {
    super();
    this.provider = provider;
    this.batchQuoteEngine = new BatchQuoteEngine(provider);
    this.gasManager = new GasManager(provider);
    this.config = config;
    this.dynamicScanInterval = config.updateIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('Arbitrage engine is already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting arbitrage opportunity scanner...');

    // Initial scan
    await this.scanForOpportunities();

    // Set up periodic scanning
    this.scanInterval = setInterval(async () => {
      try {
        await this.scanForOpportunities();
      } catch (error) {
        console.error('Error during opportunity scan:', error);
        this.emit('error', error);
      }
    }, this.config.updateIntervalMs);

    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }

    console.log('Arbitrage engine stopped');
    this.emit('stopped');
  }

  private async scanForOpportunities(): Promise<void> {
    const startTime = Date.now();
    this.lastScanTimestamp = startTime;

    try {
      console.log(`Starting arbitrage scan at ${new Date().toISOString()}`);

      // Check if gas price is acceptable with timeout
      const gasCheckPromise = this.gasManager.isGasPriceAcceptable(
        this.config.gasLimitGwei,
        'medium'
      );

      const gasAcceptable = await Promise.race([
        gasCheckPromise,
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            console.warn('Gas price check timeout, proceeding with scan');
            resolve(true);
          }, 5000);
        })
      ]);

      if (!gasAcceptable) {
        console.log('Gas price too high, skipping scan');
        this.consecutiveEmptyScans++;
        return;
      }

      // Add timeout to the entire opportunity finding process
      const opportunitiesPromise = this.findArbitrageOpportunities();
      const scanTimeout = new Promise<ArbitrageOpportunity[]>((resolve) => {
        setTimeout(() => {
          console.warn('Opportunity scan timeout, returning empty results');
          resolve([]);
        }, 30000); // 30 second timeout
      });

      const opportunities = await Promise.race([opportunitiesPromise, scanTimeout]);

      // Filter and rank opportunities
      const viableOpportunities = opportunities
        .filter(op => {
          try {
            return this.isOpportunityViable(op);
          } catch (error) {
            console.warn('Error checking opportunity viability:', error);
            return false;
          }
        })
        .sort((a, b) => {
          try {
            return b.netProfit.sub(a.netProfit).gt(0) ? 1 : -1;
          } catch (error) {
            return 0;
          }
        })
        .slice(0, 5); // Top 5 opportunities

      if (viableOpportunities.length > 0) {
        console.log(`Found ${viableOpportunities.length} viable opportunities`);
        this.consecutiveEmptyScans = 0;
        this.emit('opportunities', viableOpportunities);

        // Store in history for analysis
        try {
          const pairKey = `${viableOpportunities[0].tokenA.symbol}-${viableOpportunities[0].tokenB.symbol}`;
          if (!this.opportunityHistory.has(pairKey)) {
            this.opportunityHistory.set(pairKey, []);
          }
          this.opportunityHistory.get(pairKey)!.push(...viableOpportunities);

          // Keep only last 100 opportunities per pair
          if (this.opportunityHistory.get(pairKey)!.length > 100) {
            this.opportunityHistory.get(pairKey)!.splice(0, 50);
          }
        } catch (historyError) {
          console.warn('Error storing opportunity history:', historyError);
        }
      } else {
        this.consecutiveEmptyScans++;
        console.log(`No viable opportunities found (${this.consecutiveEmptyScans} consecutive empty scans)`);
      }

      const scanDuration = Date.now() - startTime;
      console.log(`Scan completed in ${scanDuration}ms`);

      this.emit('scanCompleted', {
        duration: scanDuration,
        opportunitiesFound: opportunities.length,
        viableOpportunities: viableOpportunities.length
      });

    } catch (error: any) {
      console.error('Scan error:', error.message || error);
      this.consecutiveEmptyScans++;
      this.emit('scanError', error);
    }
  }

  private async findArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    const tokenPairs = this.generateTokenPairs();
    const tradeAmounts = this.generateTradeAmounts();

    // Limit concurrent operations to avoid overwhelming the RPC
    const maxConcurrency = 3;
    const analysisPromises: Promise<void>[] = [];

    for (let i = 0; i < tokenPairs.length; i += maxConcurrency) {
      const batch = tokenPairs.slice(i, i + maxConcurrency);

      const batchPromise = Promise.all(
        batch.map(async ({ tokenA, tokenB }) => {
          // Only test the most liquid amount to reduce load
          const amount = tradeAmounts[1]; // Use middle amount

          try {
            const opportunity = await this.analyzeTokenPair(tokenA, tokenB, amount);
            if (opportunity) {
              opportunities.push(opportunity);
            }
          } catch (error: any) {
            console.warn(`Failed to analyze ${tokenA.symbol}-${tokenB.symbol}:`, error.message || error);
          }
        })
      ).then(() => {});

      analysisPromises.push(batchPromise);
    }

    // Wait for all batches to complete
    await Promise.allSettled(analysisPromises);

    return opportunities;
  }

  private async analyzeTokenPair(
    tokenA: TokenInfo,
    tokenB: TokenInfo,
    amountIn: BigNumber
  ): Promise<ArbitrageOpportunity | null> {
    try {
      // Add timeout for the entire analysis
      const analysisTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Token pair analysis timeout for ${tokenA.symbol}-${tokenB.symbol}`)), 15000);
      });

      const analysisPromise = this.performTokenPairAnalysis(tokenA, tokenB, amountIn);

      return await Promise.race([analysisPromise, analysisTimeout]);
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        console.warn(`Analysis timeout for ${tokenA.symbol}-${tokenB.symbol}`);
      } else {
        console.warn(`Analysis failed for ${tokenA.symbol}-${tokenB.symbol}:`, error.message || error);
      }
      return null;
    }
  }

  private async performTokenPairAnalysis(
    tokenA: TokenInfo,
    tokenB: TokenInfo,
    amountIn: BigNumber
  ): Promise<ArbitrageOpportunity | null> {
    // Get quotes with timeout
    const [forwardQuotes, reverseQuotes] = await Promise.all([
      this.batchQuoteEngine.getBatchQuotes(tokenA, tokenB, amountIn, 8000),
      this.batchQuoteEngine.getBatchQuotes(tokenB, tokenA, amountIn, 8000)
    ]);

    // Check if we have sufficient quotes for arbitrage
    if (forwardQuotes.length === 0 || reverseQuotes.length === 0) {
      return null;
    }

    // If we only have one quote per direction, we can't do arbitrage
    if (forwardQuotes.length < 2 && reverseQuotes.length < 2) {
      return null;
    }

    // Find best quotes from different exchanges
    let bestBuy: QuoteResult | null = null;
    let bestSell: QuoteResult | null = null;

    // For forward direction (tokenA -> tokenB)
    for (const quote of forwardQuotes) {
      if (!bestBuy || quote.amountOut.gt(bestBuy.amountOut)) {
        bestBuy = quote;
      }
    }

    // For reverse direction (tokenB -> tokenA)
    for (const quote of reverseQuotes) {
      if (!bestSell || quote.amountOut.gt(bestSell.amountOut)) {
        bestSell = quote;
      }
    }

    if (!bestBuy || !bestSell || bestBuy.dex === bestSell.dex) {
      return null; // Need different exchanges for arbitrage
    }

    // Calculate arbitrage potential
    const buyPrice = this.calculatePrice(amountIn, bestBuy.amountOut, tokenA.decimals, tokenB.decimals);
    const sellPrice = this.calculatePrice(amountIn, bestSell.amountOut, tokenB.decimals, tokenA.decimals);

    // Check if there's a profitable spread
    if (sellPrice.lte(buyPrice)) {
      return null;
    }

    const grossProfit = sellPrice.sub(buyPrice);
    const profitPercent = grossProfit.mul(10000).div(buyPrice).toNumber() / 100;

    // Skip if profit is too small to be realistic
    if (profitPercent < 0.01) {
      return null;
    }

    try {
      // Calculate gas costs with timeout
      const gasCostPromise = this.gasManager.calculateArbitrageGasCost(
        bestBuy.dex,
        bestSell.dex,
        await this.gasManager.getOptimalGasPrice()
      );

      const gasCost = await Promise.race([
        gasCostPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gas cost calculation timeout')), 3000)
        )
      ]);

      const netProfit = grossProfit.sub(gasCost.totalCostWei);

      return {
        tokenA,
        tokenB,
        amountIn,
        buyDex: bestBuy.dex,
        sellDex: bestSell.dex,
        buyPrice,
        sellPrice,
        profit: grossProfit,
        profitPercent,
        gasEstimate: gasCost.totalGas,
        netProfit
      };
    } catch (gasError) {
      // If gas calculation fails, use default estimates
      const defaultGasEstimate = BigNumber.from(500000);
      const defaultGasCost = defaultGasEstimate.mul(ethers.utils.parseUnits('30', 'gwei'));
      const netProfit = grossProfit.sub(defaultGasCost);

      return {
        tokenA,
        tokenB,
        amountIn,
        buyDex: bestBuy.dex,
        sellDex: bestSell.dex,
        buyPrice,
        sellPrice,
        profit: grossProfit,
        profitPercent,
        gasEstimate: defaultGasEstimate,
        netProfit
      };
    }
  }

  private generateTokenPairs(): Array<{ tokenA: TokenInfo; tokenB: TokenInfo }> {
    const tokens = Object.values(TOKENS);
    const pairs: Array<{ tokenA: TokenInfo; tokenB: TokenInfo }> = [];

    // Focus on high-volume pairs
    const priorityPairs = [
      ['WMATIC', 'USDC'],
      ['WETH', 'USDC'],
      ['WBTC', 'WETH'],
      ['DAI', 'USDC'],
      ['USDC', 'USDC.e'], // Bridge arbitrage
      ['WMATIC', 'WETH']
    ];

    for (const [symbolA, symbolB] of priorityPairs) {
      const tokenA = tokens.find(t => t.symbol === symbolA);
      const tokenB = tokens.find(t => t.symbol === symbolB);
      
      if (tokenA && tokenB) {
        pairs.push({ tokenA, tokenB });
      }
    }

    return pairs;
  }

  private generateTradeAmounts(): BigNumber[] {
    // Generate different trade sizes to test
    const baseAmounts = [1000, 5000, 10000, 25000]; // USD values
    
    return baseAmounts.map(amount => 
      ethers.utils.parseUnits(amount.toString(), 6) // Assuming USDC (6 decimals)
    );
  }

  private calculatePrice(
    amountIn: BigNumber,
    amountOut: BigNumber,
    decimalsIn: number,
    decimalsOut: number
  ): BigNumber {
    // Normalize to 18 decimals for calculation
    const normalizedIn = amountIn.mul(BigNumber.from(10).pow(18 - decimalsIn));
    const normalizedOut = amountOut.mul(BigNumber.from(10).pow(18 - decimalsOut));
    
    if (normalizedOut.isZero()) {
      return BigNumber.from(0);
    }
    
    return normalizedIn.mul(ethers.utils.parseEther('1')).div(normalizedOut);
  }

  private isOpportunityViable(opportunity: ArbitrageOpportunity): boolean {
    // Check minimum profit threshold
    const profitUSD = parseFloat(ethers.utils.formatEther(opportunity.netProfit)) * this.gasManager.getMaticPrice();
    if (profitUSD < this.config.minProfitThreshold) {
      return false;
    }

    // Check profit percentage
    if (opportunity.profitPercent < 0.05) { // Minimum 0.05% profit
      return false;
    }

    // Check slippage tolerance
    if (opportunity.profitPercent > this.config.maxSlippagePercent) {
      return false; // Too good to be true, likely stale data
    }

    return true;
  }

  async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<TradeResult> {
    const startTime = Date.now();
    
    try {
      // Validate opportunity is still profitable
      const currentOpportunity = await this.analyzeTokenPair(
        opportunity.tokenA,
        opportunity.tokenB,
        opportunity.amountIn
      );

      if (!currentOpportunity || !this.isOpportunityViable(currentOpportunity)) {
        throw new Error('Opportunity no longer viable');
      }

      // Execute the arbitrage trade
      const txResult = await this.executeFlashLoanArbitrage(currentOpportunity);
      
      const executionTime = Date.now() - startTime;
      const profit = parseFloat(ethers.utils.formatEther(currentOpportunity.profit));
      const netProfit = parseFloat(ethers.utils.formatEther(currentOpportunity.netProfit));

      const result: TradeResult = {
        successful: true,
        txHash: txResult.hash,
        profit,
        netProfit,
        amount: parseFloat(ethers.utils.formatEther(opportunity.amountIn)),
        tokenA: opportunity.tokenA.symbol,
        tokenB: opportunity.tokenB.symbol,
        sourceDEX: opportunity.buyDex,
        targetDEX: opportunity.sellDex,
        gasUsed: 0, // Will be updated after tx confirmation
        gasCost: 0,
        executionTime,
        timestamp: new Date()
      };

      // Wait for confirmation and update gas info
      const receipt = await txResult.wait();
      result.gasUsed = receipt.gasUsed.toNumber();
      result.gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice).toNumber();
      result.blockNumber = receipt.blockNumber;

      this.emit('tradeExecuted', result);
      return result;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      const result: TradeResult = {
        successful: false,
        profit: 0,
        netProfit: 0,
        amount: parseFloat(ethers.utils.formatEther(opportunity.amountIn)),
        tokenA: opportunity.tokenA.symbol,
        tokenB: opportunity.tokenB.symbol,
        sourceDEX: opportunity.buyDex,
        targetDEX: opportunity.sellDex,
        gasUsed: 0,
        gasCost: 0,
        executionTime,
        timestamp: new Date()
      };

      this.emit('tradeFailed', { result, error });
      return result;
    }
  }

  private async executeFlashLoanArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<ethers.ContractTransaction> {
    // This would integrate with the smart contract
    // For now, returning a mock transaction
    throw new Error('Flash loan execution not implemented - requires deployed contract');
  }

  getOpportunityHistory(tokenPair?: string): ArbitrageOpportunity[] {
    if (tokenPair) {
      return this.opportunityHistory.get(tokenPair) || [];
    }
    
    const allOpportunities: ArbitrageOpportunity[] = [];
    this.opportunityHistory.forEach(opportunities => {
      allOpportunities.push(...opportunities);
    });
    
    return allOpportunities.sort((a, b) => b.netProfit.sub(a.netProfit).gt(0) ? 1 : -1);
  }

  getStats(): {
    totalScans: number;
    totalOpportunities: number;
    averageOpportunitiesPerScan: number;
    lastScanTimestamp: number;
    isRunning: boolean;
  } {
    const totalOpportunities = Array.from(this.opportunityHistory.values())
      .reduce((sum, opportunities) => sum + opportunities.length, 0);
    
    return {
      totalScans: this.lastScanTimestamp > 0 ? 1 : 0, // Simplified
      totalOpportunities,
      averageOpportunitiesPerScan: totalOpportunities > 0 ? totalOpportunities : 0,
      lastScanTimestamp: this.lastScanTimestamp,
      isRunning: this.isRunning
    };
  }

  updateConfig(newConfig: Partial<ArbitrageConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', this.config);
  }
}