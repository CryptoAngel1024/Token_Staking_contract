//SPDX-License-Identifier: Unlicense
pragma solidity ^0.6.12;

import "@openzeppelin/contract-0.6.0/access/Ownable.sol";

abstract contract MinterRole is Ownable {
  mapping(address => bool) public isMinter;

  event MinterSet(address indexed minter, bool indexed value);

  modifier onlyMinter() {
    require(isMinter[msg.sender], "!minter");
    _;
  }

  modifier onlyMinterOrOwner() {
    require(isMinter[msg.sender] || msg.sender == owner(), "!minterOrOwner");
    _;
  }

  function setMinter(address minter, bool value) external onlyOwner {
    isMinter[minter] = value;
    emit MinterSet(minter, value);
  }
}
