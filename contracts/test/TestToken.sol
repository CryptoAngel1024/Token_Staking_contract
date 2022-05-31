//SPDX-License-Identifier: Unlicense
pragma solidity >=0.6.0 <0.8.0;

import "@openzeppelin/contract-0.6.0/token/ERC20/ERC20.sol";

contract TestToken is ERC20("Test", "Test") {
    constructor() public {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
