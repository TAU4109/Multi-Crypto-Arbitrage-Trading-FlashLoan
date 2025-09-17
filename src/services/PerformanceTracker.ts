import { TradeResult, ArbitrageOpportunity } from '../types';
import { EventEmitter } from 'events';

export interface PerformanceMetrics {
  totalTrades: number;
  successfulTrades: number;
  totalProfit: number;
  totalGasSpent: number;
  averageLatency: number;
  mevCaptured: number;
  failedTransactionCosts: number;
  successRate: number;
  sharpeRatio: number;
  maxDrawdown: number;
  currentDrawdown: number;
  averageProfit: number;
  averageLoss: number;
  profitFactor: number;
  winLossRatio: number;
  dailyPnL: number;
  weeklyPnL: number;
  monthlyPnL: number;
  annualizedReturn: number;
  volatility: number;
  calmarRatio: number;
  informationRatio: number;
}

export interface PeriodPerformance {
  period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  startDate: Date;
  endDate: Date;
  trades: number;
  profit: number;
  successRate: number;
  averageProfit: number;
  maxDrawdown: number;
  sharpeRatio: number;
  roi: number;
}

export interface TradeAnalysis {
  tokenPair: string;
  totalTrades: number;
  successRate: number;
  averageProfit: number;
  totalProfit: number;
  bestTrade: number;
  worstTrade: number;
  averageExecutionTime: number;
  popularDEXPairs: { source: string; target: string; count: number }[];
}

export class PerformanceTracker extends EventEmitter {
  private trades: TradeResult[] = [];
  private opportunities: ArbitrageOpportunity[] = [];
  private metrics: PerformanceMetrics;
  private initialCapital: number;
  private startTime: number;
  private lastReportTime: number = 0;
  private riskFreeRate: number = 0.02; // 2% annual risk-free rate

  constructor(initialCapital: number) {
    super();
    this.initialCapital = initialCapital;
    this.startTime = Date.now();
    this.metrics = this.initializeMetrics();
    
    // Generate performance reports periodically
    setInterval(() => {
      this.generatePeriodicReport();
    }, 3600000); // Every hour
  }

  private initializeMetrics(): PerformanceMetrics {
    return {
      totalTrades: 0,
      successfulTrades: 0,
      totalProfit: 0,
      totalGasSpent: 0,
      averageLatency: 0,
      mevCaptured: 0,
      failedTransactionCosts: 0,
      successRate: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
      averageProfit: 0,
      averageLoss: 0,
      profitFactor: 0,
      winLossRatio: 0,
      dailyPnL: 0,
      weeklyPnL: 0,
      monthlyPnL: 0,
      annualizedReturn: 0,
      volatility: 0,
      calmarRatio: 0,
      informationRatio: 0
    };
  }

  recordTrade(trade: TradeResult): void {
    this.trades.push(trade);
    
    // Keep only last 10,000 trades for memory management
    if (this.trades.length > 10000) {
      this.trades = this.trades.slice(-10000);
    }

    this.updateMetrics();
    this.emit('tradeRecorded', { trade, metrics: this.metrics });
  }

  recordOpportunity(opportunity: ArbitrageOpportunity): void {
    this.opportunities.push(opportunity);
    
    // Keep only last 1,000 opportunities
    if (this.opportunities.length > 1000) {
      this.opportunities = this.opportunities.slice(-1000);
    }

    this.emit('opportunityRecorded', opportunity);
  }

  private updateMetrics(): void {
    const successfulTrades = this.trades.filter(t => t.successful && t.netProfit > 0);
    const failedTrades = this.trades.filter(t => !t.successful || t.netProfit <= 0);

    // Basic metrics
    this.metrics.totalTrades = this.trades.length;
    this.metrics.successfulTrades = successfulTrades.length;
    this.metrics.successRate = this.metrics.totalTrades > 0 ? 
      (this.metrics.successfulTrades / this.metrics.totalTrades) * 100 : 0;

    // Profit metrics
    this.metrics.totalProfit = this.trades.reduce((sum, trade) => sum + trade.netProfit, 0);
    this.metrics.totalGasSpent = this.trades.reduce((sum, trade) => sum + trade.gasCost, 0);
    this.metrics.failedTransactionCosts = failedTrades.reduce((sum, trade) => sum + trade.gasCost, 0);

    // Average calculations
    if (successfulTrades.length > 0) {
      this.metrics.averageProfit = successfulTrades.reduce((sum, trade) => sum + trade.netProfit, 0) / successfulTrades.length;
    }

    if (failedTrades.length > 0) {
      this.metrics.averageLoss = Math.abs(failedTrades.reduce((sum, trade) => sum + trade.netProfit, 0) / failedTrades.length);
    }

    this.metrics.averageLatency = this.trades.length > 0 ? 
      this.trades.reduce((sum, trade) => sum + trade.executionTime, 0) / this.trades.length : 0;

    // Advanced metrics
    this.calculateDrawdown();
    this.calculateProfitFactor();
    this.calculatePeriodPnL();
    this.calculateRiskMetrics();
  }

  private calculateDrawdown(): void {
    if (this.trades.length === 0) return;

    let runningTotal = this.initialCapital;
    let peak = this.initialCapital;
    let maxDrawdown = 0;

    for (const trade of this.trades) {
      runningTotal += trade.netProfit;
      
      if (runningTotal > peak) {
        peak = runningTotal;
      }
      
      const currentDrawdown = ((peak - runningTotal) / peak) * 100;
      maxDrawdown = Math.max(maxDrawdown, currentDrawdown);
    }

    this.metrics.maxDrawdown = maxDrawdown;
    this.metrics.currentDrawdown = ((peak - runningTotal) / peak) * 100;
  }

  private calculateProfitFactor(): void {
    const grossProfit = this.trades
      .filter(t => t.netProfit > 0)
      .reduce((sum, trade) => sum + trade.netProfit, 0);
    
    const grossLoss = Math.abs(this.trades
      .filter(t => t.netProfit <= 0)
      .reduce((sum, trade) => sum + trade.netProfit, 0));

    this.metrics.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const wins = this.trades.filter(t => t.netProfit > 0).length;
    const losses = this.trades.filter(t => t.netProfit <= 0).length;
    this.metrics.winLossRatio = losses > 0 ? wins / losses : wins > 0 ? 999 : 0;
  }

  private calculatePeriodPnL(): void {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    this.metrics.dailyPnL = this.trades
      .filter(t => t.timestamp >= today)
      .reduce((sum, trade) => sum + trade.netProfit, 0);

    this.metrics.weeklyPnL = this.trades
      .filter(t => t.timestamp >= weekAgo)
      .reduce((sum, trade) => sum + trade.netProfit, 0);

    this.metrics.monthlyPnL = this.trades
      .filter(t => t.timestamp >= monthAgo)
      .reduce((sum, trade) => sum + trade.netProfit, 0);
  }

  private calculateRiskMetrics(): void {
    if (this.trades.length < 30) return; // Need sufficient data

    const returns = this.calculateDailyReturns();
    
    // Annualized return
    const totalReturn = this.metrics.totalProfit / this.initialCapital;
    const daysRunning = (Date.now() - this.startTime) / (1000 * 60 * 60 * 24);
    this.metrics.annualizedReturn = Math.pow(1 + totalReturn, 365 / Math.max(daysRunning, 1)) - 1;

    // Volatility
    this.metrics.volatility = this.calculateVolatility(returns);

    // Sharpe Ratio
    const excessReturn = this.metrics.annualizedReturn - this.riskFreeRate;
    this.metrics.sharpeRatio = this.metrics.volatility > 0 ? excessReturn / this.metrics.volatility : 0;

    // Calmar Ratio
    this.metrics.calmarRatio = this.metrics.maxDrawdown > 0 ? 
      this.metrics.annualizedReturn / (this.metrics.maxDrawdown / 100) : 0;

    // Information Ratio (assuming benchmark return is 0 for arbitrage)
    this.metrics.informationRatio = this.metrics.volatility > 0 ? 
      this.metrics.annualizedReturn / this.metrics.volatility : 0;
  }

  private calculateDailyReturns(): number[] {
    const dailyPnL: { [date: string]: number } = {};
    
    for (const trade of this.trades) {
      const dateKey = trade.timestamp.toISOString().split('T')[0];
      dailyPnL[dateKey] = (dailyPnL[dateKey] || 0) + trade.netProfit;
    }

    return Object.values(dailyPnL).map(pnl => pnl / this.initialCapital);
  }

  private calculateVolatility(returns: number[]): number {
    if (returns.length < 2) return 0;

    const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / (returns.length - 1);
    
    return Math.sqrt(variance * 252); // Annualized volatility
  }

  generatePerformanceReport(): {
    summary: PerformanceMetrics;
    periods: PeriodPerformance[];
    tokenAnalysis: TradeAnalysis[];
    recommendations: string[];
  } {
    const periods = this.generatePeriodPerformance();
    const tokenAnalysis = this.generateTokenAnalysis();
    const recommendations = this.generateRecommendations();

    return {
      summary: this.metrics,
      periods,
      tokenAnalysis,
      recommendations
    };
  }

  private generatePeriodPerformance(): PeriodPerformance[] {
    const periods: PeriodPerformance[] = [];
    const now = new Date();

    // Daily performance
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayTrades = this.trades.filter(t => t.timestamp >= todayStart);
    
    if (todayTrades.length > 0) {
      periods.push({
        period: 'daily',
        startDate: todayStart,
        endDate: now,
        trades: todayTrades.length,
        profit: todayTrades.reduce((sum, t) => sum + t.netProfit, 0),
        successRate: (todayTrades.filter(t => t.successful && t.netProfit > 0).length / todayTrades.length) * 100,
        averageProfit: todayTrades.reduce((sum, t) => sum + t.netProfit, 0) / todayTrades.length,
        maxDrawdown: 0, // Would need to calculate
        sharpeRatio: 0, // Would need to calculate
        roi: (todayTrades.reduce((sum, t) => sum + t.netProfit, 0) / this.initialCapital) * 100
      });
    }

    // Weekly performance
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekTrades = this.trades.filter(t => t.timestamp >= weekStart);
    
    if (weekTrades.length > 0) {
      periods.push({
        period: 'weekly',
        startDate: weekStart,
        endDate: now,
        trades: weekTrades.length,
        profit: weekTrades.reduce((sum, t) => sum + t.netProfit, 0),
        successRate: (weekTrades.filter(t => t.successful && t.netProfit > 0).length / weekTrades.length) * 100,
        averageProfit: weekTrades.reduce((sum, t) => sum + t.netProfit, 0) / weekTrades.length,
        maxDrawdown: 0,
        sharpeRatio: 0,
        roi: (weekTrades.reduce((sum, t) => sum + t.netProfit, 0) / this.initialCapital) * 100
      });
    }

    return periods;
  }

  private generateTokenAnalysis(): TradeAnalysis[] {
    const pairMap: { [pair: string]: TradeResult[] } = {};
    
    for (const trade of this.trades) {
      const pairKey = `${trade.tokenA}/${trade.tokenB}`;
      if (!pairMap[pairKey]) {
        pairMap[pairKey] = [];
      }
      pairMap[pairKey].push(trade);
    }

    return Object.entries(pairMap).map(([pair, trades]) => {
      const successfulTrades = trades.filter(t => t.successful && t.netProfit > 0);
      const dexPairs: { [key: string]: number } = {};
      
      for (const trade of trades) {
        const dexKey = `${trade.sourceDEX}-${trade.targetDEX}`;
        dexPairs[dexKey] = (dexPairs[dexKey] || 0) + 1;
      }

      return {
        tokenPair: pair,
        totalTrades: trades.length,
        successRate: (successfulTrades.length / trades.length) * 100,
        averageProfit: trades.reduce((sum, t) => sum + t.netProfit, 0) / trades.length,
        totalProfit: trades.reduce((sum, t) => sum + t.netProfit, 0),
        bestTrade: Math.max(...trades.map(t => t.netProfit)),
        worstTrade: Math.min(...trades.map(t => t.netProfit)),
        averageExecutionTime: trades.reduce((sum, t) => sum + t.executionTime, 0) / trades.length,
        popularDEXPairs: Object.entries(dexPairs)
          .map(([key, count]) => {
            const [source, target] = key.split('-');
            return { source, target, count };
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
      };
    }).sort((a, b) => b.totalProfit - a.totalProfit);
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];

    if (this.metrics.successRate < 60) {
      recommendations.push('Consider tightening profit thresholds - success rate below 60%');
    }

    if (this.metrics.currentDrawdown > 10) {
      recommendations.push('High drawdown detected - consider reducing position sizes');
    }

    if (this.metrics.averageLatency > 5000) {
      recommendations.push('High execution latency - optimize network connections');
    }

    if (this.metrics.sharpeRatio < 1) {
      recommendations.push('Low risk-adjusted returns - review strategy parameters');
    }

    if (this.metrics.failedTransactionCosts > this.metrics.totalProfit * 0.1) {
      recommendations.push('High failed transaction costs - improve opportunity filtering');
    }

    if (this.trades.length > 100 && this.metrics.profitFactor < 1.5) {
      recommendations.push('Low profit factor - consider increasing minimum profit thresholds');
    }

    if (recommendations.length === 0) {
      recommendations.push('Performance looks good - continue monitoring');
    }

    return recommendations;
  }

  private generatePeriodicReport(): void {
    if (Date.now() - this.lastReportTime < 3600000) return; // Max once per hour

    const report = this.generatePerformanceReport();
    this.lastReportTime = Date.now();
    
    this.emit('performanceReport', report);
  }

  // Public getters
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  getRecentTrades(count: number = 10): TradeResult[] {
    return this.trades.slice(-count);
  }

  getTradesByPair(tokenA: string, tokenB: string): TradeResult[] {
    return this.trades.filter(t => 
      (t.tokenA === tokenA && t.tokenB === tokenB) ||
      (t.tokenA === tokenB && t.tokenB === tokenA)
    );
  }

  getOpportunityConversionRate(): number {
    if (this.opportunities.length === 0) return 0;
    return (this.trades.length / this.opportunities.length) * 100;
  }

  calculateAPY(): number {
    const daysRunning = (Date.now() - this.startTime) / (1000 * 60 * 60 * 24);
    if (daysRunning < 1) return 0;

    const totalReturn = this.metrics.totalProfit / this.initialCapital;
    return Math.pow(1 + totalReturn, 365 / daysRunning) - 1;
  }

  calculateMaximumDrawdownDuration(): number {
    // Calculate the longest drawdown period in days
    let maxDuration = 0;
    let currentDuration = 0;
    let inDrawdown = false;
    let runningTotal = this.initialCapital;
    let peak = this.initialCapital;

    for (const trade of this.trades) {
      runningTotal += trade.netProfit;
      
      if (runningTotal > peak) {
        peak = runningTotal;
        if (inDrawdown) {
          maxDuration = Math.max(maxDuration, currentDuration);
          currentDuration = 0;
          inDrawdown = false;
        }
      } else if (runningTotal < peak) {
        if (!inDrawdown) {
          inDrawdown = true;
          currentDuration = 0;
        }
        currentDuration++;
      }
    }

    return Math.max(maxDuration, currentDuration);
  }

  exportPerformanceData(): {
    trades: TradeResult[];
    metrics: PerformanceMetrics;
    report: any;
  } {
    return {
      trades: this.trades,
      metrics: this.metrics,
      report: this.generatePerformanceReport()
    };
  }

  reset(): void {
    this.trades = [];
    this.opportunities = [];
    this.metrics = this.initializeMetrics();
    this.startTime = Date.now();
    this.lastReportTime = 0;
    
    this.emit('reset');
  }
}