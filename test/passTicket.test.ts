import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber } from "ethers";

import { PassTicket, PassTicket__factory } from "../typechain";
import { evmSnapshot } from "./utils/snapshot";

import snapshot = evmSnapshot.snapshot;
import revert = evmSnapshot.revert;

const curTimeToBigNumberTimestamp = () => {
  return BigNumber.from(Math.floor(new Date().getTime() / 1000));
};

describe("PassTicketMarket", () => {
  let owner: SignerWithAddress;
  let rAccounts: SignerWithAddress[];

  let passTicket: PassTicket;

  before(async () => {
    [owner, ...rAccounts] = await ethers.getSigners();

    // deploy contracts
    passTicket = await (
      await new PassTicket__factory(owner).deploy("")
    ).deployed();
  });

  beforeEach(snapshot);
  afterEach(revert);

  it("Call mintPass function from owner that is not minter", async () => {
    const passIdToMint = BigNumber.from(0);
    const mintAmount = BigNumber.from(1);

    expect(await passTicket.isMinter(owner.address)).eq(false);
    await expect(
      passTicket
        .connect(owner)
        .mintPass(owner.address, passIdToMint, mintAmount)
    ).revertedWith("!minter");
  });

  it("Add minter and call mintPass function", async () => {
    const minter = rAccounts[1];
    const nftReceiver = rAccounts[2];
    const passIdToMint = BigNumber.from(0);
    const mintAmount = BigNumber.from(1);

    await passTicket.setMinter(minter.address, true);
    expect(await passTicket.isMinter(minter.address)).eq(true);

    await expect(
      passTicket
        .connect(minter)
        .mintPass(nftReceiver.address, passIdToMint, mintAmount)
    ).not.reverted;
    expect(await passTicket.balanceOf(nftReceiver.address, passIdToMint)).eq(
      BigNumber.from(mintAmount)
    );
  });

  it("Remove minter and call mintPass function should be reverted", async () => {
    const minter = rAccounts[1];
    await passTicket.setMinter(minter.address, false);
    expect(await passTicket.isMinter(minter.address)).eq(false);

    await expect(
      passTicket.connect(minter).mintPass(owner.address, 0, 1)
    ).revertedWith("!minter");
  });
});
