import { BigNumber, ethers } from 'ethers';
import { ArbitrageOpportunity, TradeResult } from '../types';
import { EventEmitter } from 'events';

export interface RiskLimits {
  dailyLossLimit: number; // Percentage of portfolio
  consecutiveLossLimit: number; // Number of consecutive failed trades
  volatilityLimit: number; // Maximum volatility threshold
  gasThreshold: number; // Maximum gas price in Gwei
  slippageLimit: number; // Maximum slippage percentage
  positionSizeLimit: number; // Maximum position size as % of portfolio
  drawdownLimit: number; // Maximum drawdown percentage
  hourlyTradeLimit: number; // Maximum trades per hour
}

export interface RiskMetrics {
  dailyPnL: number;
  totalPnL: number;
  consecutiveLosses: number;
  currentDrawdown: number;
  maxDrawdown: number;
  volatility: number;
  tradesInLastHour: number;
  lastTradeTime: number;
  portfolioValue: number;
  riskScore: number; // 0-100, higher = riskier
}

interface CircuitBreakerState {
  isTriggered: boolean;
  reason: string;
  triggeredAt: number;
  autoResetTime?: number;
}

export class RiskManager extends EventEmitter {
  private limits: RiskLimits;
  private metrics: RiskMetrics;
  private tradeHistory: TradeResult[] = [];
  private circuitBreaker: CircuitBreakerState;
  private portfolioStartValue: number;
  private dailyStartValue: number;
  private dailyResetTime: number;

  constructor(limits: RiskLimits, initialPortfolioValue: number) {
    super();
    this.limits = limits;
    this.portfolioStartValue = initialPortfolioValue;
    this.dailyStartValue = initialPortfolioValue;
    this.dailyResetTime = this.getTodayStartTimestamp();
    
    this.metrics = {
      dailyPnL: 0,
      totalPnL: 0,
      consecutiveLosses: 0,
      currentDrawdown: 0,
      maxDrawdown: 0,
      volatility: 0,
      tradesInLastHour: 0,
      lastTradeTime: 0,
      portfolioValue: initialPortfolioValue,
      riskScore: 0
    };

    this.circuitBreaker = {
      isTriggered: false,
      reason: '',
      triggeredAt: 0
    };

    // Reset daily metrics at midnight
    setInterval(() => {
      this.resetDailyMetrics();
    }, 60000); // Check every minute
  }

  async evaluateRisk(opportunity: ArbitrageOpportunity): Promise<{
    approved: boolean;
    reason?: string;
    riskScore: number;
  }> {
    // Update current metrics
    await this.updateMetrics();

    // Check circuit breaker
    if (this.circuitBreaker.isTriggered) {
      if (!this.shouldAutoReset()) {
        return {
          approved: false,
          reason: `Circuit breaker active: ${this.circuitBreaker.reason}`,
          riskScore: 100
        };
      } else {
        this.resetCircuitBreaker();
      }
    }

    // Calculate risk score for this opportunity
    const opportunityRisk = this.calculateOpportunityRisk(opportunity);

    // Check individual risk limits
    const riskChecks = [
      this.checkDailyLossLimit(),
      this.checkConsecutiveLossLimit(),
      this.checkVolatilityLimit(opportunity),
      this.checkSlippageLimit(opportunity),
      this.checkPositionSizeLimit(opportunity),
      this.checkDrawdownLimit(),
      this.checkTradeFrequencyLimit(),
      this.checkGasThreshold()
    ];

    const failedChecks = riskChecks.filter(check => !check.passed);

    if (failedChecks.length > 0) {
      const reasons = failedChecks.map(check => check.reason).join(', ');
      
      // Trigger circuit breaker for critical failures
      if (failedChecks.some(check => check.critical)) {
        await this.triggerCircuitBreaker(reasons);
      }

      return {
        approved: false,
        reason: reasons,
        riskScore: opportunityRisk
      };
    }

    // Final risk score check
    if (opportunityRisk > 80) {
      return {
        approved: false,
        reason: 'Overall risk score too high',
        riskScore: opportunityRisk
      };
    }

    return {
      approved: true,
      riskScore: opportunityRisk
    };
  }

  private calculateOpportunityRisk(opportunity: ArbitrageOpportunity): number {
    let riskScore = 0;

    // Profit percentage risk (too good to be true)
    if (opportunity.profitPercent > 5) {
      riskScore += 30; // Suspicious high profit
    } else if (opportunity.profitPercent < 0.1) {
      riskScore += 20; // Very low profit margin
    }

    // Position size risk
    const positionSize = parseFloat(ethers.utils.formatEther(opportunity.amountIn));
    const positionPercent = (positionSize / this.metrics.portfolioValue) * 100;
    
    if (positionPercent > this.limits.positionSizeLimit * 0.8) {
      riskScore += 25; // Close to position limit
    }

    // Gas cost risk
    const gasEstimate = opportunity.gasEstimate.toNumber();
    if (gasEstimate > 1000000) {
      riskScore += 15; // High gas usage
    }

    // Market volatility risk
    riskScore += Math.min(this.metrics.volatility * 10, 20);

    // Recent performance impact
    if (this.metrics.consecutiveLosses > 2) {
      riskScore += this.metrics.consecutiveLosses * 5;
    }

    // Current drawdown impact
    riskScore += this.metrics.currentDrawdown * 2;

    return Math.min(riskScore, 100);
  }

  private checkDailyLossLimit(): { passed: boolean; reason: string; critical: boolean } {
    const dailyLossPercent = Math.abs(Math.min(this.metrics.dailyPnL, 0)) / this.dailyStartValue * 100;
    
    return {
      passed: dailyLossPercent < this.limits.dailyLossLimit,
      reason: `Daily loss limit exceeded: ${dailyLossPercent.toFixed(2)}% >= ${this.limits.dailyLossLimit}%`,
      critical: true
    };
  }

  private checkConsecutiveLossLimit(): { passed: boolean; reason: string; critical: boolean } {
    return {
      passed: this.metrics.consecutiveLosses < this.limits.consecutiveLossLimit,
      reason: `Consecutive loss limit exceeded: ${this.metrics.consecutiveLosses} >= ${this.limits.consecutiveLossLimit}`,
      critical: true
    };
  }

  private checkVolatilityLimit(opportunity: ArbitrageOpportunity): { passed: boolean; reason: string; critical: boolean } {
    return {
      passed: this.metrics.volatility < this.limits.volatilityLimit,
      reason: `Market volatility too high: ${this.metrics.volatility.toFixed(2)} >= ${this.limits.volatilityLimit}`,
      critical: false
    };
  }

  private checkSlippageLimit(opportunity: ArbitrageOpportunity): { passed: boolean; reason: string; critical: boolean } {
    return {
      passed: opportunity.profitPercent <= this.limits.slippageLimit,
      reason: `Slippage risk too high: ${opportunity.profitPercent.toFixed(2)}% >= ${this.limits.slippageLimit}%`,
      critical: false
    };
  }

  private checkPositionSizeLimit(opportunity: ArbitrageOpportunity): { passed: boolean; reason: string; critical: boolean } {
    const positionSize = parseFloat(ethers.utils.formatEther(opportunity.amountIn));
    const positionPercent = (positionSize / this.metrics.portfolioValue) * 100;
    
    return {
      passed: positionPercent <= this.limits.positionSizeLimit,
      reason: `Position size too large: ${positionPercent.toFixed(2)}% >= ${this.limits.positionSizeLimit}%`,
      critical: false
    };
  }

  private checkDrawdownLimit(): { passed: boolean; reason: string; critical: boolean } {
    return {
      passed: this.metrics.currentDrawdown < this.limits.drawdownLimit,
      reason: `Drawdown limit exceeded: ${this.metrics.currentDrawdown.toFixed(2)}% >= ${this.limits.drawdownLimit}%`,
      critical: true
    };
  }

  private checkTradeFrequencyLimit(): { passed: boolean; reason: string; critical: boolean } {
    return {
      passed: this.metrics.tradesInLastHour < this.limits.hourlyTradeLimit,
      reason: `Hourly trade limit exceeded: ${this.metrics.tradesInLastHour} >= ${this.limits.hourlyTradeLimit}`,
      critical: false
    };
  }

  private async checkGasThreshold(): Promise<{ passed: boolean; reason: string; critical: boolean }> {
    // This would integrate with gas price checking
    const currentGasPrice = 50; // Mock gas price in Gwei
    
    return {
      passed: currentGasPrice < this.limits.gasThreshold,
      reason: `Gas price too high: ${currentGasPrice} >= ${this.limits.gasThreshold} Gwei`,
      critical: false
    };
  }

  async recordTrade(trade: TradeResult): Promise<void> {
    this.tradeHistory.push(trade);
    
    // Keep only last 1000 trades
    if (this.tradeHistory.length > 1000) {
      this.tradeHistory = this.tradeHistory.slice(-1000);
    }

    // Update metrics
    await this.updateMetricsFromTrade(trade);

    // Check for risk violations after trade
    if (trade.successful && trade.netProfit < 0) {
      this.metrics.consecutiveLosses++;
    } else if (trade.successful && trade.netProfit > 0) {
      this.metrics.consecutiveLosses = 0;
    }

    // Check if we need to trigger circuit breaker
    await this.checkPostTradeRisks(trade);

    this.emit('tradeRecorded', { trade, metrics: this.metrics });
  }

  private async updateMetricsFromTrade(trade: TradeResult): Promise<void> {
    // Update PnL
    this.metrics.totalPnL += trade.netProfit;
    this.metrics.dailyPnL += trade.netProfit;
    this.metrics.portfolioValue = this.portfolioStartValue + this.metrics.totalPnL;

    // Update drawdown
    const currentValue = this.metrics.portfolioValue;
    const peak = Math.max(this.portfolioStartValue, currentValue + this.metrics.totalPnL);
    this.metrics.currentDrawdown = ((peak - currentValue) / peak) * 100;
    this.metrics.maxDrawdown = Math.max(this.metrics.maxDrawdown, this.metrics.currentDrawdown);

    // Update volatility (simplified calculation)
    this.updateVolatility();

    // Update trade frequency
    this.updateTradeFrequency();

    // Update last trade time
    this.metrics.lastTradeTime = Date.now();

    // Recalculate risk score
    this.metrics.riskScore = this.calculateCurrentRiskScore();
  }

  private updateVolatility(): void {
    if (this.tradeHistory.length < 10) {
      this.metrics.volatility = 0;
      return;
    }

    const recentTrades = this.tradeHistory.slice(-20);
    const returns = recentTrades.map(trade => trade.netProfit / trade.amount);
    
    const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
    
    this.metrics.volatility = Math.sqrt(variance) * 100; // Convert to percentage
  }

  private updateTradeFrequency(): void {
    const oneHourAgo = Date.now() - 3600000; // 1 hour in milliseconds
    this.metrics.tradesInLastHour = this.tradeHistory.filter(
      trade => trade.timestamp.getTime() > oneHourAgo
    ).length;
  }

  private calculateCurrentRiskScore(): number {
    let score = 0;

    // Drawdown risk
    score += this.metrics.currentDrawdown * 2;

    // Consecutive losses risk
    score += this.metrics.consecutiveLosses * 5;

    // Volatility risk
    score += this.metrics.volatility;

    // Daily PnL risk
    if (this.metrics.dailyPnL < 0) {
      const dailyLossPercent = Math.abs(this.metrics.dailyPnL) / this.dailyStartValue * 100;
      score += dailyLossPercent * 3;
    }

    // Trade frequency risk
    if (this.metrics.tradesInLastHour > this.limits.hourlyTradeLimit * 0.8) {
      score += 20;
    }

    return Math.min(score, 100);
  }

  private async checkPostTradeRisks(trade: TradeResult): Promise<void> {
    const risks = [];

    // Check if daily loss limit is approaching
    if (this.metrics.dailyPnL < 0) {
      const dailyLossPercent = Math.abs(this.metrics.dailyPnL) / this.dailyStartValue * 100;
      if (dailyLossPercent > this.limits.dailyLossLimit * 0.8) {
        risks.push('Approaching daily loss limit');
      }
    }

    // Check consecutive losses
    if (this.metrics.consecutiveLosses >= this.limits.consecutiveLossLimit) {
      risks.push('Consecutive loss limit reached');
    }

    // Check drawdown
    if (this.metrics.currentDrawdown > this.limits.drawdownLimit * 0.9) {
      risks.push('Approaching maximum drawdown');
    }

    // Trigger circuit breaker if critical risks detected
    if (risks.length > 0 && this.shouldTriggerCircuitBreaker(risks)) {
      await this.triggerCircuitBreaker(risks.join(', '));
    } else if (risks.length > 0) {
      this.emit('riskWarning', { risks, metrics: this.metrics });
    }
  }

  private shouldTriggerCircuitBreaker(risks: string[]): boolean {
    return risks.some(risk => 
      risk.includes('loss limit') || 
      risk.includes('drawdown') ||
      risk.includes('consecutive')
    );
  }

  private async triggerCircuitBreaker(reason: string): Promise<void> {
    this.circuitBreaker = {
      isTriggered: true,
      reason,
      triggeredAt: Date.now(),
      autoResetTime: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
    };

    console.error(`Circuit breaker triggered: ${reason}`);
    this.emit('circuitBreakerTriggered', { reason, metrics: this.metrics });
  }

  private shouldAutoReset(): boolean {
    if (!this.circuitBreaker.autoResetTime) {
      return false;
    }
    
    return Date.now() > this.circuitBreaker.autoResetTime;
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker = {
      isTriggered: false,
      reason: '',
      triggeredAt: 0
    };

    console.log('Circuit breaker reset');
    this.emit('circuitBreakerReset');
  }

  private async updateMetrics(): Promise<void> {
    // Update time-based metrics
    this.updateTradeFrequency();
    
    // Check if we need to reset daily metrics
    if (Date.now() > this.dailyResetTime + (24 * 60 * 60 * 1000)) {
      this.resetDailyMetrics();
    }

    // Recalculate risk score
    this.metrics.riskScore = this.calculateCurrentRiskScore();
  }

  private resetDailyMetrics(): void {
    const now = Date.now();
    const todayStart = this.getTodayStartTimestamp();
    
    if (now > this.dailyResetTime + (24 * 60 * 60 * 1000)) {
      this.dailyStartValue = this.metrics.portfolioValue;
      this.metrics.dailyPnL = 0;
      this.dailyResetTime = todayStart;
      
      console.log('Daily metrics reset');
      this.emit('dailyReset', { 
        newStartValue: this.dailyStartValue,
        resetTime: new Date(todayStart)
      });
    }
  }

  private getTodayStartTimestamp(): number {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return todayStart.getTime();
  }

  // Public getters
  getMetrics(): RiskMetrics {
    return { ...this.metrics };
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  getCircuitBreakerState(): CircuitBreakerState {
    return { ...this.circuitBreaker };
  }

  getRecentTrades(count: number = 10): TradeResult[] {
    return this.tradeHistory.slice(-count);
  }

  // Configuration updates
  updateLimits(newLimits: Partial<RiskLimits>): void {
    this.limits = { ...this.limits, ...newLimits };
    this.emit('limitsUpdated', this.limits);
  }

  // Emergency controls
  async emergencyStop(): Promise<void> {
    await this.triggerCircuitBreaker('Emergency stop requested');
  }

  forceReset(): void {
    this.metrics.consecutiveLosses = 0;
    this.resetCircuitBreaker();
    this.emit('forceReset');
  }

  // Risk reporting
  generateRiskReport(): {
    summary: string;
    metrics: RiskMetrics;
    limits: RiskLimits;
    recommendations: string[];
  } {
    const recommendations: string[] = [];

    if (this.metrics.currentDrawdown > this.limits.drawdownLimit * 0.7) {
      recommendations.push('Consider reducing position sizes');
    }

    if (this.metrics.consecutiveLosses > 3) {
      recommendations.push('Review trading strategy');
    }

    if (this.metrics.volatility > this.limits.volatilityLimit * 0.8) {
      recommendations.push('Monitor market conditions closely');
    }

    if (this.metrics.riskScore > 60) {
      recommendations.push('High risk detected - consider pausing operations');
    }

    let summary = '✅ Risk levels normal';
    if (this.metrics.riskScore > 80) {
      summary = '🔴 High risk - immediate attention required';
    } else if (this.metrics.riskScore > 60) {
      summary = '🟡 Elevated risk - monitor closely';
    }

    return {
      summary,
      metrics: this.getMetrics(),
      limits: this.getLimits(),
      recommendations
    };
  }
}