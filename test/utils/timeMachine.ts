import { network } from "hardhat";
import { getSecondsFromDays } from "../../helpers/mathUtils";

export const nextBlockTimestamp = async (timeStamp: number, mine: boolean = false) => {
    const blockNumber = await network.provider.send("eth_blockNumber", []);
    const block = await network.provider.send("eth_getBlockByNumber", [blockNumber, false]);

    if (!block || parseInt(block.timestamp, 16) < timeStamp) {
        await network.provider.send("evm_setNextBlockTimestamp", [timeStamp]);
        if (mine) await network.provider.send("evm_mine");
    }
    else {
        console.warn(`Current block.timestamp > timeStamp; ${parseInt(block.timestamp, 16)} > ${timeStamp}`);
    }
}

export const increaseTime = async (secondsToIncrease: number) => {
    // if (process.env.TENDERLY === 'true') {
    //     await network.provider.send('evm_increaseTime', [`0x${secondsToIncrease.toString(16)}`]);
    //     return;
    // }
    await network.provider.send('evm_increaseTime', [secondsToIncrease]);
    await network.provider.send('evm_mine', []);

    console.log("Delay: ", secondsToIncrease / getSecondsFromDays(1), " days");
};
