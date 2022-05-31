//SPDX-License-Identifier: Unlicense
pragma solidity ^0.6.12;

import "@openzeppelin/contract-0.6.0/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contract-0.6.0/utils/Pausable.sol";
import "@openzeppelin/contract-0.6.0/access/Ownable.sol";

import "./MinterRole.sol";

contract PassTicket is MinterRole, ERC1155, Pausable {
  uint256 public constant MMPRO_PASS = 0;

  event MintedPass(
    address indexed minter,
    uint256 indexed id,
    address indexed mintedTo,
    uint256 amount
  );

  modifier validMintAmount(uint256 amount) {
    require(amount > 0, "amount == 0");
    _;
  }

  constructor(string memory baseUri) public ERC1155(baseUri) {}

  function mintPass(
    address to,
    uint256 id,
    uint256 amount
  ) external onlyMinter validMintAmount(amount) {
    _mint(to, id, amount, "");
    emit MintedPass(msg.sender, id, to, amount);
  }

  function setUri(string memory newUri) external onlyOwner {
    _setURI(newUri);
  }
}
