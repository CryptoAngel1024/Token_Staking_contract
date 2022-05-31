import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber, BigNumberish } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    StakingFlexible,
    StakingFlexible__factory,
    TestToken,
    TestToken__factory
} from "../typechain";

import { evmSnapshot } from './utils/snapshot';
import { increaseTime, nextBlockTimestamp } from './utils/timeMachine';
import { getSecondsFromDays, equalWithEpsilon } from "../helpers/mathUtils";
import { ERC20 } from '../typechain/ERC20';

import snapshot = evmSnapshot.snapshot;
import revert = evmSnapshot.revert;

let fmt = (amount: BigNumber): string => ethers.utils.formatUnits(amount);

describe("Flexible Staking", () => {
    let provider: any;
    let owner: SignerWithAddress;
    let rAccounts: SignerWithAddress[];
    let staking: StakingFlexible;
    let token: TestToken;

    const DEFAULT_EPD = ethers.utils.parseUnits("5000", 18);

    const DEFAULT_EPS = DEFAULT_EPD.div(24).div(60).div(60);

    const changeEmission = async (emissionPerDay: BigNumber, stakeToken: string = token.address): Promise<void> => {
        await (await staking.setEmissionPerDay(stakeToken, emissionPerDay)).wait();
    }

    const expectDoubleEq = (a: BigNumber, b: BigNumber, epsilon: BigNumber = DEFAULT_EPD.div(24 * 60 * 60).mul(10)) => expect((() => {
        const eq = equalWithEpsilon(a, b, epsilon); console.log('DQ:', { a: fmt(a), b: fmt(b) }); return eq
    })()).true;

    before(async () => {
        provider = ethers.provider;
        [owner, ...rAccounts] = await ethers.getSigners();
        token = await new TestToken__factory(owner).deploy();
        staking = await (await new StakingFlexible__factory(owner).deploy()).deployed();

        await staking.addStakeOwner(
            token.address,
            owner.address
        )

        await (await staking.initializeStake(token.address, DEFAULT_EPD, token.address)).wait();
    });

    beforeEach(snapshot);
    afterEach(revert);

    describe("Flexible term staking", () => {
        const mintAndApprove = async (mintTo: SignerWithAddress = rAccounts[0], _token: TestToken = token): Promise<{
            amountToStake: BigNumber;
            amountToMintOnContract: BigNumber;
        }> => {
            const amountToStake = ethers.utils.parseUnits("100", 18);
            const amountToMintOnContract = amountToStake.mul(10000);

            await _token
                .connect(owner)
                .mint(mintTo.address, amountToStake);

            await _token
                .connect(owner)
                .mint(staking.address, amountToMintOnContract);

            await _token
                .connect(mintTo)
                .approve(staking.address, amountToStake);

            return { amountToStake, amountToMintOnContract };
        };



        it("Set emission per second", async () => {
            const { amountToStake } = await mintAndApprove();
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);

            expect((await staking.tokenStakeInfo(token.address)).emissionPerSecond.eq(DEFAULT_EPS)).eq(true);

            const newEpd = DEFAULT_EPD.mul(2);
            await changeEmission(newEpd);

            expect((await staking.tokenStakeInfo(token.address)).emissionPerSecond.eq(newEpd.div(24 * 60 * 60)));
        });

        it("Should failed: Withdraw all with rewards when insufficient tokens on contract", async () => {
            const amountToStake = ethers.utils.parseUnits("100", 18);
            await token.mint(rAccounts[0].address, amountToStake);
            expect((await token.balanceOf(staking.address)).isZero()).eq(true);
            await token.connect(rAccounts[0]).approve(staking.address, amountToStake);
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            await increaseTime(getSecondsFromDays(1));
            await expect(staking.connect(rAccounts[0]).withdrawAllWithRewards(0)).revertedWith('ERC20: transfer amount exceeds balance');
        });

        it("Stake with sufficient tokens on contract", async () => {
            const { amountToStake, amountToMintOnContract } =
                await mintAndApprove();
            expect(
                (await token.balanceOf(staking.address)).eq(
                    amountToMintOnContract
                )
            ).eq(true);
            await expect(staking.connect(rAccounts[0]).stake(token.address, amountToStake)).not.reverted;
        });

        it("Claim rewards after 1 day", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBefore = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance before staking:", fmt(balanceBefore));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            const balanceAfterStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after staking:", fmt(balanceAfterStaking));
            // console.log("Emission:", fmt(await staking.emissionPerSecond()));
            await increaseTime(getSecondsFromDays(1));
            await staking.connect(rAccounts[0]).claimRewards(0);
            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, DEFAULT_EPD);
        });

        it("Claim rewards after 10 days", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBefore = await token.balanceOf(rAccounts[0].address);
            const stakeDays = 10;
            // console.log("Balance before staking:", fmt(balanceBefore));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            const balanceAfterStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after staking:", fmt(balanceAfterStaking));
            // console.log("Emission:", fmt(await staking.emissionPerSecond()));
            await increaseTime(getSecondsFromDays(stakeDays));
            await staking.connect(rAccounts[0]).claimRewards(0);
            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, DEFAULT_EPD.mul(stakeDays));
        });

        it("Withdraw rewards after 10 days with changed emission", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBefore = await token.balanceOf(rAccounts[0].address);

            // console.log("Balance before staking:", fmt(balanceBefore));
            // console.log("Amount to stake:", fmt(amountToStake));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            const balanceAfterStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after staking:", fmt(balanceAfterStaking));

            await increaseTime(getSecondsFromDays(5));
            // console.log("Rewards: ", fmt(await calculateUserRewards(rAccounts[0], 0)))
            await changeEmission(ethers.utils.parseUnits("10000", 18));
            await increaseTime(getSecondsFromDays(5));
            // console.log("Rewards: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await staking.connect(rAccounts[0]).claimRewards(0);

            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, ethers.utils.parseUnits("75000", 18));
        });

        it("Double stake with same emission", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBeforeFirst = await token.balanceOf(rAccounts[0].address);

            // console.log("Balance before first staking:", fmt(balanceBeforeFirst));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake.div(10));
            const balanceAfterFirstStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after first staking:", fmt(balanceAfterFirstStaking));

            // console.log("Earned stake 1: ", fmt(await calculateUserRewards(rAccounts[0], 0)));
            await increaseTime(getSecondsFromDays(5));
            // console.log("Earned stake 1: ", fmt(await calculateUserRewards(rAccounts[0], 0)));

            await staking.connect(rAccounts[0]).stake(token.address, balanceAfterFirstStaking);

            const balanceAfterSecondStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after second staking:", fmt(balanceAfterSecondStaking));
            await increaseTime(getSecondsFromDays(5));
            // console.log("Earned stake 2: ", fmt(await calculateUserRewards(rAccounts[0], 0)))
            // console.log("Earned stake 1: ", fmt(await calculateUserRewards(rAccounts[0], 1)));

            await staking.connect(rAccounts[0]).claimRewards(0);
            await staking.connect(rAccounts[0]).claimRewards(1);

            const balanceAfterClaim = await token.balanceOf(rAccounts[0].address);
            const expectedBalanceAfterClaim = DEFAULT_EPD.mul(10);

            // we are only stakers in option so we takes all the DEFAULT_EPD in any way
            // console.log("Expected rewards after claim rewards", fmt(expectedBalanceAfterClaim));
            expectDoubleEq(balanceAfterClaim, expectedBalanceAfterClaim, ethers.utils.parseUnits('10', 18));

            await increaseTime(getSecondsFromDays(5));

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);

            const expectedWithdrew = DEFAULT_EPD.mul(5);

            // console.log("Balance after withdrawAllWithRewards:", fmt(balanceAfterWithdraw));

            expectDoubleEq(
                await token.balanceOf(rAccounts[0].address),
                expectedBalanceAfterClaim.add(expectedWithdrew).add(amountToStake),
                ethers.utils.parseUnits('50', 18)
            );
        });


        it("Double stake with different emission", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBeforeFirst = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance before first staking:", fmt(balanceBeforeFirst));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake.div(10));
            const balanceAfterFirstStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after first staking:", fmt(balanceAfterFirstStaking));

            await increaseTime(getSecondsFromDays(5));

            await staking.connect(rAccounts[0]).stake(token.address, balanceAfterFirstStaking);

            await changeEmission(ethers.utils.parseUnits("10000", 18));

            const balanceAfterSecondStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after second staking:", fmt(balanceAfterSecondStaking));
            await increaseTime(getSecondsFromDays(5));

            // console.log("Earned: ",
            // fmt((await calculateUserRewards(rAccounts[0], 0))
            // .add(await calculateUserRewards(rAccounts[0], 1))))

            await staking.connect(rAccounts[0]).claimRewards(0);
            await staking.connect(rAccounts[0]).claimRewards(1);

            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, ethers.utils.parseUnits("75000", 18));

            // console.log('CalcRewards: ', (await staking.calcRewardsByIndex(rAccounts[0].address, 0)));

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);
            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);

            const balanceAfterWithdraw = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawAllWithRewards:", fmt(balanceAfterWithdraw));
            expectDoubleEq(balanceAfterWithdraw, balanceAfterWithdrawalRewards.add(amountToStake));
        });

        it("Withdraw staked and rewards after 1 day", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBefore = await token.balanceOf(rAccounts[0].address);

            // console.log("Balance before staking:", fmt(balanceBefore));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            const balanceAfterStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after staking:", fmt(balanceAfterStaking));

            await increaseTime(getSecondsFromDays(1));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);
            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, ethers.utils.parseUnits("5100", 18));
        });

        it("Withdraw staked and rewards all after 10 days", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBefore = await token.balanceOf(rAccounts[0].address);

            // console.log("Balance before staking:", fmt(balanceBefore));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            const balanceAfterStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after staking:", fmt(balanceAfterStaking));

            await increaseTime(getSecondsFromDays(10));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);
            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, ethers.utils.parseUnits("50100", 18));
        });

        it("Withdraw staked and rewards after 10 days with changed emission", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBefore = await token.balanceOf(rAccounts[0].address);

            // console.log("Balance before staking:", fmt(balanceBefore));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            const balanceAfterStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after staking:", fmt(balanceAfterStaking));

            await increaseTime(getSecondsFromDays(5));

            await changeEmission(ethers.utils.parseUnits("10000", 18));

            await increaseTime(getSecondsFromDays(5));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);

            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, ethers.utils.parseUnits("75100", 18));
        });

        it("Double withdrawal", async () => {
            const { amountToStake } = await mintAndApprove();
            await changeEmission(DEFAULT_EPD);
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);

            await increaseTime(getSecondsFromDays(1));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await expect(staking.connect(rAccounts[0]).withdrawAllWithRewards(0)).not.reverted;
            await expect(staking.connect(rAccounts[0]).withdrawAllWithRewards(0)).revertedWith("!index");
        });

        it("Double reward withdrawal after rewards claim", async () => {
            const { amountToStake } = await mintAndApprove();
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            await increaseTime(getSecondsFromDays(1));

            await staking.connect(rAccounts[0]).claimRewards(0);

            await expect(staking.connect(rAccounts[0]).withdrawAllWithRewards(0)).not.reverted;
            await expect(staking.connect(rAccounts[0]).withdrawAllWithRewards(0)).revertedWith("!index");
        });

        it("Stake after withdrawAllWithRewards", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBeforeFirst = await token.balanceOf(rAccounts[0].address);

            // console.log("Balance before first staking:", fmt(balanceBeforeFirst));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake.div(10));
            const balanceAfterFirstStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after first staking:", fmt(balanceAfterFirstStaking));

            await increaseTime(getSecondsFromDays(5));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))


            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);

            const balanceBeforeSecond = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance before second staking:", fmt(balanceBeforeSecond));
            expectDoubleEq(balanceBeforeSecond, ethers.utils.parseUnits("25100", 18));

            await token
                .connect(rAccounts[0])
                .approve(staking.address, balanceBeforeSecond.sub(amountToStake));

            await staking.connect(rAccounts[0]).stake(token.address, balanceBeforeSecond.sub(amountToStake));
            const balanceAfterSecondStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after second staking:", fmt(balanceAfterSecondStaking));

            await increaseTime(getSecondsFromDays(5));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);
            const balanceAfterWithdrawalRewards = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawal rewards:", fmt(balanceAfterWithdrawalRewards));
            expectDoubleEq(balanceAfterWithdrawalRewards, ethers.utils.parseUnits("50100", 18));
        });

        it("Stake/claim/claim/withdrawAllWithRewards/withdrawAllWithRewards", async () => {
            const { amountToStake } = await mintAndApprove();
            const balanceBefore = await token.balanceOf(rAccounts[0].address);
            await changeEmission(DEFAULT_EPD);
            // console.log("Balance before staking:", fmt(balanceBefore));
            await staking.connect(rAccounts[0]).stake(token.address, amountToStake);
            const balanceAfterFirstStaking = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after staking:", fmt(balanceAfterFirstStaking));

            await increaseTime(getSecondsFromDays(5));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await staking.connect(rAccounts[0]).claimRewards(0);
            const balanceAfterFirstClaim = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after claim:", fmt(balanceAfterFirstClaim));

            await increaseTime(getSecondsFromDays(10));

            // console.log("Earned: ", fmt(await calculateUserRewards(rAccounts[0], 0)))

            await staking.connect(rAccounts[0]).claimRewards(0);
            const balanceAfter2ndClaim = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance 2nd claim:", fmt(balanceAfter2ndClaim));

            await staking.connect(rAccounts[0]).withdrawAllWithRewards(0);

            const balanceAfterWithdraw = await token.balanceOf(rAccounts[0].address);
            // console.log("Balance after withdrawAllWithRewards:", fmt(balanceAfterWithdraw));

            expectDoubleEq(balanceAfterWithdraw, ethers.utils.parseUnits("75100", 18));

            await expect(staking.connect(rAccounts[0]).withdrawAllWithRewards(0)).revertedWith("!index");
        });
    });
});
