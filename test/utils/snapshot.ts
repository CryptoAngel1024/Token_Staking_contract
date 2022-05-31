import { network } from "hardhat";

export module evmSnapshot {
    let snapshotNumber: number | undefined;

    export const snapshot = async () => {
        snapshotNumber = await network.provider.send("evm_snapshot", []);
    }

    export const revert = async () => {
        if (snapshotNumber) {
            const result = await network.provider.send("evm_revert", [snapshotNumber]);
            if (!result) {
                throw Error("Revert snapshot fail");
            }
            snapshotNumber = undefined;
        }
    }
}

