import * as dotenv from "dotenv";

import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-etherscan";
import "solidity-coverage";
import "hardhat-contract-sizer";
import "@typechain/hardhat";
import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-ethers";
import "hardhat-gas-reporter";
import "@nomiclabs/hardhat-solhint";
import { ethers } from "ethers";
dotenv.config();

const gwei = ethers.utils.parseUnits("1", "gwei").toNumber();

const config: HardhatUserConfig = {
  solidity: {
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
    compilers: [
      {
        version: "0.8.0",
      },
      {
        version: "0.6.12",
      },
    ],
    overrides: {
      "contracts/LaunchpadV2.sol": {
        version: "0.6.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
          evmVersion: "istanbul",
        },
      },
    },
  },
  networks: {
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545/",
      gasPrice: 10 * gwei,
      chainId: 97,
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    bscMainnet: {
      url: "https://bsc-dataseed.binance.org/",
      gasPrice: 10 * gwei,
      chainId: 56,
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    hardhat: {
      forking: {
        url: `https://eth-mainnet.alchemyapi.io/v2/${
          process.env.ACLHEMY_PROJECT_KEY ?? ""
        }`,
        blockNumber: 14145548,
      },
    },
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
  },
  contractSizer: {
    runOnCompile: true,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  mocha: {
    timeout: 1000000,
  },
};

export default config;
