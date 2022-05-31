import { BigNumber } from "ethers";

export const getSecondsFromDays = (count: number): number => count * 86400;

export const getDaysFromSeconds = (count: number): number => Math.round(count / 86400);

export const equalWithEpsilon = (a: BigNumber, b: BigNumber, eps: BigNumber): boolean => a.sub(b).abs().lte(eps);

export const curTimeToBigNumberTimestamp = () => {
    return BigNumber.from(Math.floor(new Date().getTime() / 1000));
}
