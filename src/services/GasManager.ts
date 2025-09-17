import { ethers, BigNumber } from 'ethers';
import axios from 'axios';

export interface GasPrice {
  safeLow: BigNumber;
  standard: BigNumber;
  fast: BigNumber;
  instant: BigNumber;
  baseFee: BigNumber;
  priorityFee: BigNumber;
}

export interface GasCostAnalysis {
  flashLoanGas: BigNumber;
  swapGas: BigNumber;
  totalGas: BigNumber;
  gasPriceGwei: BigNumber;
  totalCostWei: BigNumber;
  totalCostUSD: number;
  breakEvenSpread: number;
}

export class GasManager {
  private provider: ethers.providers.Provider;
  private gasStationUrl: string = 'https://gasstation.polygon.technology/v2';
  private maticPriceUSD: number = 0.5; // Default, should be updated from price feed
  
  // Gas estimates for different operations
  private readonly GAS_ESTIMATES = {
    FLASH_LOAN_BASE: 150000,
    UNISWAP_V3_SWAP: 180000,
    QUICKSWAP_SWAP: 120000,
    SUSHISWAP_SWAP: 120000,
    TOKEN_TRANSFER: 21000,
    APPROVAL: 46000,
    SAFETY_BUFFER: 1.2 // 20% buffer
  };

  constructor(provider: ethers.providers.Provider) {
    this.provider = provider;
    this.updateMaticPrice();
  }

  async getCurrentGasPrice(): Promise<GasPrice> {
    try {
      const response = await axios.get(this.gasStationUrl, {
        timeout: 5000
      });
      
      const data = response.data;
      
      return {
        safeLow: this.gweiToBigNumber(data.safeLow.maxFee),
        standard: this.gweiToBigNumber(data.standard.maxFee),
        fast: this.gweiToBigNumber(data.fast.maxFee),
        instant: this.gweiToBigNumber(data.instant.maxFee),
        baseFee: this.gweiToBigNumber(data.estimatedBaseFee),
        priorityFee: this.gweiToBigNumber(data.standard.maxPriorityFee)
      };
    } catch (error) {
      console.warn('Failed to fetch gas prices from station, using fallback:', error);
      return this.getFallbackGasPrice();
    }
  }

  async getOptimalGasPrice(urgency: 'low' | 'medium' | 'high' = 'medium'): Promise<BigNumber> {
    const gasPrice = await this.getCurrentGasPrice();
    
    switch (urgency) {
      case 'low':
        return gasPrice.safeLow;
      case 'medium':
        return gasPrice.standard;
      case 'high':
        return gasPrice.fast;
      default:
        return gasPrice.standard;
    }
  }

  calculateArbitrageGasCost(
    sourceExchange: string,
    targetExchange: string,
    gasPrice: BigNumber
  ): GasCostAnalysis {
    const flashLoanGas = BigNumber.from(this.GAS_ESTIMATES.FLASH_LOAN_BASE);
    
    let sourceSwapGas = BigNumber.from(this.GAS_ESTIMATES.QUICKSWAP_SWAP);
    let targetSwapGas = BigNumber.from(this.GAS_ESTIMATES.QUICKSWAP_SWAP);

    // Adjust gas estimates based on exchange
    if (sourceExchange.includes('UNISWAP')) {
      sourceSwapGas = BigNumber.from(this.GAS_ESTIMATES.UNISWAP_V3_SWAP);
    } else if (sourceExchange.includes('SUSHI')) {
      sourceSwapGas = BigNumber.from(this.GAS_ESTIMATES.SUSHISWAP_SWAP);
    }

    if (targetExchange.includes('UNISWAP')) {
      targetSwapGas = BigNumber.from(this.GAS_ESTIMATES.UNISWAP_V3_SWAP);
    } else if (targetExchange.includes('SUSHI')) {
      targetSwapGas = BigNumber.from(this.GAS_ESTIMATES.SUSHISWAP_SWAP);
    }

    const swapGas = sourceSwapGas.add(targetSwapGas);
    const approvalGas = BigNumber.from(this.GAS_ESTIMATES.APPROVAL * 2); // Two approvals
    const totalGas = flashLoanGas.add(swapGas).add(approvalGas);
    
    // Apply safety buffer
    const totalGasWithBuffer = totalGas.mul(
      Math.floor(this.GAS_ESTIMATES.SAFETY_BUFFER * 1000)
    ).div(1000);

    const totalCostWei = totalGasWithBuffer.mul(gasPrice);
    const totalCostUSD = this.weiToUSD(totalCostWei);
    
    return {
      flashLoanGas,
      swapGas,
      totalGas: totalGasWithBuffer,
      gasPriceGwei: gasPrice.div(1e9),
      totalCostWei,
      totalCostUSD,
      breakEvenSpread: this.calculateBreakEvenSpread(totalCostUSD)
    };
  }

  calculateMinProfitThreshold(
    gasCost: BigNumber,
    amountIn: BigNumber,
    bufferPercent: number = 20
  ): BigNumber {
    // Convert gas cost to same denomination as trade amount
    const gasCostInToken = this.convertGasCostToToken(gasCost, amountIn);
    
    // Add buffer
    const buffer = gasCostInToken.mul(bufferPercent).div(100);
    
    return gasCostInToken.add(buffer);
  }

  async isGasPriceAcceptable(
    maxGasPriceGwei: number = 100,
    urgency: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<boolean> {
    const gasPrice = await this.getOptimalGasPrice(urgency);
    const gasPriceGwei = gasPrice.div(1e9);
    
    return gasPriceGwei.lte(maxGasPriceGwei);
  }

  async estimateTransactionCost(
    txData: any,
    gasPrice?: BigNumber
  ): Promise<{ gasLimit: BigNumber; gasCost: BigNumber; gasCostUSD: number }> {
    try {
      const gasLimit = await this.provider.estimateGas(txData);
      const currentGasPrice = gasPrice || await this.getOptimalGasPrice();
      const gasCost = gasLimit.mul(currentGasPrice);
      const gasCostUSD = this.weiToUSD(gasCost);

      return {
        gasLimit,
        gasCost,
        gasCostUSD
      };
    } catch (error) {
      console.error('Gas estimation failed:', error);
      
      // Return conservative estimates
      const fallbackGasLimit = BigNumber.from(500000);
      const currentGasPrice = gasPrice || await this.getOptimalGasPrice();
      const gasCost = fallbackGasLimit.mul(currentGasPrice);
      
      return {
        gasLimit: fallbackGasLimit,
        gasCost,
        gasCostUSD: this.weiToUSD(gasCost)
      };
    }
  }

  private getFallbackGasPrice(): GasPrice {
    // Conservative fallback gas prices in Gwei
    const base = this.gweiToBigNumber(30);
    const priority = this.gweiToBigNumber(1);

    return {
      safeLow: base.add(priority),
      standard: base.add(priority.mul(2)),
      fast: base.add(priority.mul(3)),
      instant: base.add(priority.mul(5)),
      baseFee: base,
      priorityFee: priority
    };
  }

  private gweiToBigNumber(gwei: number): BigNumber {
    return ethers.utils.parseUnits(gwei.toString(), 'gwei');
  }

  private weiToUSD(wei: BigNumber): number {
    const ether = parseFloat(ethers.utils.formatEther(wei));
    return ether * this.maticPriceUSD;
  }

  private calculateBreakEvenSpread(gasCostUSD: number, tradeAmountUSD: number = 10000): number {
    return (gasCostUSD / tradeAmountUSD) * 100; // Return as percentage
  }

  private convertGasCostToToken(gasCost: BigNumber, amountIn: BigNumber): BigNumber {
    // Simplified conversion - in production, you'd use actual price feeds
    // Assumes 1 MATIC = 0.5 USD and adjusts proportionally
    const gasCostEther = ethers.utils.formatEther(gasCost);
    const gasCostUSD = parseFloat(gasCostEther) * this.maticPriceUSD;
    
    // Very rough conversion - this should use actual price oracles
    const tokenValueUSD = 1; // Assume $1 per token unit for simplification
    const tokensNeeded = gasCostUSD / tokenValueUSD;
    
    return ethers.utils.parseUnits(tokensNeeded.toString(), 18);
  }

  private async updateMaticPrice(): Promise<void> {
    try {
      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd',
        { timeout: 5000 }
      );
      
      this.maticPriceUSD = response.data['matic-network']?.usd || 0.5;
    } catch (error) {
      console.warn('Failed to update MATIC price, using default:', error);
    }
  }

  setMaticPrice(priceUSD: number): void {
    this.maticPriceUSD = priceUSD;
  }

  getMaticPrice(): number {
    return this.maticPriceUSD;
  }

  // Advanced gas optimization strategies
  async getOptimalGasStrategy(
    urgency: 'low' | 'medium' | 'high',
    profitMarginPercent: number
  ): Promise<{
    gasPrice: BigNumber;
    maxAcceptableGas: BigNumber;
    estimatedConfirmationTime: number;
  }> {
    const gasPrice = await this.getOptimalGasPrice(urgency);
    
    // Calculate maximum acceptable gas based on profit margin
    const maxAcceptableGas = gasPrice.mul(100 + profitMarginPercent).div(100);
    
    // Estimate confirmation time based on urgency
    let estimatedConfirmationTime: number;
    switch (urgency) {
      case 'low':
        estimatedConfirmationTime = 30; // 30 seconds
        break;
      case 'medium':
        estimatedConfirmationTime = 15; // 15 seconds
        break;
      case 'high':
        estimatedConfirmationTime = 5; // 5 seconds
        break;
      default:
        estimatedConfirmationTime = 15;
    }

    return {
      gasPrice,
      maxAcceptableGas,
      estimatedConfirmationTime
    };
  }
}