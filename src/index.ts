import express, { Request, Response } from 'express';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { ArbitrageEngine } from './services/ArbitrageEngine';
import { TelegramBot } from './services/TelegramBot';
import { RiskManager } from './services/RiskManager';
import { PerformanceTracker } from './services/PerformanceTracker';
import { MEVProtection } from './services/MEVProtection';
import winston from 'winston';

// Load environment variables
dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// Configuration validation
interface Config {
  privateKey: string;
  rpcUrl: string;
  wsUrl?: string;
  contractAddress?: string;
  minProfitThreshold: number;
  maxSlippage: number;
  maxTradeSize: number;
  dailyLossLimit: number;
  telegramBotToken: string;
  telegramChatId: string;
  adminUserId: string;
  port: number;
  initialCapital: number;
}

function validateConfig(): Config {
  const requiredEnvVars = [
    'PRIVATE_KEY',
    'POLYGON_RPC_URL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'ADMIN_USER_ID'
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  return {
    privateKey: process.env.PRIVATE_KEY!,
    rpcUrl: process.env.POLYGON_RPC_URL!,
    wsUrl: process.env.POLYGON_WS_URL,
    contractAddress: process.env.CONTRACT_ADDRESS,
    minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || '0.02'),
    maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '0.5'),
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE || '100000'),
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '0.02'),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
    telegramChatId: process.env.TELEGRAM_CHAT_ID!,
    adminUserId: process.env.ADMIN_USER_ID!,
    port: parseInt(process.env.PORT || '3000'),
    initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '10000')
  };
}

class ArbitrageBotApp {
  private app: express.Application;
  private config: Config;
  private provider!: ethers.providers.Provider;
  private wsProvider?: ethers.providers.WebSocketProvider;
  private arbitrageEngine!: ArbitrageEngine;
  private telegramBot!: TelegramBot;
  private riskManager!: RiskManager;
  private performanceTracker!: PerformanceTracker;
  private mevProtection!: MEVProtection;
  private isRunning = false;
  private healthStatus = {
    status: 'starting',
    timestamp: new Date().toISOString(),
    uptime: 0,
    version: '1.0.0',
    components: {
      rpc: false,
      websocket: false,
      telegram: false,
      arbitrageEngine: false,
      riskManager: false,
      performanceTracker: false
    }
  };

  constructor() {
    this.config = validateConfig();
    this.app = express();
    this.setupExpress();
    this.setupProviders();
    this.initializeServices();
  }

  private setupExpress(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      this.updateHealthStatus();
      const isHealthy = Object.values(this.healthStatus.components).every(status => status);
      
      res.status(isHealthy ? 200 : 503).json(this.healthStatus);
    });

    // Status endpoint
    this.app.get('/status', (req: Request, res: Response) => {
      const stats = this.arbitrageEngine.getStats();
      const metrics = this.performanceTracker.getMetrics();
      const riskMetrics = this.riskManager.getMetrics();

      res.json({
        bot: {
          isRunning: this.isRunning,
          uptime: process.uptime(),
          version: this.healthStatus.version
        },
        arbitrage: stats,
        performance: metrics,
        risk: riskMetrics,
        lastUpdated: new Date().toISOString()
      });
    });

    // Metrics endpoint for monitoring
    this.app.get('/metrics', (req: Request, res: Response) => {
      const report = this.performanceTracker.generatePerformanceReport();
      res.json(report);
    });

    // Emergency stop endpoint
    this.app.post('/emergency-stop', async (req: Request, res: Response) => {
      try {
        await this.emergencyStop();
        res.json({ success: true, message: 'Emergency stop activated' });
      } catch (error) {
        logger.error('Emergency stop failed:', error);
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.gracefulShutdown());
    process.on('SIGINT', () => this.gracefulShutdown());
  }

  private setupProviders(): void {
    this.provider = new ethers.providers.JsonRpcProvider(this.config.rpcUrl);
    
    if (this.config.wsUrl) {
      this.wsProvider = new ethers.providers.WebSocketProvider(this.config.wsUrl);
    }
  }

  private initializeServices(): void {
    // Initialize performance tracker
    this.performanceTracker = new PerformanceTracker(this.config.initialCapital);

    // Initialize risk manager
    this.riskManager = new RiskManager(
      {
        dailyLossLimit: this.config.dailyLossLimit,
        consecutiveLossLimit: 5,
        volatilityLimit: 0.5,
        gasThreshold: 100,
        slippageLimit: this.config.maxSlippage,
        positionSizeLimit: 10, // 10% of portfolio max
        drawdownLimit: 15, // 15% max drawdown
        hourlyTradeLimit: 20
      },
      this.config.initialCapital
    );

    // Initialize arbitrage engine
    this.arbitrageEngine = new ArbitrageEngine(this.provider, {
      minProfitThreshold: this.config.minProfitThreshold,
      maxSlippagePercent: this.config.maxSlippage,
      maxTradeAmountUSD: this.config.maxTradeSize,
      gasLimitGwei: 100,
      profitBufferPercent: 20,
      updateIntervalMs: 30000 // 30 seconds
    });

    // Initialize MEV protection
    this.mevProtection = new MEVProtection(
      this.provider,
      this.config.privateKey,
      {
        usePrivateMempool: true,
        randomDelayMin: 500,
        randomDelayMax: 2500,
        maxSlippageProtection: this.config.maxSlippage,
        enableCommitReveal: false,
        flashbotsEnabled: false
      }
    );

    // Initialize Telegram bot
    this.telegramBot = new TelegramBot(
      {
        botToken: this.config.telegramBotToken,
        chatId: this.config.telegramChatId,
        adminUserId: this.config.adminUserId,
        enableAlerts: true,
        alertThresholds: {
          minProfitUSD: 10,
          maxLossUSD: 100,
          errorAlerts: true
        }
      },
      this.arbitrageEngine
    );

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Arbitrage engine events
    this.arbitrageEngine.on('opportunities', (opportunities) => {
      logger.info(`Found ${opportunities.length} arbitrage opportunities`);
      
      // Record opportunities for analysis
      opportunities.forEach((opp: any) => this.performanceTracker.recordOpportunity(opp));
    });

    this.arbitrageEngine.on('tradeExecuted', async (result) => {
      logger.info(`Trade executed: ${result.successful ? 'SUCCESS' : 'FAILED'}`, result);
      
      // Record trade in performance tracker and risk manager
      this.performanceTracker.recordTrade(result);
      await this.riskManager.recordTrade(result);
    });

    this.arbitrageEngine.on('error', (error) => {
      logger.error('Arbitrage engine error:', error);
    });

    // Risk manager events
    this.riskManager.on('circuitBreakerTriggered', async (data) => {
      logger.error('Circuit breaker triggered:', data.reason);
      await this.arbitrageEngine.stop();
    });

    this.riskManager.on('riskWarning', (data) => {
      logger.warn('Risk warning:', data);
    });

    // Performance tracker events
    this.performanceTracker.on('performanceReport', (report) => {
      logger.info('Performance report generated', {
        totalTrades: report.summary.totalTrades,
        successRate: report.summary.successRate,
        totalProfit: report.summary.totalProfit
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      this.gracefulShutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    });
  }

  private updateHealthStatus(): void {
    this.healthStatus.timestamp = new Date().toISOString();
    this.healthStatus.uptime = process.uptime();

    // Check RPC connection
    this.provider.getBlockNumber()
      .then(() => { this.healthStatus.components.rpc = true; })
      .catch(() => { this.healthStatus.components.rpc = false; });

    // Check WebSocket connection
    if (this.wsProvider) {
      this.healthStatus.components.websocket = this.wsProvider.ready !== null;
    } else {
      this.healthStatus.components.websocket = true; // Not required
    }

    // Check other components
    this.healthStatus.components.arbitrageEngine = this.arbitrageEngine.getStats().isRunning;
    this.healthStatus.components.telegram = true; // Assume OK if no errors
    this.healthStatus.components.riskManager = !this.riskManager.getCircuitBreakerState().isTriggered;
    this.healthStatus.components.performanceTracker = true; // Always available

    const allHealthy = Object.values(this.healthStatus.components).every(status => status);
    this.healthStatus.status = allHealthy ? 'healthy' : 'degraded';
  }

  async start(): Promise<void> {
    try {
      logger.info('Starting Polygon Flash Arbitrage Bot...');

      // Validate connections
      await this.validateConnections();

      // Start services
      await this.telegramBot.start();
      this.healthStatus.components.telegram = true;

      await this.arbitrageEngine.start();
      this.healthStatus.components.arbitrageEngine = true;

      // Start HTTP server
      this.app.listen(this.config.port, () => {
        logger.info(`Server running on port ${this.config.port}`);
      });

      this.isRunning = true;
      this.healthStatus.status = 'healthy';

      logger.info('🚀 Arbitrage bot started successfully!');
      logger.info(`📊 Monitoring ${Object.keys(require('./types').TOKENS).length} token pairs`);
      logger.info(`💰 Initial capital: $${this.config.initialCapital.toLocaleString()}`);
      logger.info(`🎯 Min profit threshold: ${(this.config.minProfitThreshold * 100).toFixed(2)}%`);

    } catch (error) {
      logger.error('Failed to start bot:', error);
      throw error;
    }
  }

  private async validateConnections(): Promise<void> {
    // Test RPC connection
    try {
      const blockNumber = await this.provider.getBlockNumber();
      logger.info(`✅ RPC connected - Latest block: ${blockNumber}`);
      this.healthStatus.components.rpc = true;
    } catch (error) {
      logger.error('❌ RPC connection failed:', error);
      throw new Error('RPC connection validation failed');
    }

    // Test WebSocket connection if available
    if (this.wsProvider) {
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 10000);
          this.wsProvider!.once('ready', () => {
            clearTimeout(timeout);
            resolve(true);
          });
        });
        logger.info('✅ WebSocket connected');
        this.healthStatus.components.websocket = true;
      } catch (error) {
        logger.warn('⚠️ WebSocket connection failed, using HTTP only:', error);
        this.healthStatus.components.websocket = false;
      }
    }

    // Validate wallet
    try {
      const wallet = new ethers.Wallet(this.config.privateKey, this.provider);
      const balance = await wallet.getBalance();
      logger.info(`✅ Wallet connected: ${wallet.address}`);
      logger.info(`💰 Wallet balance: ${ethers.utils.formatEther(balance)} MATIC`);

      if (balance.lt(ethers.utils.parseEther('0.1'))) {
        logger.warn('⚠️ Low wallet balance - ensure sufficient MATIC for gas fees');
      }
    } catch (error) {
      logger.error('❌ Wallet validation failed:', error);
      throw new Error('Wallet validation failed');
    }
  }

  async emergencyStop(): Promise<void> {
    logger.warn('🛑 Emergency stop initiated');
    
    try {
      await this.arbitrageEngine.stop();
      await this.riskManager.emergencyStop();
      
      this.isRunning = false;
      this.healthStatus.status = 'stopped';
      
      logger.info('✅ Emergency stop completed');
    } catch (error) {
      logger.error('❌ Emergency stop failed:', error);
      throw error;
    }
  }

  private async gracefulShutdown(): Promise<void> {
    logger.info('🔄 Graceful shutdown initiated...');
    
    try {
      // Stop accepting new requests
      this.isRunning = false;
      
      // Stop services
      await this.arbitrageEngine.stop();
      await this.telegramBot.stop();
      
      // Close providers
      if (this.wsProvider) {
        this.wsProvider.destroy();
      }
      
      logger.info('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Graceful shutdown failed:', error);
      process.exit(1);
    }
  }
}

// Start the application
if (require.main === module) {
  const app = new ArbitrageBotApp();
  
  app.start().catch((error) => {
    console.error('Failed to start application:', error);
    process.exit(1);
  });
}

export default ArbitrageBotApp;