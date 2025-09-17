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

  constructor(
    provider: ethers.providers.Provider,
    config: ArbitrageConfig
  ) {
    super();
    this.provider = provider;
    this.batchQuoteEngine = new BatchQuoteEngine(provider);
    this.gasManager = new GasManager(provider);
    this.config = config;
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
      // Check if gas price is acceptable
      const gasAcceptable = await this.gasManager.isGasPriceAcceptable(
        this.config.gasLimitGwei,
        'medium'
      );

      if (!gasAcceptable) {
        console.log('Gas price too high, skipping scan');
        return;
      }

      const opportunities = await this.findArbitrageOpportunities();
      
      // Filter and rank opportunities
      const viableOpportunities = opportunities
        .filter(op => this.isOpportunityViable(op))
        .sort((a, b) => b.netProfit.sub(a.netProfit).gt(0) ? 1 : -1)
        .slice(0, 5); // Top 5 opportunities

      if (viableOpportunities.length > 0) {
        this.emit('opportunities', viableOpportunities);
        
        // Store in history for analysis
        const pairKey = `${viableOpportunities[0].tokenA.symbol}-${viableOpportunities[0].tokenB.symbol}`;
        if (!this.opportunityHistory.has(pairKey)) {
          this.opportunityHistory.set(pairKey, []);
        }
        this.opportunityHistory.get(pairKey)!.push(...viableOpportunities);
        
        // Keep only last 100 opportunities per pair
        if (this.opportunityHistory.get(pairKey)!.length > 100) {
          this.opportunityHistory.get(pairKey)!.splice(0, 50);
        }
      }

      const scanDuration = Date.now() - startTime;
      this.emit('scanCompleted', {
        duration: scanDuration,
        opportunitiesFound: opportunities.length,
        viableOpportunities: viableOpportunities.length
      });

    } catch (error) {
      console.error('Scan error:', error);
      this.emit('scanError', error);
    }
  }

  private async findArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    const tokenPairs = this.generateTokenPairs();
    const tradeAmounts = this.generateTradeAmounts();

    for (const { tokenA, tokenB } of tokenPairs) {
      for (const amount of tradeAmounts) {
        try {
          const opportunity = await this.analyzeTokenPair(tokenA, tokenB, amount);
          if (opportunity) {
            opportunities.push(opportunity);
          }
        } catch (error) {
          console.warn(`Failed to analyze ${tokenA.symbol}-${tokenB.symbol}:`, error);
        }
      }
    }

    return opportunities;
  }

  private async analyzeTokenPair(
    tokenA: TokenInfo,
    tokenB: TokenInfo,
    amountIn: BigNumber
  ): Promise<ArbitrageOpportunity | null> {
    // Get quotes from all DEXs for both directions
    const [forwardQuotes, reverseQuotes] = await Promise.all([
      this.batchQuoteEngine.getBatchQuotes(tokenA, tokenB, amountIn),
      this.batchQuoteEngine.getBatchQuotes(tokenB, tokenA, amountIn)
    ]);

    if (forwardQuotes.length < 2 || reverseQuotes.length < 2) {
      return null; // Need at least 2 exchanges for arbitrage
    }

    // Find best buy and sell prices
    const bestBuy = forwardQuotes.reduce((best, current) => 
      current.amountOut.gt(best.amountOut) ? current : best
    );
    
    const bestSell = reverseQuotes.reduce((best, current) => 
      current.amountOut.gt(best.amountOut) ? current : best
    );

    // Calculate arbitrage potential
    const buyPrice = this.calculatePrice(amountIn, bestBuy.amountOut, tokenA.decimals, tokenB.decimals);
    const sellPrice = this.calculatePrice(amountIn, bestSell.amountOut, tokenB.decimals, tokenA.decimals);

    // Check if there's a profitable spread
    if (sellPrice.lte(buyPrice)) {
      return null;
    }

    const grossProfit = sellPrice.sub(buyPrice);
    const profitPercent = grossProfit.mul(10000).div(buyPrice).toNumber() / 100;

    // Calculate gas costs
    const gasCost = this.gasManager.calculateArbitrageGasCost(
      bestBuy.dex,
      bestSell.dex,
      await this.gasManager.getOptimalGasPrice()
    );

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