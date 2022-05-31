import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, ContractTransaction, utils } from "ethers";

import {
    PassTicketMarket,
    PassTicket,
    PassTicket__factory,
    PassTicketMarket__factory,
    TestToken,
    TestToken__factory,
} from "../typechain";
import { evmSnapshot } from './utils/snapshot';
import { increaseTime, nextBlockTimestamp } from './utils/timeMachine';
import { getSecondsFromDays, equalWithEpsilon, curTimeToBigNumberTimestamp } from "../helpers/mathUtils";

import snapshot = evmSnapshot.snapshot;
import revert = evmSnapshot.revert;


describe('PassTicketMarket', () => {
    let owner: SignerWithAddress;
    let rAccounts: SignerWithAddress[]

    let token: TestToken;
    let passTicket: PassTicket;
    let passTicketMarket: PassTicketMarket;

    before(async () => {
        [owner, ...rAccounts] = await ethers.getSigners();

        // deploy contracts
        token = await (await new TestToken__factory(owner).deploy()).deployed();
        passTicket = await (await new PassTicket__factory(owner).deploy('')).deployed();
        passTicketMarket = await (await new PassTicketMarket__factory(owner).deploy(token.address, passTicket.address)).deployed();
        await token.mint(owner.address, utils.parseUnits('1000000'));
        // set market as a pass ticket minter
        await passTicket.connect(owner).setMinter(passTicketMarket.address, true);
    })

    beforeEach(snapshot)
    afterEach(revert)

    type SetPassInfoParams = {
        ticketId?: BigNumber,
        priceInMMPro?: BigNumber,
        stockAmount?: BigNumber,
        saleStartsAt?: BigNumber,
        saleEndsAt?: BigNumber,
    }

    const setPassInfo = ({
        ticketId = BigNumber.from(0),
        priceInMMPro = utils.parseUnits('100'),
        stockAmount = BigNumber.from(10),
        saleStartsAt = curTimeToBigNumberTimestamp(),
        saleEndsAt = curTimeToBigNumberTimestamp().add(3600),
    }: SetPassInfoParams) => {
        return {
            params: {
                ticketId,
                priceInMMPro,
                stockAmount,
                saleStartsAt,
                saleEndsAt,
            },
            tx: passTicketMarket.setPassInfo(
                ticketId,
                priceInMMPro,
                stockAmount,
                saleStartsAt,
                saleEndsAt,
            )
        };
    }

    it('Add minter and call mintPass function', async () => {
        const minter = rAccounts[1];
        const nftReceiver = rAccounts[2];
        const passIdToMint = BigNumber.from(0);
        const mintAmount = BigNumber.from(1);

        await passTicket.setMinter(minter.address, true);
        expect(await passTicket.isMinter(minter.address)).eq(true);

        await expect(passTicket.connect(minter).mintPass(nftReceiver.address, passIdToMint, mintAmount)).not.reverted;
        expect(await passTicket.balanceOf(nftReceiver.address, passIdToMint)).eq(BigNumber.from(mintAmount));
    });

    it('Remove minter and call mintPass function should be reverted', async () => {
        const minter = rAccounts[1];
        await passTicket.setMinter(minter.address, false);
        expect(await passTicket.isMinter(minter.address)).eq(false);

        await expect(passTicket.connect(minter).mintPass(owner.address, 0, 1)).revertedWith('!minter');
    });

    it('Set pass info with invalid sale time boundaries', async () => {
        await expect(setPassInfo({
            saleEndsAt: BigNumber.from(0),
            saleStartsAt: BigNumber.from(1),
        }).tx).revertedWith('end<=start');
    })

    it('Set pass info with valid params', async () => {
        const ticketId = BigNumber.from(0);

        await expect(setPassInfo({}).tx)
            .not.reverted;

        const info = await passTicketMarket.passInfos(ticketId);
        console.log(info);
    })

    it('Buy ticket with all conditions valid', async () => {
        const ticketId = BigNumber.from(1);
        const { params, tx } = setPassInfo({ ticketId: ticketId });
        await tx;

        await token.approve(passTicketMarket.address, params.priceInMMPro);

        await expect(passTicketMarket.buyTicket(ticketId)).not.reverted;
        const info = await passTicketMarket.passInfos(ticketId);

        expect(info.totalBoughtAmount).eq(BigNumber.from(1));
    })

    it('Try to by ticket when it is not for sale', async () => {
        const ticketId = BigNumber.from(1);

        await setPassInfo({ priceInMMPro: BigNumber.from(0), ticketId: ticketId }).tx;

        await expect(passTicketMarket.buyTicket(ticketId)).revertedWith('!exists');
    })

    it('Try to by ticket when it sale time is over', async () => {
        const ticketId = BigNumber.from(1);

        const { tx: setPassTx, params } = setPassInfo({ ticketId: ticketId });
        await setPassTx;

        await nextBlockTimestamp(params.saleEndsAt.toNumber(), true);

        await expect(passTicketMarket.buyTicket(ticketId)).revertedWith('sale !start/end');
    })


    it('Try to by ticket when it sale time is not started', async () => {
        const ticketId = BigNumber.from(1);

        await setPassInfo({
            ticketId: ticketId,
            saleStartsAt: curTimeToBigNumberTimestamp().add(1000),
            saleEndsAt: curTimeToBigNumberTimestamp().add(3000)
        }).tx;

        await expect(passTicketMarket.buyTicket(ticketId)).revertedWith('sale !start/end');
    })

    it('Try to by ticket when it is out of stock', async () => {
        const ticketId = BigNumber.from(1);
        const stockAmount = BigNumber.from(0);

        await setPassInfo({ stockAmount: stockAmount, ticketId: ticketId }).tx;

        await expect(passTicketMarket.buyTicket(ticketId)).revertedWith('!stock');
    })

    it('Buy => stock is empty now => buy again should failed', async () => {
        const ticketId = BigNumber.from(1);
        const stockAmount = BigNumber.from(1);

        const { params, tx } = setPassInfo({ stockAmount: stockAmount, ticketId: ticketId });
        await tx;

        await token.approve(passTicketMarket.address, params.priceInMMPro);

        await passTicketMarket.buyTicket(ticketId);
        await expect(passTicketMarket.buyTicket(ticketId)).revertedWith('!stock');
    })

    it('Buy few times => remove from stock => buy again should failed', async () => {
        const ticketId = BigNumber.from(1);
        const stockAmount = BigNumber.from(10);
        const timesToBuy = stockAmount.div(2);

        const { params, tx } = setPassInfo({ stockAmount: stockAmount, ticketId: ticketId });
        await tx;

        await token.approve(passTicketMarket.address, params.priceInMMPro.mul(timesToBuy));

        for (let i = 0; i < timesToBuy.toNumber(); i++) {
            await passTicketMarket.buyTicket(ticketId);
        }

        await setPassInfo({ stockAmount: BigNumber.from(0), ticketId: ticketId }).tx;
        await expect(passTicketMarket.buyTicket(ticketId)).revertedWith('!stock');

        const info = await passTicketMarket.passInfos(ticketId);
        expect(info.totalBoughtAmount).eq(timesToBuy);
    })
});