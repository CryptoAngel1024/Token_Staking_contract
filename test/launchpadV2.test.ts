import { ethers } from "hardhat";
import { expect, util } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, BigNumberish, utils } from "ethers";

import {
    PassTicketMarket,
    PassTicket,
    PassTicket__factory,
    PassTicketMarket__factory,
    TestToken,
    TestToken__factory,
    LaunchpadV2,
    LaunchpadV2__factory,
} from "../typechain";
import { evmSnapshot } from './utils/snapshot';
import { increaseTime, nextBlockTimestamp } from './utils/timeMachine';
import { IUniswapV2Router02 } from '../typechain/IUniswapV2Router02';
import { IUniswapV2Factory } from '../typechain/IUniswapV2Factory';
import { IUniswapV2Router02__factory } from '../typechain/factories/IUniswapV2Router02__factory';
import { IUniswapV2Factory__factory } from '../typechain/factories/IUniswapV2Factory__factory';
import { IUniswapV2Pair } from '../typechain/IUniswapV2Pair';
import { IUniswapV2Pair__factory } from '../typechain/factories/IUniswapV2Pair__factory';
import { equalWithEpsilon } from '../helpers/mathUtils';
import { IERC20 } from '../typechain/IERC20';

import snapshot = evmSnapshot.snapshot;
import revert = evmSnapshot.revert;

const curTimeToBigNumberTimestamp = () => {
    return BigNumber.from(Math.floor(new Date().getTime() / 1000));
}

enum DepositTokenType {
    MMPRO = 0,
    MMPRO_BUSD_LP = 1,
}


describe('LaunchpadV2', () => {
    /// requires EHT mainnet fork enabled
    const uniswapV2RouterAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

    let owner: SignerWithAddress;
    let rAccounts: SignerWithAddress[]

    let stable: TestToken
    let token: TestToken;
    let passTicket: PassTicket;
    let passTicketMarket: PassTicketMarket;
    let launchpad: LaunchpadV2;

    let lToken: TestToken;

    let swapRouter: IUniswapV2Router02;
    let swapFactory: IUniswapV2Factory;

    let lp: IUniswapV2Pair;

    const tokenInPoolAmount = utils.parseUnits('1000');
    const stableInPoolAmount = utils.parseUnits('2000');

    before(async () => {
        await nextBlockTimestamp(curTimeToBigNumberTimestamp().toNumber(), true);

        [owner, ...rAccounts] = await ethers.getSigners();

        // deploy contracts
        token = await (await new TestToken__factory(owner).deploy()).deployed();
        stable = await (await new TestToken__factory(owner).deploy()).deployed();
        lToken = await (await new TestToken__factory(owner).deploy()).deployed();

        await (await lToken.mint(owner.address, utils.parseUnits('100000'))).wait();

        swapRouter = IUniswapV2Router02__factory.connect(uniswapV2RouterAddress, owner);
        swapFactory = IUniswapV2Factory__factory.connect(await swapRouter.factory(), owner);


        await (await token.mint(owner.address, tokenInPoolAmount)).wait();
        await (await stable.mint(owner.address, stableInPoolAmount)).wait();

        await (await token.approve(swapRouter.address, ethers.constants.MaxUint256)).wait();
        await (await stable.approve(swapRouter.address, ethers.constants.MaxUint256)).wait();

        // add liquidity to token-stable pool and retrieve LP tokens 
        await (await swapRouter.addLiquidity(
            token.address,
            stable.address,
            tokenInPoolAmount,
            stableInPoolAmount,
            tokenInPoolAmount,
            stableInPoolAmount,
            owner.address,
            curTimeToBigNumberTimestamp().add(3600)
        )).wait();

        const lpAddress = await swapFactory.getPair(token.address, stable.address);

        expect(lpAddress).not.eq(ethers.constants.AddressZero);

        lp = IUniswapV2Pair__factory.connect(lpAddress, owner);

        passTicket = await (await new PassTicket__factory(owner).deploy('')).deployed();
        passTicketMarket = await (await new PassTicketMarket__factory(owner).deploy(token.address, passTicket.address)).deployed();

        launchpad = await (await new LaunchpadV2__factory(owner).deploy(
            token.address,
            lp.address,
            owner.address,
            [stable.address],
            BigNumber.from(0),
            passTicket.address)).deployed();

        // set market as a pass ticket minter
        await passTicket.connect(owner).setMinter(passTicketMarket.address, true);

        // add default sale options
        await passTicketMarket.setPassInfo(
            0,
            utils.parseUnits("1"),
            10000000,
            curTimeToBigNumberTimestamp().sub(100000),
            curTimeToBigNumberTimestamp().add(10000000000),
        )

        await passTicketMarket.setPassInfo(
            1,
            utils.parseUnits("1"),
            10000000,
            curTimeToBigNumberTimestamp().sub(10000000),
            curTimeToBigNumberTimestamp().add(10000000),
        )
    })

    beforeEach(snapshot)
    afterEach(revert)

    const mintToken = async (token: TestToken, mintTo: string, amount: BigNumberish) => {
        await token.connect(owner).mint(mintTo, amount);
    }

    const buyPassTicket = async (buyer: SignerWithAddress, ticketId: BigNumber) => {
        const passInfo = await passTicketMarket.passInfos(ticketId);
        await mintToken(token, buyer.address, passInfo.priceInMMPro);
        await token.connect(buyer).approve(passTicketMarket.address, passInfo.priceInMMPro);
        await passTicketMarket.connect(buyer).buyTicket(ticketId);
    }

    type AddNewSaleParams = {
        _poolOwner?: string,
        _lToken?: string,
        _lTokenPrice?: BigNumber,
        _tokensAllocationQty?: BigNumber,
        _depositLimit?: BigNumber,
        _startTimestamp?: BigNumber,
        _stakingDuration?: BigNumber,
        _purchaseDuration?: BigNumber,
        _lockupDuration?: BigNumber,
        _pickUpTokensAllowed?: boolean,
        _passTicketInfo?: {
            requiresTicket: boolean;
            supportsGenericTicket: boolean;
            ticketId: BigNumber;
        },
    }

    const addNewSale = ({
        _poolOwner = owner.address,
        _lToken = lToken.address,
        _lTokenPrice = utils.parseUnits('1'),
        _tokensAllocationQty = BigNumber.from('60000000000000000000000'),
        _depositLimit = BigNumber.from('50000000000000000000000'),
        _startTimestamp = curTimeToBigNumberTimestamp(),
        _stakingDuration = BigNumber.from(3600),
        _purchaseDuration = BigNumber.from(3600),
        _lockupDuration = BigNumber.from(3600),
        _pickUpTokensAllowed = true,
        _passTicketInfo = {
            requiresTicket: true,
            supportsGenericTicket: true,
            ticketId: BigNumber.from(1)
        }
    }: AddNewSaleParams) => {
        const params = {
            _poolOwner,
            _lToken,
            _lTokenPrice,
            _tokensAllocationQty,
            _depositLimit,
            _startTimestamp,
            _stakingDuration,
            _purchaseDuration,
            _lockupDuration,
            _pickUpTokensAllowed,
            _passTicketInfo
        }
        return {
            params,
            tx: () => launchpad.add(
                _poolOwner,
                _lToken,
                _lTokenPrice,
                _tokensAllocationQty,
                _depositLimit,
                _startTimestamp,
                _stakingDuration,
                _purchaseDuration,
                _lockupDuration,
                _pickUpTokensAllowed,
                _passTicketInfo
            )
        };
    }
    /**
     * Calculates the amount of MMRPO tokens from given LP amount
     */
    const calculateExpectedLpTokenShare = async (lpAmount: BigNumber) => {
        if (lpAmount.eq(ethers.constants.Zero)) return ethers.constants.Zero;

        const lpTs = await lp.totalSupply();

        if (lpAmount.gt(lpTs)) return ethers.constants.Zero;

        const [token0] = await lp.token0();

        const [reserve0, reserve1] = await lp.getReserves();

        const tokenReserve = token0 == token.address ? reserve0 : reserve1;

        const res = lpAmount.mul(tokenReserve).div(lpTs);
        return res;
    }

    const mintAndApprove = async (token: TestToken, mintTo: SignerWithAddress, approveTo: string, amount: BigNumber) => {
        await (await token.mint(mintTo.address, amount)).wait();
        await (await token.connect(mintTo).approve(approveTo, amount)).wait();
    }

    describe('LP token share calculation', () => {
        it('Should return 0 if given amount of LP is 0', async () => {
            expect(await calculateExpectedLpTokenShare(BigNumber.from(0))).eq(BigNumber.from(0));
            expect(await launchpad.calculateMmproShareFromLpToken(0)).eq(BigNumber.from(0));
        })

        it('Should return 0 if given amount of LP is > LP TS', async () => {
            const lpTs = await lp.totalSupply();
            expect(await calculateExpectedLpTokenShare(lpTs.add(1))).eq(BigNumber.from(0));
            expect(await launchpad.calculateMmproShareFromLpToken(lpTs.add(1))).eq(BigNumber.from(0));
        })

        it('Transfer away 30% of LP TS and calculate tokens share', async () => {
            const balance = await lp.balanceOf(owner.address);
            const transferAmount = balance.mul(30).div(100);

            await (await lp.transfer(ethers.constants.AddressZero, transferAmount)).wait();
            const newBalance = balance.sub(transferAmount);

            const expectedTokenAInPool = tokenInPoolAmount.sub(tokenInPoolAmount.mul(30).div(100))

            const eqEps = BigNumber.from(1000);
            expect(equalWithEpsilon(await calculateExpectedLpTokenShare(newBalance), expectedTokenAInPool, eqEps)).eq(true);
            expect(equalWithEpsilon(await launchpad.calculateMmproShareFromLpToken(newBalance), expectedTokenAInPool, eqEps)).eq(true);
        })

        it('Calculate when LP TS increased by adding liquidity', async () => {
            const tsBefore = await lp.totalSupply();
            const lpProvider = rAccounts[1];

            const toAddToken = tokenInPoolAmount.div(2);
            const toAddStable = stableInPoolAmount.div(2);

            await mintAndApprove(token, lpProvider, lp.address, toAddToken);
            await mintAndApprove(stable, lpProvider, lp.address, toAddStable);

            const ts = await lp.totalSupply();

            expect(equalWithEpsilon(ts, tsBefore.add(tsBefore.div(2)), BigNumber.from('100')));
        })
    });


    describe('Deposit LP token', () => {
        it('Should failed: deposit LP when user have no LPs', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });
            const depositor = rAccounts[2];

            expect(await lp.balanceOf(depositor.address)).eq(ethers.constants.Zero);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, utils.parseUnits('1'))).revertedWith('ds-math-sub-underflow');
        })

        it('Should failed: deposit mmpro, amount=depositLimit, then deposit LPs', async () => {
            const depositLimit = utils.parseUnits('100')
            const { params, tx } = addNewSale({ _depositLimit: depositLimit, _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });
            const depositor = rAccounts[2];

            expect(await lp.balanceOf(depositor.address)).eq(ethers.constants.Zero);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintAndApprove(token, depositor, launchpad.address, depositLimit);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositLimit))
                .not.reverted;

            const poolInfo = await launchpad.poolInfo(0);

            expect(poolInfo.depositLimit).eq(depositLimit);
            expect(poolInfo.sharesTotal).eq(depositLimit);

            const lpDepositAmount = (await lp.balanceOf(owner.address)).div(10);

            await (await lp.transfer(depositor.address, lpDepositAmount)).wait();
            await (await lp.connect(depositor).approve(launchpad.address, lpDepositAmount)).wait();

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, lpDepositAmount))
                .revertedWith('deposit limit exceeded');
        })

        it('Deposit LPs', async () => {
            const depositor = rAccounts[2];

            expect(await lp.balanceOf(depositor.address)).eq(ethers.constants.Zero);

            const lpDepositAmount = (await lp.balanceOf(owner.address)).div(10);

            await (await lp.transfer(depositor.address, lpDepositAmount)).wait();
            await (await lp.connect(depositor).approve(launchpad.address, lpDepositAmount)).wait();

            const tokenShareInLp = await calculateExpectedLpTokenShare(lpDepositAmount);

            const { params, tx } = addNewSale({ _depositLimit: tokenShareInLp, _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, lpDepositAmount))
                .not.reverted;

            const poolInfo = await launchpad.poolInfo(0);
            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(poolInfo.depositLimit).eq(tokenShareInLp);
            expect(poolInfo.sharesTotal).eq(tokenShareInLp);
            expect(userInfo.depositedLp).eq(lpDepositAmount);
            expect(userInfo.depositedLpMMrpoShare).eq(tokenShareInLp);
            expect(userInfo.depositedMMpro).eq(ethers.constants.Zero);
        })

        it('Deposit LPs and withdraw them all', async () => {
            const depositor = rAccounts[2];

            expect(await lp.balanceOf(depositor.address)).eq(ethers.constants.Zero);

            const lpDepositAmount = (await lp.balanceOf(owner.address)).div(10);

            await (await lp.transfer(depositor.address, lpDepositAmount)).wait();
            await (await lp.connect(depositor).approve(launchpad.address, lpDepositAmount)).wait();

            const tokenShareInLp = await calculateExpectedLpTokenShare(lpDepositAmount);

            const { params, tx } = addNewSale({ _depositLimit: tokenShareInLp, _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, lpDepositAmount))
                .not.reverted;

            let poolInfo = await launchpad.poolInfo(0);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO_BUSD_LP, lpDepositAmount, false))
                .not.reverted;

            poolInfo = await launchpad.poolInfo(0);
            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(await lp.balanceOf(depositor.address)).eq(lpDepositAmount);
            expect(poolInfo.sharesTotal).eq(ethers.constants.Zero);
            expect(userInfo.depositedLp).eq(ethers.constants.Zero);
            expect(userInfo.depositedLpMMrpoShare).eq(ethers.constants.Zero);
            expect(userInfo.depositedMMpro).eq(ethers.constants.Zero);
        })

        it('Deposit mmpro, then deposit LPs and then withdraw both', async () => {
            const depositor = rAccounts[2];

            expect(await lp.balanceOf(depositor.address)).eq(ethers.constants.Zero);
            expect(await token.balanceOf(depositor.address)).eq(ethers.constants.Zero);

            const lpDepositAmount = (await lp.balanceOf(owner.address)).div(10);

            const tokenDepositAmount = utils.parseUnits('100');

            const tokenShareInLp = await calculateExpectedLpTokenShare(lpDepositAmount);

            const { params, tx } = addNewSale({ _depositLimit: tokenShareInLp.add(tokenDepositAmount), _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintAndApprove(token, depositor, launchpad.address, tokenDepositAmount);;

            await (await lp.transfer(depositor.address, lpDepositAmount)).wait();
            await (await lp.connect(depositor).approve(launchpad.address, lpDepositAmount)).wait();

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, tokenDepositAmount))
                .not.reverted;

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, lpDepositAmount))
                .not.reverted;

            let poolInfo = await launchpad.poolInfo(0);
            let userInfo = await launchpad.userInfo(depositor.address, 0);


            expect(poolInfo.depositLimit).eq(tokenShareInLp.add(tokenDepositAmount));
            expect(poolInfo.sharesTotal).eq(tokenShareInLp.add(tokenDepositAmount));
            expect(userInfo.depositedLp).eq(lpDepositAmount);
            expect(userInfo.depositedLpMMrpoShare).eq(tokenShareInLp);
            expect(userInfo.depositedMMpro).eq(tokenDepositAmount);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO_BUSD_LP, lpDepositAmount, false))
                .not.reverted;

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO, tokenDepositAmount, false))
                .not.reverted;

            poolInfo = await launchpad.poolInfo(0);
            userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(await lp.balanceOf(depositor.address)).eq(lpDepositAmount);
            expect(await token.balanceOf(depositor.address)).eq(tokenDepositAmount);
            expect(poolInfo.sharesTotal).eq(ethers.constants.Zero);
            expect(userInfo.depositedLp).eq(ethers.constants.Zero);
            expect(userInfo.depositedLpMMrpoShare).eq(ethers.constants.Zero);
            expect(userInfo.depositedMMpro).eq(ethers.constants.Zero);
        })

        it('Deposit LP, change pool balance, deposit more lps and validate user`s deposit amounts', async () => {
            const depositor = rAccounts[2];

            expect(await lp.balanceOf(depositor.address)).eq(ethers.constants.Zero);

            const lpDepositAmountTotal = (await lp.balanceOf(owner.address)).div(10);

            await (await lp.transfer(depositor.address, lpDepositAmountTotal)).wait();
            await (await lp.connect(depositor).approve(launchpad.address, lpDepositAmountTotal)).wait();

            const lpToDeposit1 = lpDepositAmountTotal.mul(90).div(100);
            const lpToDeposit2 = lpDepositAmountTotal.sub(lpToDeposit1);

            const tokenShareInLp1 = await calculateExpectedLpTokenShare(lpToDeposit1);

            const newTokenPool = tokenInPoolAmount.add(100);
            const depositLimit = newTokenPool;

            const { params, tx } = addNewSale({ _depositLimit: depositLimit, _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, lpToDeposit1)
            // .not.reverted;
            let poolInfo = await launchpad.poolInfo(0);
            let userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(poolInfo.sharesTotal).eq(tokenShareInLp1);
            expect(userInfo.depositedLp).eq(lpToDeposit1);
            expect(userInfo.depositedLpMMrpoShare).eq(tokenShareInLp1);

            const amountToSwap = newTokenPool.sub(tokenInPoolAmount);

            await (await token.mint(owner.address, amountToSwap)).wait();

            await (await swapRouter.swapExactTokensForTokens(
                newTokenPool.sub(tokenInPoolAmount),
                0,
                [token.address, stable.address],
                depositor.address,
                curTimeToBigNumberTimestamp().add(3600)
            )).wait();

            const tokenShareInLp2 = await calculateExpectedLpTokenShare(lpToDeposit1.add(lpToDeposit2));

            await launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, lpToDeposit2)
            // .not.reverted;

            poolInfo = await launchpad.poolInfo(0);
            userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(poolInfo.sharesTotal).eq(tokenShareInLp2);
            expect(userInfo.depositedLp).eq(lpToDeposit1.add(lpToDeposit2));
            expect(userInfo.depositedLpMMrpoShare).eq(tokenShareInLp2);
        })

        it('Should fail: Deposit LP, increase MMPRO amount in pool, withdraw few LPs and bring to depositLimit overflow', async () => {
            const depositor = rAccounts[2];

            expect(await lp.balanceOf(depositor.address)).eq(ethers.constants.Zero);

            const lpDepositAmount = (await lp.balanceOf(owner.address)).div(10);

            await (await lp.transfer(depositor.address, lpDepositAmount)).wait();
            await (await lp.connect(depositor).approve(launchpad.address, lpDepositAmount)).wait();

            const tokenShareInLp = await calculateExpectedLpTokenShare(lpDepositAmount);

            const newTokenPool = tokenInPoolAmount.add(100);
            const depositLimit = tokenShareInLp;

            const { params, tx } = addNewSale({ _depositLimit: depositLimit, _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO_BUSD_LP, lpDepositAmount))
                .not.reverted;

            let poolInfo = await launchpad.poolInfo(0);
            let userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(poolInfo.sharesTotal).eq(tokenShareInLp);
            expect(userInfo.depositedLp).eq(lpDepositAmount);
            expect(userInfo.depositedLpMMrpoShare).eq(tokenShareInLp);

            const amountToSwap = newTokenPool.sub(tokenInPoolAmount);

            await (await token.mint(owner.address, amountToSwap)).wait();

            await (await swapRouter.swapExactTokensForTokens(
                newTokenPool.sub(tokenInPoolAmount),
                0,
                [token.address, stable.address],
                depositor.address,
                curTimeToBigNumberTimestamp().add(3600)
            )).wait();

            const newTokenShareInLp = await calculateExpectedLpTokenShare(lpDepositAmount);

            expect(newTokenShareInLp).gt(tokenShareInLp);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO_BUSD_LP, BigNumber.from('1'), false))
                .revertedWith('deposit limit exceeded');
        })
    })


    describe('Pass ticket', () => {
        it('Add new sale with valid ticket params', async () => {
            const { params, tx } = addNewSale({});

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);

            await expect(tx()).not.reverted;

            const passInfo = await launchpad.passTicketPoolInfo(0);

            expect(passInfo.requiresTicket).eq(params._passTicketInfo.requiresTicket);
            expect(passInfo.supportsGenericTicket).eq(params._passTicketInfo.supportsGenericTicket);
            expect(passInfo.ticketId).eq(params._passTicketInfo.ticketId);
        })

        it('Add new sale with invalid supportsGenericTicket param value', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });
            await lToken.transfer(launchpad.address, params._tokensAllocationQty);

            await expect(tx()).revertedWith('!genericSupport');
        })

        it('Add new sale with invalid requiresTicket param value', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: false, supportsGenericTicket: true, ticketId: BigNumber.from(0) } });
            await lToken.transfer(launchpad.address, params._tokensAllocationQty);

            await expect(tx()).revertedWith('!requiresTicket');
        })


        it('Make a deposit when a depositor has a pass ticket', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, BigNumber.from(1));
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;
        })

        it('Make a deposit when generic ticket is supported and a depositor has only generic pass', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: true, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, BigNumber.from(0));

            const ticketBalanceBefore = await passTicket.balanceOf(depositor.address, 0);
            expect(ticketBalanceBefore).eq(BigNumber.from(1));

            await token.connect(depositor).approve(launchpad.address, depositAmount);
            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const ticketBalanceAfter = await passTicket.balanceOf(depositor.address, 0);
            expect(ticketBalanceAfter).eq(BigNumber.from(0));

            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(userInfo.passTicketTaken).eq(true);
            expect(userInfo.passTicketId).eq(0);
            expect(userInfo.passTicketWithdrawn).eq(false);

            expect(await passTicket.balanceOf(launchpad.address, 0)).eq(BigNumber.from(1));
        })

        it('Make a deposit when generic ticket is supported and a depositor has both generic and sale-depended pass', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: true, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, BigNumber.from(0));
            await buyPassTicket(depositor, BigNumber.from(1));

            const ticket0BalanceBefore = await passTicket.balanceOf(depositor.address, 0);
            expect(ticket0BalanceBefore).eq(BigNumber.from(1));

            const ticket1BalanceBefore = await passTicket.balanceOf(depositor.address, 1);
            expect(ticket1BalanceBefore).eq(BigNumber.from(1));

            await token.connect(depositor).approve(launchpad.address, depositAmount);
            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const ticket0BalanceAfter = await passTicket.balanceOf(depositor.address, 0);
            expect(ticket0BalanceAfter).eq(BigNumber.from(1));

            const ticket1BalanceAfter = await passTicket.balanceOf(depositor.address, 1);
            expect(ticket1BalanceAfter).eq(BigNumber.from(0));

            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(userInfo.passTicketTaken).eq(true);
            expect(userInfo.passTicketId).eq(1);
            expect(userInfo.passTicketWithdrawn).eq(false);

            expect(await passTicket.balanceOf(launchpad.address, 0)).eq(BigNumber.from(0));
            expect(await passTicket.balanceOf(launchpad.address, 1)).eq(BigNumber.from(1));
        })


        it('Make a deposit when a depositor has a pass ticket but its not approved', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, BigNumber.from(1));
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).revertedWith('!ticket');
        })


        it('Call withdraw with withdrawPass set to true', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, params._passTicketInfo.ticketId);
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const poolInfo = await launchpad.poolInfo(0);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO, depositAmount, true);

            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(userInfo.passTicketTaken).eq(true);

            expect(await passTicket.balanceOf(launchpad.address, params._passTicketInfo.ticketId)).eq(BigNumber.from(0));
            expect(await passTicket.balanceOf(depositor.address, params._passTicketInfo.ticketId)).eq(BigNumber.from(1));
        })


        it('Call withdraw with withdrawPass set to false', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, params._passTicketInfo.ticketId);
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const poolInfo = await launchpad.poolInfo(0);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO, depositAmount, false);

            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(userInfo.passTicketWithdrawn).eq(false);

            expect(await passTicket.balanceOf(launchpad.address, params._passTicketInfo.ticketId)).eq(BigNumber.from(1));
            expect(await passTicket.balanceOf(depositor.address, params._passTicketInfo.ticketId)).eq(BigNumber.from(0));
        })

        it('Call withdraw with withdrawPass set to true but pool does not required pass ticket', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: false, supportsGenericTicket: false, ticketId: BigNumber.from(0) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const poolInfo = await launchpad.poolInfo(0);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO, depositAmount, true)).revertedWith('!withdraw ticket');
        })

        it('Call withdraw with withdrawPass set to false and after call withdrawPassTicket', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, params._passTicketInfo.ticketId);
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const poolInfo = await launchpad.poolInfo(0);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO, depositAmount, false)).not.reverted;
            await expect(launchpad.connect(depositor).withdrawPassTicket(0)).not.reverted;

            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(userInfo.passTicketTaken).eq(true);

            expect(await passTicket.balanceOf(launchpad.address, params._passTicketInfo.ticketId)).eq(BigNumber.from(0));
            expect(await passTicket.balanceOf(depositor.address, params._passTicketInfo.ticketId)).eq(BigNumber.from(1));
        })

        it('Call withdraw with withdrawPass set to false and after call withdrawPassTicket 2 times', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, params._passTicketInfo.ticketId);
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const poolInfo = await launchpad.poolInfo(0);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO, depositAmount, false)).not.reverted;
            await expect(launchpad.connect(depositor).withdrawPassTicket(0)).not.reverted;
            await expect(launchpad.connect(depositor).withdrawPassTicket(0)).revertedWith('ticket withdrawn');
        })

        it('Call withdraw with withdrawPass set to true and after call withdrawPassTicket', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, params._passTicketInfo.ticketId);
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            const poolInfo = await launchpad.poolInfo(0);

            await nextBlockTimestamp(poolInfo.stakingEnd.toNumber(), true);

            await expect(launchpad.connect(depositor).withdraw(0, DepositTokenType.MMPRO, depositAmount, true)).not.reverted;

            const userInfo = await launchpad.userInfo(depositor.address, 0);

            expect(userInfo.passTicketWithdrawn).eq(true);

            await expect(launchpad.connect(depositor).withdrawPassTicket(0)).revertedWith('ticket withdrawn');
        })

        it('Call withdrawPassTicket before staking time ends', async () => {
            const { params, tx } = addNewSale({ _passTicketInfo: { requiresTicket: true, supportsGenericTicket: false, ticketId: BigNumber.from(1) } });
            const depositor = rAccounts[2];

            const depositAmount = params._depositLimit.div(2);

            await lToken.transfer(launchpad.address, params._tokensAllocationQty);
            await tx();

            await mintToken(token, depositor.address, depositAmount);

            await buyPassTicket(depositor, params._passTicketInfo.ticketId);
            await token.connect(depositor).approve(launchpad.address, depositAmount);

            await passTicket.connect(depositor).setApprovalForAll(launchpad.address, true);

            await expect(launchpad.connect(depositor).deposit(0, DepositTokenType.MMPRO, depositAmount)).not.reverted;

            await expect(launchpad.connect(depositor).withdrawPassTicket(0)).revertedWith('!time');
        })
    })



});