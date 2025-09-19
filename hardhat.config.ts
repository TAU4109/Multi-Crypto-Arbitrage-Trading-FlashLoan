import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-waffle";
import dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    polygon: {
      url: "https://polygon-rpc.com",
      accounts: [`0x616ab46951874d297de93f059b44055a7fb85909b8b46d0b7befd29eaed361c3`],
      chainId: 137,
    },
    polygonMumbai: {
      url: "https://rpc.ankr.com/polygon_mumbai",
      accounts: process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.length === 66 ? [process.env.PRIVATE_KEY] : ["0x0000000000000000000000000000000000000000000000000000000000000001"],
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;