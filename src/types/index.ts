import { BigNumber } from 'ethers';

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface QuoteResult {
  dex: string;
  amountIn: BigNumber;
  amountOut: BigNumber;
  gasEstimate: BigNumber;
  priceImpact: number;
  route?: string[];
}

export interface ArbitrageOpportunity {
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  amountIn: BigNumber;
  buyDex: string;
  sellDex: string;
  buyPrice: BigNumber;
  sellPrice: BigNumber;
  profit: BigNumber;
  profitPercent: number;
  gasEstimate: BigNumber;
  netProfit: BigNumber;
}

export interface TradeResult {
  successful: boolean;
  txHash?: string;
  profit: number;
  netProfit: number;
  amount: number;
  tokenA: string;
  tokenB: string;
  sourceDEX: string;
  targetDEX: string;
  gasUsed: number;
  gasCost: number;
  executionTime: number;
  blockNumber?: number;
  timestamp: Date;
}

export interface ExchangeConfig {
  name: string;
  router: string;
  factory?: string;
  quoter?: string;
  fee?: number;
  enabled: boolean;
}

export const TOKENS: Record<string, TokenInfo> = {
  USDC: {
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin'
  },
  'USDC.e': {
    address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    symbol: 'USDC.e',
    decimals: 6,
    name: 'Bridged USDC'
  },
  DAI: {
    address: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
    symbol: 'DAI',
    decimals: 18,
    name: 'Dai Stablecoin'
  },
  WETH: {
    address: '0x7ceb23fd6c56229b5d6a22f2e2e2d16c65d4cf4e',
    symbol: 'WETH',
    decimals: 18,
    name: 'Wrapped Ether'
  },
  WMATIC: {
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    symbol: 'WMATIC',
    decimals: 18,
    name: 'Wrapped Matic'
  },
  WBTC: {
    address: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
    symbol: 'WBTC',
    decimals: 8,
    name: 'Wrapped BTC'
  }
};

export const EXCHANGES: Record<string, ExchangeConfig> = {
  UNISWAP_V3: {
    name: 'Uniswap V3',
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    enabled: true
  },
  QUICKSWAP: {
    name: 'QuickSwap',
    router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
    factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
    quoter: '0xa15F0D7377B2A0C0c10db057f641beD21028FC89',
    enabled: true
  }
};