import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Deploying FlashArbitrageBot to Polygon...");

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());

  // Deploy the FlashArbitrageBot contract
  const FlashArbitrageBot = await ethers.getContractFactory("FlashArbitrageBot");
  const flashArbitrageBot = await FlashArbitrageBot.deploy();

  await flashArbitrageBot.deployed();

  console.log("FlashArbitrageBot deployed to:", flashArbitrageBot.address);

  // Verify deployment
  console.log("Verifying deployment...");
  const code = await ethers.provider.getCode(flashArbitrageBot.address);
  if (code === "0x") {
    throw new Error("Contract deployment failed");
  }

  console.log("✅ Contract verified successfully");

  // Set up initial configuration
  console.log("Setting up initial configuration...");
  
  // Set authorized caller (deployer)
  const setCallerTx = await flashArbitrageBot.setAuthorizedCaller(deployer.address, true);
  await setCallerTx.wait();
  console.log("✅ Authorized caller set");

  // Set reasonable limits
  const setMaxTradeSizeTx = await flashArbitrageBot.setMaxTradeSize(
    ethers.utils.parseEther("100000") // $100k max trade size
  );
  await setMaxTradeSizeTx.wait();
  console.log("✅ Max trade size set");

  const setMinProfitTx = await flashArbitrageBot.setMinProfitThreshold(
    ethers.utils.parseEther("0.01") // 0.01 ETH minimum profit
  );
  await setMinProfitTx.wait();
  console.log("✅ Min profit threshold set");

  console.log("\n🎉 Deployment completed successfully!");
  console.log("\n📋 Deployment Summary:");
  console.log("=".repeat(50));
  console.log(`Contract Address: ${flashArbitrageBot.address}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network: ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Gas Used: ${(await flashArbitrageBot.deployTransaction.wait()).gasUsed.toString()}`);
  console.log(`Transaction Hash: ${flashArbitrageBot.deployTransaction.hash}`);
  
  console.log("\n⚙️ Configuration:");
  console.log(`Max Trade Size: 100,000 tokens`);
  console.log(`Min Profit Threshold: 0.01 ETH`);
  console.log(`Authorized Caller: ${deployer.address}`);

  console.log("\n📝 Next Steps:");
  console.log("1. Update your .env file with the contract address");
  console.log("2. Fund the contract with initial capital");
  console.log("3. Configure and start the arbitrage bot");
  console.log("4. Set up monitoring and alerts");

  // Save deployment info
  const deploymentInfo = {
    contractAddress: flashArbitrageBot.address,
    deployer: deployer.address,
    network: (await ethers.provider.getNetwork()).name,
    deploymentTime: new Date().toISOString(),
    transactionHash: flashArbitrageBot.deployTransaction.hash,
    blockNumber: (await flashArbitrageBot.deployTransaction.wait()).blockNumber
  };

  console.log("\n💾 Deployment info saved to deployment.json");
  const fs = require('fs');
  fs.writeFileSync('deployment.json', JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });