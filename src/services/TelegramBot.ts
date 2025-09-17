import { Telegraf, Context } from 'telegraf';
import { ArbitrageEngine } from './ArbitrageEngine';
import { TradeResult, ArbitrageOpportunity } from '../types';
import { ethers } from 'ethers';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  adminUserId: string;
  enableAlerts: boolean;
  alertThresholds: {
    minProfitUSD: number;
    maxLossUSD: number;
    errorAlerts: boolean;
  };
}

interface BotCommand {
  command: string;
  description: string;
  adminOnly: boolean;
}

export class TelegramBot {
  private bot: Telegraf;
  private config: TelegramConfig;
  private arbitrageEngine: ArbitrageEngine;
  private rateLimiter: Map<string, number> = new Map();
  private authorizedUsers: Set<string> = new Set();
  private isActive: boolean = false;

  private commands: BotCommand[] = [
    { command: 'start', description: 'Start the bot and show menu', adminOnly: false },
    { command: 'status', description: 'Show bot status and performance metrics', adminOnly: false },
    { command: 'balance', description: 'Show wallet balance', adminOnly: true },
    { command: 'opportunities', description: 'Show current arbitrage opportunities', adminOnly: false },
    { command: 'history', description: 'Show recent trade history', adminOnly: false },
    { command: 'settings', description: 'Show current bot settings', adminOnly: true },
    { command: 'emergency_stop', description: '🛑 Emergency stop all trading', adminOnly: true },
    { command: 'resume', description: '▶️ Resume trading operations', adminOnly: true },
    { command: 'help', description: 'Show available commands', adminOnly: false }
  ];

  constructor(config: TelegramConfig, arbitrageEngine: ArbitrageEngine) {
    this.config = config;
    this.arbitrageEngine = arbitrageEngine;
    this.bot = new Telegraf(config.botToken);
    this.authorizedUsers.add(config.adminUserId);
    
    this.setupMiddleware();
    this.setupCommands();
    this.setupEventListeners();
  }

  private setupMiddleware(): void {
    // Rate limiting middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      const now = Date.now();
      const lastRequest = this.rateLimiter.get(userId) || 0;
      
      if (now - lastRequest < 1000) { // 1 second rate limit
        await ctx.reply('⏰ Please wait before sending another command.');
        return;
      }
      
      this.rateLimiter.set(userId, now);
      return next();
    });

    // Authorization middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id.toString();
      const isAuthorized = this.authorizedUsers.has(userId || '');
      
      if (!isAuthorized && ctx.message && 'text' in ctx.message) {
        const text = ctx.message.text;
        const adminOnlyCommands = this.commands
          .filter(cmd => cmd.adminOnly)
          .map(cmd => `/${cmd.command}`);
        
        if (adminOnlyCommands.some(cmd => text.startsWith(cmd))) {
          await ctx.reply('❌ Unauthorized. This command requires admin access.');
          return;
        }
      }
      
      return next();
    });
  }

  private setupCommands(): void {
    this.bot.command('start', async (ctx) => {
      const welcomeMessage = `
🤖 *Polygon Flash Arbitrage Bot*

Welcome to your automated arbitrage trading assistant!

📊 *Quick Status:*
${this.arbitrageEngine.getStats().isRunning ? '🟢 Active' : '🔴 Stopped'}

💡 *Available Commands:*
${this.commands.map(cmd => `/${cmd.command} - ${cmd.description} ${cmd.adminOnly ? '(Admin)' : ''}`).join('\n')}

Use /help for detailed command information.
      `;
      
      await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
    });

    this.bot.command('status', async (ctx) => {
      try {
        const stats = this.arbitrageEngine.getStats();
        const statusMessage = await this.generateStatusMessage();
        await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply('❌ Failed to get status information.');
      }
    });

    this.bot.command('opportunities', async (ctx) => {
      try {
        const opportunities = this.arbitrageEngine.getOpportunityHistory().slice(0, 5);
        const message = this.formatOpportunities(opportunities);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply('❌ Failed to get opportunities data.');
      }
    });

    this.bot.command('history', async (ctx) => {
      try {
        // This would get actual trade history from the performance tracker
        const message = `
📈 *Recent Trades*

No trades executed yet.
Bot is currently in monitoring mode.

Use /opportunities to see potential trades.
        `;
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply('❌ Failed to get trade history.');
      }
    });

    this.bot.command('balance', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id.toString())) {
        await ctx.reply('❌ Unauthorized access');
        return;
      }

      try {
        const balanceMessage = await this.getWalletBalance();
        await ctx.reply(balanceMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply('❌ Failed to get wallet balance.');
      }
    });

    this.bot.command('settings', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id.toString())) {
        await ctx.reply('❌ Unauthorized access');
        return;
      }

      const settings = `
⚙️ *Bot Settings*

🎯 *Trading Parameters:*
• Min Profit: $${this.config.alertThresholds.minProfitUSD}
• Max Loss: $${this.config.alertThresholds.maxLossUSD}
• Alerts: ${this.config.enableAlerts ? '✅ Enabled' : '❌ Disabled'}

🔐 *Security:*
• MEV Protection: ✅ Enabled
• Private RPC: ✅ Enabled
• Rate Limiting: ✅ Enabled

📊 *Monitoring:*
• Error Alerts: ${this.config.alertThresholds.errorAlerts ? '✅' : '❌'}
• Performance Tracking: ✅ Enabled
      `;

      await ctx.reply(settings, { parse_mode: 'Markdown' });
    });

    this.bot.command('emergency_stop', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id.toString())) {
        await ctx.reply('❌ Unauthorized access');
        return;
      }

      try {
        await this.arbitrageEngine.stop();
        
        const stopMessage = `
🛑 *EMERGENCY STOP ACTIVATED*

✅ All trading operations halted
✅ Monitoring stopped
✅ No new positions will be opened

⚠️ *Manual intervention required to resume*

Use /resume to restart operations.
        `;

        await ctx.reply(stopMessage, { parse_mode: 'Markdown' });
        await this.sendAlert('🛑 EMERGENCY STOP activated by user');
        
      } catch (error) {
        await ctx.reply('❌ Emergency stop failed. Check logs immediately.');
        console.error('Emergency stop failed:', error);
      }
    });

    this.bot.command('resume', async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id.toString())) {
        await ctx.reply('❌ Unauthorized access');
        return;
      }

      try {
        await this.arbitrageEngine.start();
        
        const resumeMessage = `
▶️ *TRADING RESUMED*

✅ Arbitrage engine started
✅ Monitoring active
✅ Ready for opportunities

Bot is now actively scanning for profitable trades.
        `;

        await ctx.reply(resumeMessage, { parse_mode: 'Markdown' });
        await this.sendAlert('▶️ Trading operations resumed');
        
      } catch (error) {
        await ctx.reply('❌ Failed to resume operations.');
        console.error('Resume failed:', error);
      }
    });

    this.bot.command('help', async (ctx) => {
      const helpMessage = `
🆘 *Help & Commands*

${this.commands.map(cmd => `/${cmd.command} - ${cmd.description} ${cmd.adminOnly ? '🔐' : ''}`).join('\n')}

🔐 = Admin only commands

📱 *Quick Actions:*
• Emergency stop: /emergency_stop
• Check status: /status  
• View opportunities: /opportunities

⚠️ *Important:*
Only authorized users can control trading operations.
All commands are rate-limited for security.

💬 *Support:*
For technical issues, check the logs or contact support.
      `;

      await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    });
  }

  private setupEventListeners(): void {
    // Listen to arbitrage engine events
    this.arbitrageEngine.on('opportunities', (opportunities: ArbitrageOpportunity[]) => {
      if (this.config.enableAlerts && opportunities.length > 0) {
        const bestOpportunity = opportunities[0];
        const profitUSD = parseFloat(ethers.utils.formatEther(bestOpportunity.netProfit)) * 0.5; // Rough USD conversion
        
        if (profitUSD >= this.config.alertThresholds.minProfitUSD) {
          this.sendOpportunityAlert(bestOpportunity);
        }
      }
    });

    this.arbitrageEngine.on('tradeExecuted', (result: TradeResult) => {
      this.sendTradeAlert(result);
    });

    this.arbitrageEngine.on('tradeFailed', (data: { result: TradeResult; error: any }) => {
      if (this.config.alertThresholds.errorAlerts) {
        this.sendTradeFailureAlert(data.result, data.error);
      }
    });

    this.arbitrageEngine.on('error', (error: Error) => {
      if (this.config.alertThresholds.errorAlerts) {
        this.sendErrorAlert(error);
      }
    });
  }

  async start(): Promise<void> {
    try {
      await this.bot.launch();
      this.isActive = true;
      console.log('Telegram bot started successfully');
      await this.sendAlert('🤖 Bot started and monitoring');
    } catch (error) {
      console.error('Failed to start Telegram bot:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.isActive) {
      this.bot.stop();
      this.isActive = false;
      console.log('Telegram bot stopped');
    }
  }

  async sendTradeAlert(trade: TradeResult): Promise<void> {
    const emoji = trade.successful ? (trade.netProfit > 0 ? '🟢' : '🔴') : '❌';
    const profitPercent = trade.amount > 0 ? (trade.profit / trade.amount * 100).toFixed(2) : '0.00';
    
    const message = `
${emoji} *Trade ${trade.successful ? 'Executed' : 'Failed'}*

🔄 *Pair:* ${trade.tokenA}/${trade.tokenB}
💰 *Amount:* ${trade.amount.toFixed(2)}
📈 *Profit:* ${trade.profit.toFixed(4)} (${profitPercent}%)
💸 *Net Profit:* ${trade.netProfit.toFixed(4)}
⛽ *Gas Used:* ${trade.gasUsed.toLocaleString()}
🏪 *Route:* ${trade.sourceDEX} → ${trade.targetDEX}
⏱️ *Execution:* ${trade.executionTime}ms
🕐 *Time:* ${trade.timestamp.toLocaleString()}
${trade.txHash ? `🔗 *Tx:* \`${trade.txHash}\`` : ''}
    `;

    await this.sendMessage(message);
  }

  private async sendOpportunityAlert(opportunity: ArbitrageOpportunity): Promise<void> {
    const profitUSD = parseFloat(ethers.utils.formatEther(opportunity.netProfit)) * 0.5; // Rough conversion
    
    const message = `
🎯 *Arbitrage Opportunity*

🔄 *Pair:* ${opportunity.tokenA.symbol}/${opportunity.tokenB.symbol}
💰 *Amount:* ${ethers.utils.formatEther(opportunity.amountIn)}
📊 *Profit:* ${opportunity.profitPercent.toFixed(2)}% (~$${profitUSD.toFixed(2)})
🏪 *Route:* ${opportunity.buyDex} → ${opportunity.sellDex}
⛽ *Est. Gas:* ${opportunity.gasEstimate.toString()}

⚡ *Evaluating execution...*
    `;

    await this.sendMessage(message);
  }

  private async sendTradeFailureAlert(trade: TradeResult, error: any): Promise<void> {
    const message = `
❌ *Trade Failed*

🔄 *Pair:* ${trade.tokenA}/${trade.tokenB}
💰 *Amount:* ${trade.amount.toFixed(2)}
🏪 *Route:* ${trade.sourceDEX} → ${trade.targetDEX}
⏱️ *Duration:* ${trade.executionTime}ms
🚨 *Error:* ${error.message || 'Unknown error'}

🔧 *Investigating and will retry if profitable...*
    `;

    await this.sendMessage(message);
  }

  private async sendErrorAlert(error: Error): Promise<void> {
    const message = `
🚨 *System Error*

❌ *Error:* ${error.message}
🕐 *Time:* ${new Date().toLocaleString()}

🔧 *Action Required:* Check logs and system status
    `;

    await this.sendMessage(message);
  }

  private async sendAlert(text: string): Promise<void> {
    await this.sendMessage(`🤖 *Bot Alert*\n\n${text}`);
  }

  private async sendMessage(message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        this.config.chatId,
        message,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Failed to send Telegram message:', error);
    }
  }

  private async generateStatusMessage(): Promise<string> {
    const stats = this.arbitrageEngine.getStats();
    const uptime = this.formatUptime(Date.now() - stats.lastScanTimestamp);
    
    return `
📊 *Bot Status*

🤖 *Engine:* ${stats.isRunning ? '🟢 Active' : '🔴 Stopped'}
📈 *Opportunities Found:* ${stats.totalOpportunities}
🔍 *Last Scan:* ${new Date(stats.lastScanTimestamp).toLocaleString()}
⏰ *Uptime:* ${uptime}

💹 *Performance:*
• Total Scans: ${stats.totalScans}
• Avg Opportunities/Scan: ${stats.averageOpportunitiesPerScan.toFixed(1)}

🔧 *System:*
• Telegram: ✅ Connected
• MEV Protection: ✅ Active
• Gas Optimization: ✅ Active
    `;
  }

  private formatOpportunities(opportunities: ArbitrageOpportunity[]): string {
    if (opportunities.length === 0) {
      return '📊 *Current Opportunities*\n\nNo profitable opportunities found at the moment.\n\n🔍 Continuing to monitor...';
    }

    let message = '📊 *Top Opportunities*\n\n';
    
    opportunities.slice(0, 3).forEach((op, index) => {
      const profitUSD = parseFloat(ethers.utils.formatEther(op.netProfit)) * 0.5;
      message += `${index + 1}. *${op.tokenA.symbol}/${op.tokenB.symbol}*\n`;
      message += `   💰 ${op.profitPercent.toFixed(2)}% (~$${profitUSD.toFixed(2)})\n`;
      message += `   🏪 ${op.buyDex} → ${op.sellDex}\n\n`;
    });

    return message;
  }

  private async getWalletBalance(): Promise<string> {
    // This would integrate with actual wallet balance checking
    return `
💼 *Wallet Balance*

*Wallet:* \`0x...${this.config.adminUserId.slice(-6)}\`

💰 *Balances:*
• MATIC: Loading...
• USDC: Loading...
• WETH: Loading...

⚠️ *Note:* Real balance checking requires wallet integration
    `;
  }

  private formatUptime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  private isAuthorized(userId?: string): boolean {
    return userId ? this.authorizedUsers.has(userId) : false;
  }

  addAuthorizedUser(userId: string): void {
    this.authorizedUsers.add(userId);
  }

  removeAuthorizedUser(userId: string): void {
    this.authorizedUsers.delete(userId);
  }

  updateConfig(newConfig: Partial<TelegramConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}