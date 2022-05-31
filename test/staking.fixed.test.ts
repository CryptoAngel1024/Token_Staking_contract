import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, ContractTransaction, utils } from "ethers";
import crypto from "crypto";
import {
  StakingFixed,
  StakingFixed__factory,
  TestToken,
  TestToken__factory,
} from "../typechain";
import { evmSnapshot } from "./utils/snapshot";
import { increaseTime, nextBlockTimestamp } from "./utils/timeMachine";
import { getSecondsFromDays, equalWithEpsilon } from "../helpers/mathUtils";

import snapshot = evmSnapshot.snapshot;
import revert = evmSnapshot.revert;
import { addListener } from "process";
import { getAddress } from "ethers/lib/utils";

const fmt = (amount: BigNumber) => {
  return ethers.utils.formatUnits(amount);
};

describe("Staking Fixed", () => {
  let provider: any;
  let accounts: SignerWithAddress[];

  // [W]hite[L]isted accounts
  let owner: SignerWithAddress;

  // [R]egular accounts
  let rAccounts: SignerWithAddress[];

  let token: TestToken;

  let staking: StakingFixed;

  const AMOUNT_TO_STAKE = utils.parseUnits("100", 18);

  before(async () => {
    provider = ethers.provider;
    [owner, ...rAccounts] = await ethers.getSigners();

    token = await (await new TestToken__factory(owner).deploy()).deployed();

    staking = await (
      await new StakingFixed__factory(owner).deploy()
    ).deployed();
  });

  const increaseTimeDays = async (days: number) => {
    await increaseTime(days * 60 * 60 * 24);
  };

  interface CalculateStakeRewardParams {
    stakeTokenAddress?: string;
    stakedAmount?: BigNumber;
    stakeOption?: number;
  }

  const calculateStakeReward = async ({
    stakeTokenAddress = token.address,
    stakedAmount = AMOUNT_TO_STAKE,
    stakeOption = 0,
  }: CalculateStakeRewardParams): Promise<BigNumber> => {
    const option = (await staking.getStakeOptions(stakeTokenAddress))[
      stakeOption
    ];
    return stakedAmount.mul(option.bonusInPercentage).div(10000);
  };

  interface StakeParams {
    signer?: SignerWithAddress;
    stakeToken?: TestToken;
    stakeOption?: number;
    amountToStake?: BigNumber;
    amountToMintToStaking?: BigNumber;
  }

  const stake = async ({
    signer = rAccounts[0],
    stakeToken = token,
    stakeOption = 0,
    amountToStake = AMOUNT_TO_STAKE,
    amountToMintToStaking = amountToStake.mul(1000),
  }: StakeParams): Promise<ContractTransaction> => {
    await mintToAccountsAndApprove(
      signer,
      stakeToken,
      amountToStake,
      amountToMintToStaking
    );
    return staking
      .connect(signer)
      .stake(stakeToken.address, amountToStake, stakeOption);
  };

  const mintToAccountsAndApprove = async (
    signer: SignerWithAddress = rAccounts[0],
    token: TestToken,
    amountToStake: BigNumber,
    amountToMintOnContract: BigNumber
  ): Promise<{
    amountToStake: BigNumber;
    amountToMintOnContract: BigNumber;
  }> => {
    await token.connect(owner).mint(signer.address, amountToStake);

    await token.connect(owner).mint(staking.address, amountToMintOnContract);

    await token.connect(signer).approve(staking.address, amountToStake);

    return { amountToStake, amountToMintOnContract };
  };

  beforeEach(snapshot);

  afterEach(revert);

  describe("Single token staking", () => {
    before(async () => {
      // add token staking options
      await (await staking.addStakeOwner(token.address, owner.address)).wait();
      await (
        await staking.addStakeOptions(token.address, 30, 1_000, token.address)
      ).wait();
      await (
        await staking.addStakeOptions(token.address, 60, 3_000, token.address)
      ).wait();
      await (
        await staking.addStakeOptions(token.address, 90, 7_000, token.address)
      ).wait();
    });

    beforeEach(snapshot);

    afterEach(revert);

    it("Stake to MMPRO stake with insufficient tokens on contract to pay rewards", async function () {
      expect(await token.balanceOf(staking.address)).eq(BigNumber.from("0"));
      await expect(
        stake({ amountToMintToStaking: ethers.constants.Zero })
      ).revertedWith("!reserves");
    });

    it("Stake to MMPRO stake  with sufficient tokens on contract for rewards", async function () {
      await expect(stake({})).not.reverted;
    });

    it("Simple stake to MMPRO stake and check for rewards", async function () {
      const staker = rAccounts[0];
      const stakeOption = 0;

      await expect(stake({})).not.reverted;

      const stakes = await staking.getUserStakes(staker.address);
      const lastStake = stakes[stakeOption];

      expect(stakes.length).eq(1, "length != 1");

      const expectedRewards = await calculateStakeReward({});

      expect(expectedRewards).eq(lastStake.rewards);
      expect(
        (await staking.totalReservedAmount(token.address)).eq(
          AMOUNT_TO_STAKE.add(expectedRewards)
        )
      );
    });

    it("Try to withdraw tokens from MMPRO stake before stake period ends", async function () {
      const staker = rAccounts[0];

      await expect(stake({})).not.reverted;

      await expect(
        staking.connect(staker).withdraw(token.address, 0)
      ).revertedWith("!end");
    });

    it("Unstake tokens from MMRPO stake after stake period ends and get rewards", async function () {
      const staker = rAccounts[0];
      const stakeOption = 1;
      const option = (await staking.getStakeOptions(token.address))[
        stakeOption
      ];

      await stake({ stakeOption });

      await increaseTimeDays(option.periodInDays);

      await expect(staking.connect(staker).withdraw(token.address, 0)).not
        .reverted;

      const expectedRewardAmount = await calculateStakeReward({ stakeOption });

      const tokenBalanceAfterWithdraw = await token.balanceOf(staker.address);

      expect(
        tokenBalanceAfterWithdraw.eq(AMOUNT_TO_STAKE.add(expectedRewardAmount))
      ).eq(true);

      expect(await staking.totalReservedAmount(token.address)).eq(
        BigNumber.from(0)
      );
    });

    it("Withdraw from MMPRO staking when tokens are already were withdrawn", async function () {
      const staker = rAccounts[0];

      const stakeOption = 0;
      const option = await staking.stakeOptions(token.address, stakeOption);

      await stake({});

      await increaseTimeDays(option.periodInDays);

      await expect(staking.connect(rAccounts[0]).withdraw(token.address, 0)).not
        .reverted;
      await expect(
        staking.connect(rAccounts[0]).withdraw(token.address, 0)
      ).revertedWith("!index");
    });
  });

  describe("Add new option", async function () {
    it("Add new option", async () => {
      const optionsBefore = await staking.getStakeOptions(token.address);

      const stakeDays = 365;
      const stakeRewardPercentage = 10000;

      await expect(
        staking.addStakeOptions(
          token.address,
          stakeDays,
          stakeRewardPercentage,
          token.address
        )
      ).not.reverted;

      const optionsAfter = await staking.getStakeOptions(token.address);
      const createdOption = optionsAfter[optionsAfter.length - 1];

      expect(createdOption.periodInDays).eq(stakeDays);
      expect(createdOption.bonusInPercentage).eq(stakeRewardPercentage);
      expect(createdOption.rewardToken).eq(token.address);

      expect(optionsAfter.length).eq(optionsBefore.length + 1);
    });

    it("Create new option from non staking owner", async () => {
      await expect(
        staking
          .connect(rAccounts[0])
          .addStakeOptions(token.address, 10, 10_000, token.address)
      ).revertedWith("!tokenStakeOwner");
    });
  });

  describe("Update existing option", () => {
    const generateRandomAddress = () =>
      getAddress("0x" + crypto.randomBytes(20).toString("hex"));

    let stakeAdmin: SignerWithAddress;

    before(async () => {
      stakeAdmin = rAccounts[1];
      await expect(
        staking.transferStakeOwnership(token.address, stakeAdmin.address)
      ).not.reverted;
    });

    it("Update option and check for values", async () => {
      const stakeOptionIndex = 0;

      const rewardToken = generateRandomAddress();

      const setValues = {
        period: 10,
        bonusInPercentage: 10_000,
        rewardToken: rewardToken,
      };

      await expect(
        staking
          .connect(stakeAdmin)
          .setStakeOptions(
            token.address,
            stakeOptionIndex,
            setValues.period,
            setValues.bonusInPercentage,
            setValues.rewardToken
          )
      ).not.reverted;

      const info = await staking.stakeOptions(token.address, stakeOptionIndex);

      expect(info.periodInDays).eq(setValues.period);
      expect(info.bonusInPercentage).eq(setValues.bonusInPercentage);
      expect(info.rewardToken).eq(setValues.rewardToken);
    });

    it("Set Option admin from owner", async () => {
      await expect(
        staking.addStakeOwner(generateRandomAddress(), stakeAdmin.address)
      ).not.reverted;
    });

    it("Should failed: Set Option admin from non-owner", async () => {
      await expect(
        staking
          .connect(rAccounts[2])
          .addStakeOwner(token.address, rAccounts[0].address)
      ).revertedWith("Ownable: caller is not the owner");
    });

    it("Should failed: Set Option admin from owner when admin address is invalid", async () => {
      await expect(
        staking.addStakeOwner(token.address, ethers.constants.AddressZero)
      ).revertedWith("!owner");
    });

    it("Should failed: Set Option admin from owner when token address is invalid", async () => {
      await expect(
        staking.addStakeOwner(
          ethers.constants.AddressZero,
          rAccounts[0].address
        )
      ).revertedWith("!token");
    });

    it("Should failed: Set Option admin that is already admin from owner", async () => {
      const tokenAddress = generateRandomAddress();
      await expect(staking.addStakeOwner(tokenAddress, stakeAdmin.address)).not
        .reverted;
      await expect(
        staking.addStakeOwner(tokenAddress, stakeAdmin.address)
      ).revertedWith("already have owner");
    });

    it("Should failed: Update option by valid index from contract owner but not the stake owner", async () => {
      const stakeOptionIndex = 0;

      await expect(
        staking
          .connect(owner)
          .setStakeOptions(
            token.address,
            stakeOptionIndex,
            10,
            10_000,
            token.address
          )
      ).revertedWith("!tokenStakeOwner");
    });

    it("Update option by valid index from stake owner", async () => {
      const stakeOptionIndex = 0;

      const rewardTokenAddress = generateRandomAddress();

      await expect(
        staking
          .connect(stakeAdmin)
          .setStakeOptions(
            token.address,
            stakeOptionIndex,
            10,
            10_000,
            rewardTokenAddress
          )
      ).not.reverted;
    });

    it("Update option by invalid index", async () => {
      const stakeOptionIndex = 100;

      await expect(
        staking
          .connect(stakeAdmin)
          .setStakeOptions(
            token.address,
            stakeOptionIndex,
            10,
            10_000,
            token.address
          )
      ).revertedWith("!option");
    });

    it("Update option from non staking owner", async () => {
      const stakeOptionIndex = 1;

      await expect(
        staking
          .connect(rAccounts[0])
          .setStakeOptions(
            token.address,
            stakeOptionIndex,
            10,
            10_000,
            token.address
          )
      ).revertedWith("!tokenStakeOwner");
    });

    it("Transfer option ownership", async () => {});
  });
});
