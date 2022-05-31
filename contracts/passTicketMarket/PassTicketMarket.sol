//SPDX-License-Identifier: Unlicense
pragma solidity ^0.6.12;

import "@openzeppelin/contract-0.6.0/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contract-0.6.0/token/ERC20/IERC20.sol";
import "@openzeppelin/contract-0.6.0/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contract-0.6.0/utils/Pausable.sol";
import "@openzeppelin/contract-0.6.0/utils/EnumerableSet.sol";
import "@openzeppelin/contract-0.6.0/access/Ownable.sol";
import "@openzeppelin/contract-0.6.0/token/ERC1155/IERC1155Receiver.sol";
import "hardhat/console.sol";

import "../passTicket/PassTicket.sol";

contract PassTicketMarket is Ownable {
  using SafeERC20 for IERC20;
  using EnumerableSet for EnumerableSet.UintSet;

  struct PassSellInfo {
    uint256 priceInMMPro;
    uint256 stockAmount;
    uint256 totalBoughtAmount;
    uint64 saleStartsAt;
    uint64 saleEndsAt;
  }

  event Buy(address indexed buyer, uint256 indexed ticketId, uint256 price);

  event PassSellInfoChange(address indexed sender, uint256 indexed ticketId);

  event TokensWithdraw(
    address indexed token,
    address indexed sender,
    address indexed to,
    uint256 amount
  );

  address public immutable mmproToken;
  address public immutable ticketPass;
  // id => info
  mapping(uint256 => PassSellInfo) public passInfos;

  EnumerableSet.UintSet private passes;

  constructor(address _mmproToken, address _ticketPass) public {
    mmproToken = _mmproToken;
    ticketPass = _ticketPass;
  }

  function buyTicket(uint256 ticketId) external {
    PassSellInfo storage info = passInfos[ticketId];

    require(info.priceInMMPro > 0, "!exists");
    require(info.totalBoughtAmount < info.stockAmount, "!stock");
    require(
      block.timestamp >= info.saleStartsAt &&
        block.timestamp <= info.saleEndsAt,
      "sale !start/end"
    );

    IERC20(mmproToken).safeTransferFrom(
      _msgSender(),
      address(this),
      info.priceInMMPro
    );

    info.totalBoughtAmount += 1;

    PassTicket(ticketPass).mintPass(_msgSender(), ticketId, 1);

    emit Buy(_msgSender(), ticketId, info.priceInMMPro);
  }

  function setPassInfo(
    uint256 ticketId,
    uint256 priceInMMPro,
    uint256 stockAmount,
    uint256 saleStartsAt,
    uint256 saleEndsAt
  ) external onlyOwner {
    require(saleEndsAt > saleStartsAt, "end<=start");

    passInfos[ticketId] = PassSellInfo({
      priceInMMPro: priceInMMPro,
      stockAmount: stockAmount,
      saleStartsAt: uint64(saleStartsAt),
      saleEndsAt: uint64(saleEndsAt),
      totalBoughtAmount: passInfos[ticketId].totalBoughtAmount
    });

    if (priceInMMPro == 0) passes.remove(ticketId);
    else passes.add(ticketId);

    emit PassSellInfoChange(_msgSender(), ticketId);
  }

  function withdrawTokens(
    address token,
    address to,
    uint256 amount
  ) external onlyOwner {
    IERC20(token).safeTransfer(to, amount);
    emit TokensWithdraw(token, _msgSender(), to, amount);
  }

  function getAllTickets() external view returns (uint256[] memory) {
    bytes32[] memory store = passes._inner._values;
    uint256[] memory result;

    assembly {
      result := store
    }

    return result;
  }
}
