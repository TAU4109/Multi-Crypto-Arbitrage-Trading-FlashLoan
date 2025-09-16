// Railway対応版 Flash Loan Bot
const { ethers } = require("ethers");
const { Logger } = require("./utils/logger");
const { TelegramNotifier } = require("./utils/telegram");
const { ErrorHandler } = require("./utils/errorHandler");
const config = require("./config");

class RailwayFlashLoanBot {
  constructor() {
    // Railway環境変数から設定を読み込み
    this.isProduction = process.env.RAILWAY_ENVIRONMENT === "production";
    this.logger = new Logger(this.isProduction);
    this.notifier = new TelegramNotifier();
    this.errorHandler = new ErrorHandler();
    
    // ヘルスチェック用の状態
    this.health = {
      status: "starting",
      lastCheck: new Date(),
      totalTrades: 0,
      totalProfit: 0,
      uptime: process.uptime()
    };
    
    this.initializeProvider();
  }

  async initializeProvider() {
    try {
      // 複数のRPCエンドポイントでフェイルオーバー対応
      const rpcUrls = [
        process.env.PRIMARY_RPC_URL,
        process.env.BACKUP_RPC_URL_1,
        process.env.BACKUP_RPC_URL_2
      ].filter(url => url);

      for (const url of rpcUrls) {
        try {
          this.provider = new ethers.JsonRpcProvider(url);
          await this.provider.getBlockNumber();
          this.logger.info(`✅ Connected to RPC: ${url.substring(0, 30)}...`);
          break;
        } catch (error) {
          this.logger.warn(`Failed to connect to RPC: ${url.substring(0, 30)}...`);
        }
      }

      if (!this.provider) {
        throw new Error("All RPC endpoints failed");
      }

      // ウォレット初期化（暗号化されたキーを使用）
      const privateKey = await this.decryptPrivateKey(
        process.env.ENCRYPTED_PRIVATE_KEY
      );
      this.wallet = new ethers.Wallet(privateKey, this.provider);
      
      this.health.status = "running";
      await this.notifier.send("🚀 Bot started on Railway!");
      
    } catch (error) {
      await this.handleCriticalError(error);
    }
  }

  // Railway用の暗号化キー復号化
  async decryptPrivateKey(encryptedKey) {
    if (process.env.RAILWAY_ENVIRONMENT !== "production") {
      // 開発環境では平文のキーを使用
      return process.env.PRIVATE_KEY;
    }
    
    // 本番環境では暗号化されたキーを復号化
    const crypto = require('crypto');
    const algorithm = 'aes-256-gcm';
    const password = process.env.ENCRYPTION_PASSWORD;
    
    const encrypted = Buffer.from(encryptedKey, 'hex');
    const salt = encrypted.slice(0, 64);
    const iv = encrypted.slice(64, 80);
    const tag = encrypted.slice(80, 96);
    const text = encrypted.slice(96);
    
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(text, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  // エラー処理（Railway用）
  async handleCriticalError(error) {
    this.logger.error(`💥 Critical Error: ${error.message}`);
    this.health.status = "error";
    
    await this.notifier.send(
      `🚨 Bot Error on Railway!\n` +
      `Error: ${error.message}\n` +
      `Time: ${new Date().toISOString()}`
    );

    // Railway は自動的に再起動するが、一定時間待機
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // 再初期化を試みる
    if (this.errorHandler.shouldRestart(error)) {
      process.exit(1); // Railway が自動再起動
    }
  }

  // ヘルスチェックエンドポイント用
  getHealth() {
    return {
      ...this.health,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
  }

  async start() {
    // HTTPサーバーを起動（Railway のヘルスチェック用）
    const express = require('express');
    const app = express();
    
    app.get('/health', (req, res) => {
      res.json(this.getHealth());
    });
    
    app.get('/metrics', (req, res) => {
      res.json({
        trades: this.health.totalTrades,
        profit: this.health.totalProfit,
        status: this.health.status
      });
    });
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      this.logger.info(`📡 Health server running on port ${PORT}`);
    });

    // Flash Loan ボットを開始
    await this.startFlashLoanScanning();
  }

  async startFlashLoanScanning() {
    // メインのスキャンループ
    while (true) {
      try {
        await this.scanForOpportunities();
        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (error) {
        await this.handleError(error);
      }
    }
  }

  // 以下、Flash Loan ロジック...
}

// Railway 用のエントリーポイント
async function main() {
  const bot = new RailwayFlashLoanBot();
  
  // グレースフルシャットダウン
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    await bot.notifier.send("🛑 Bot shutting down on Railway");
    process.exit(0);
  });

  await bot.start();
}

main().catch(console.error);
