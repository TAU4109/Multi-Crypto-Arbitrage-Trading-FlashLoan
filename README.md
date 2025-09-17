# Polygon Flash Loan Arbitrage Trading Bot

A sophisticated automated arbitrage trading bot that leverages Balancer V2 flash loans to capture profitable opportunities across multiple DEXs on Polygon network.

## 🚀 Features

- **Zero-Cost Flash Loans**: Utilizes Balancer V2's fee-free flash loans
- **Multi-DEX Integration**: Supports Uniswap V3, QuickSwap, and SushiSwap
- **MEV Protection**: Advanced protection against sandwich attacks and frontrunning
- **Risk Management**: Comprehensive circuit breakers and position sizing
- **Real-time Monitoring**: Telegram bot integration for alerts and control
- **Performance Tracking**: Detailed analytics and APY calculations
- **Gas Optimization**: Dynamic gas pricing and cost analysis

## 🏗️ Architecture

```
├── contracts/              # Smart contracts
│   ├── FlashArbitrageBot.sol
│   └── interfaces/
├── src/
│   ├── exchanges/          # DEX integrations
│   ├── services/           # Core services
│   │   ├── ArbitrageEngine.ts
│   │   ├── BatchQuoteEngine.ts
│   │   ├── GasManager.ts
│   │   ├── MEVProtection.ts
│   │   ├── RiskManager.ts
│   │   ├── PerformanceTracker.ts
│   │   └── TelegramBot.ts
│   └── types/              # TypeScript definitions
├── scripts/                # Deployment scripts
└── test/                   # Test files
```

## 📋 Prerequisites

- Node.js 18+
- Polygon wallet with MATIC for gas fees
- Telegram bot token and chat ID
- RPC endpoint (dRPC recommended for MEV protection)

## 🔧 Installation

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd Multi-Crypto-Arbitrage-Trading-FlashLoan
npm install
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Deploy smart contract:**
```bash
npm run compile
npm run deploy
```

4. **Build and start:**
```bash
npm run build
npm start
```

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PRIVATE_KEY` | Wallet private key | ✅ |
| `POLYGON_RPC_URL` | RPC endpoint | ✅ |
| `CONTRACT_ADDRESS` | Deployed contract address | ✅ |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | ✅ |
| `TELEGRAM_CHAT_ID` | Telegram chat ID | ✅ |
| `ADMIN_USER_ID` | Admin Telegram user ID | ✅ |
| `MIN_PROFIT_THRESHOLD` | Minimum profit (default: 0.02) | ❌ |
| `MAX_SLIPPAGE` | Maximum slippage (default: 0.5) | ❌ |
| `INITIAL_CAPITAL` | Starting capital (default: 10000) | ❌ |

### Risk Management Settings

```typescript
const riskLimits = {
  dailyLossLimit: 0.02,        // 2% daily loss limit
  consecutiveLossLimit: 5,     // Max consecutive losses
  volatilityLimit: 0.5,        // 50% volatility threshold
  gasThreshold: 100,           // 100 Gwei max gas price
  slippageLimit: 0.05,         // 5% max slippage
  positionSizeLimit: 0.1,      // 10% max position size
  drawdownLimit: 0.15,         // 15% max drawdown
  hourlyTradeLimit: 20         // 20 trades per hour max
};
```

## 🎯 Trading Strategy

### Target Token Pairs
- **WMATIC/USDC**: High volume, consistent spreads
- **WETH/USDT**: Cross-DEX arbitrage opportunities  
- **USDC/USDC.e**: Bridge arbitrage (native vs bridged USDC)
- **DAI/USDC**: Stablecoin spread trading
- **WBTC/WETH**: Volatile asset arbitrage

### Profit Thresholds
- **Minimum spread**: 0.15-0.25% for micro-arbitrage
- **Target spread**: 0.3-0.8% for optimal profitability
- **Gas consideration**: Dynamic based on network conditions
- **Success rate target**: 60-75%

## 📊 Monitoring & Control

### Telegram Commands

| Command | Description | Access |
|---------|-------------|--------|
| `/start` | Initialize bot and show menu | All |
| `/status` | Show current bot status | All |
| `/opportunities` | Display current opportunities | All |
| `/history` | Show recent trade history | All |
| `/balance` | Show wallet balance | Admin |
| `/settings` | Display bot configuration | Admin |
| `/emergency_stop` | 🛑 Emergency halt trading | Admin |
| `/resume` | ▶️ Resume trading operations | Admin |

### Health Check Endpoints

- `GET /health` - Application health status
- `GET /status` - Detailed bot statistics
- `GET /metrics` - Performance metrics
- `POST /emergency-stop` - Emergency shutdown

## 🛡️ Security Features

### MEV Protection
- Private mempool submission via dRPC
- Randomized transaction timing
- Gas price optimization to prevent frontrunning
- Sandwich attack detection

### Risk Management
- Circuit breakers for loss limits
- Position size controls
- Volatility monitoring
- Automated emergency stops

### Access Control
- Multi-signature wallet support
- Authorized caller restrictions
- Admin-only commands
- Rate limiting on all interfaces

## 📈 Performance Metrics

### Key Indicators
- **Success Rate**: Percentage of profitable trades
- **Sharpe Ratio**: Risk-adjusted returns
- **Maximum Drawdown**: Largest peak-to-trough decline
- **Calmar Ratio**: Annual return / max drawdown
- **Profit Factor**: Gross profit / gross loss

### Example Performance (Backtest)
```
📊 Performance Summary
- Total Trades: 247
- Success Rate: 68.4%
- Total Profit: $1,247.32
- Max Drawdown: 3.2%
- Sharpe Ratio: 2.14
- APY: 15.7%
```

## 🚀 Deployment

### Railway Deployment

1. **Connect Repository**: Link your GitHub repository to Railway
2. **Set Environment Variables**: Configure all required variables as Railway secrets
3. **Deploy**: Railway will automatically build and deploy

```bash
# Railway CLI deployment
railway login
railway link
railway up
```

### Docker Deployment

```bash
# Build image
docker build -t arbitrage-bot .

# Run container
docker run -d \
  --name arbitrage-bot \
  --env-file .env \
  -p 3000:3000 \
  arbitrage-bot
```

## 🔧 Development

### Testing
```bash
npm test                    # Run test suite
npm run test:coverage      # Coverage report
npm run test:integration   # Integration tests
```

### Linting
```bash
npm run lint               # ESLint check
npm run lint:fix           # Auto-fix issues
npm run typecheck          # TypeScript check
```

### Local Development
```bash
npm run dev                # Start in development mode
npm run watch              # Watch mode with auto-restart
```

## 📋 Pre-Launch Checklist

### Smart Contract
- [ ] Deploy to Polygon mainnet
- [ ] Verify contract on PolygonScan
- [ ] Set authorized callers
- [ ] Configure trade limits
- [ ] Test emergency functions

### Infrastructure  
- [ ] Configure Railway with sealed variables
- [ ] Set up private RPC with MEV protection
- [ ] Configure health checks and monitoring
- [ ] Set up Telegram bot with proper permissions
- [ ] Test error tracking and alerting

### Risk Management
- [ ] Configure circuit breakers
- [ ] Set position size limits (max 5% of portfolio)
- [ ] Configure daily loss limits (max 2%)
- [ ] Test emergency shutdown procedures
- [ ] Set up performance monitoring alerts

### Funding & Launch
- [ ] Fund wallet with initial capital ($10k+ recommended)
- [ ] Start with conservative parameters (0.3% min profit)
- [ ] Monitor for 48 hours before optimization
- [ ] Gradually increase trade sizes based on performance

## ⚠️ Risk Disclaimer

This trading bot involves significant financial risk:

- **Smart Contract Risk**: Potential bugs or exploits
- **Market Risk**: Volatile cryptocurrency markets
- **Technical Risk**: System failures or network issues
- **Regulatory Risk**: Changing legal requirements

**Use at your own risk. Never invest more than you can afford to lose.**

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🆘 Support

For issues and support:
- Create an issue on GitHub
- Join our Telegram support group
- Check the documentation wiki

---

**Built with ❤️ for the DeFi community**