import { task, types } from "hardhat/config";

task("TestToken:deploy", "").setAction(async (_, hre) => {
  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractFactory("TestToken", signer);
  const deployedToken = await (await factory.deploy()).deployed();

  console.log("TestToken deployed at: ", deployedToken.address);
});

task("StakingFlexible:deploy", "").setAction(async (_, hre) => {
  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractFactory(
    "StakingFlexible",
    signer
  );

  const deployedStakingFlexible = await (await factory.deploy()).deployed();

  console.log("StakingFlexible deployed at: ", deployedStakingFlexible.address);
});

task("StakingFixed:deploy", "").setAction(async (_, hre) => {
  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractFactory("StakingFixed", signer);
  const deployedStakingFixed = await (await factory.deploy()).deployed();

  console.log("StakingFixed deployed at: ", deployedStakingFixed.address);
});

task("StakingFlexible:addMMproStake", "")
  .addPositionalParam("flexStakeAddress", "", undefined, types.string, false)
  .addPositionalParam("stakeTokenAddress", "", undefined, types.string, false)
  .addPositionalParam("initEpd", "", undefined, types.float, false)
  .addOptionalPositionalParam("rewardTokenAddress", "", undefined, types.string)
  .setAction(
    async (
      { flexStakeAddress, stakeTokenAddress, initEpd, rewardTokenAddress },
      hre
    ) => {
      rewardTokenAddress ??= stakeTokenAddress;
      const [signer] = await hre.ethers.getSigners();
      const stakingFlexible = await hre.ethers.getContractAt(
        "StakingFlexible",
        flexStakeAddress,
        signer
      );

      const token = await hre.ethers.getContractAt(
        "@openzeppelin/contract-0.6.0/token/ERC20/ERC20.sol:ERC20",
        stakeTokenAddress,
        signer
      );
      const tokenDecimals = await token.decimals();

      const parsedEpd = hre.ethers.utils.parseUnits(
        (initEpd as number).toString(),
        tokenDecimals
      );

      await (
        await stakingFlexible.addStakeOwner(stakeTokenAddress, signer.address)
      ).wait();
      await (
        await stakingFlexible.initializeStake(
          stakeTokenAddress,
          parsedEpd,
          rewardTokenAddress
        )
      ).wait();

      console.log("Successfully completed");
    }
  );

task("StakingFixed:addMMproStake", "")
  .addPositionalParam("fixedStakingAddress", "", undefined, types.string, false)
  .addPositionalParam("stakeTokenAddress", "", undefined, types.string, false)
  .addOptionalPositionalParam("rewardTokenAddress", "", undefined, types.string)
  .setAction(
    async (
      { fixedStakingAddress, stakeTokenAddress, rewardTokenAddress },
      hre
    ) => {
      rewardTokenAddress ??= stakeTokenAddress;

      const [signer] = await hre.ethers.getSigners();
      const stakingFixed = await hre.ethers.getContractAt(
        "StakingFixed",
        fixedStakingAddress,
        signer
      );

      await (
        await stakingFixed.addStakeOwner(stakeTokenAddress, signer.address)
      ).wait();
      await (
        await stakingFixed.addStakeOptions(
          stakeTokenAddress,
          30,
          2_000,
          rewardTokenAddress
        )
      ).wait();
      await (
        await stakingFixed.addStakeOptions(
          stakeTokenAddress,
          60,
          5_000,
          rewardTokenAddress
        )
      ).wait();
      await (
        await stakingFixed.addStakeOptions(
          stakeTokenAddress,
          90,
          10_000,
          rewardTokenAddress
        )
      ).wait();

      console.log("Successfully completed");
    }
  );

task("PassTicket:deploy", "")
  .addParam("uri", "", undefined, types.string, false)
  .setAction(async ({ uri }, hre) => {
    const [signer] = await hre.ethers.getSigners();

    const factory = await hre.ethers.getContractFactory("PassTicket", signer);
    const deployedTicket = await (await factory.deploy(uri)).deployed();

    console.log("PassTicket deployed at: ", deployedTicket.address);
  });

task("PassTicket:setMinter", "")
  .addParam("passTicketAddress", "", undefined, types.string, false)
  .addParam("minterAddress", "", undefined, types.string, false)
  .addOptionalParam("setValue", "", true, types.boolean)
  .setAction(async ({ passTicketAddress, minterAddress, setValue }, hre) => {
    const [signer] = await hre.ethers.getSigners();

    const passTicket = await hre.ethers.getContractAt(
      "PassTicket",
      passTicketAddress,
      signer
    );

    await (await passTicket.setMinter(minterAddress, setValue)).wait();

    console.log("Successfully completed");
  });

task("PassTicketMarket:deploy", "")
  .addParam("mmproToken", "", undefined, types.string, false)
  .addParam("ticketPassAddress", "", undefined, types.string, false)
  .setAction(async ({ mmproToken, ticketPassAddress }, hre) => {
    const [signer] = await hre.ethers.getSigners();

    const factory = await hre.ethers.getContractFactory(
      "PassTicketMarket",
      signer
    );
    const deployedTicket = await (
      await factory.deploy(mmproToken, ticketPassAddress)
    ).deployed();

    console.log("PassTicketMarket deployed at: ", deployedTicket.address);
  });

task("LaunchpadV2:deploy", "")
  .addPositionalParam("mmproToken", "", undefined, types.string, false)
  .addPositionalParam("mmproLpToken", "", undefined, types.string, false)
  .addPositionalParam("feeAddress", "", undefined, types.string, false)
  .addPositionalParam(
    "stablesAddresses",
    "Coma separated list of addresses",
    undefined,
    types.string,
    false
  )
  .addPositionalParam("allocationDelay", "", undefined, types.string, false)
  .addPositionalParam("passTicketAddress", "", undefined, types.string, false)
  .setAction(
    async (
      {
        mmproToken,
        mmproLpToken,
        feeAddress,
        stablesAddresses,
        allocationDelay,
        passTicketAddress,
      },
      hre
    ) => {
      const [signer] = await hre.ethers.getSigners();

      const stablesParsed = (<string>stablesAddresses).split(",");

      const factory = await hre.ethers.getContractFactory(
        "LaunchpadV2",
        signer
      );

      const deployedTicket = await (
        await factory.deploy(
          <string>mmproToken,
          <string>mmproLpToken,
          <string>feeAddress,
          stablesParsed,
          <string>allocationDelay,
          <string>passTicketAddress
        )
      ).deployed();

      console.log("LaunchpadV2 deployed at: ", deployedTicket.address);
    }
  );
