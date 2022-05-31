//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contract-0.8.0/token/ERC20/IERC20.sol";
import "@openzeppelin/contract-0.8.0/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contract-0.8.0/token/ERC20/extensions/draft-IERC20Permit.sol";
import "@openzeppelin/contract-0.8.0/security/Pausable.sol";
import "@openzeppelin/contract-0.8.0/security/ReentrancyGuard.sol";
import "@openzeppelin/contract-0.8.0/access/Ownable.sol";
import "hardhat/console.sol";

contract TokenStakeOwnable is Ownable {
  /// @notice stores owner of specific token staking
  /// @dev token => owner
  mapping(address => address) public tokenStakeOwner;

  /// @notice is spesific stake paused
  /// @dev token => isPaused
  mapping(address => bool) public isStakePaused;

  /// @notice emits when new option is created
  event TokenStakeOwnerAdd(address indexed token, address indexed owner);

  event TransferTokenStakeOwnership(
    address indexed token,
    address indexed owner
  );

  event SetStakingPaused(address indexed token, bool indexed isPaused);

  /// @dev Check that msg.sender is stake owner
  modifier onlyTokenStakeOwner(address token) {
    require(_msgSender() == tokenStakeOwner[token], "!tokenStakeOwner");
    _;
  }

  /// @dev Check that msg.sender is stake owner
  modifier whenStakingNotPaused(address token) {
    require(isStakePaused[token] == false, "staking paused");
    _;
  }

  function setStakingPaused(address stakeToken, bool isPaused)
    external
    onlyTokenStakeOwner(stakeToken)
  {
    isStakePaused[stakeToken] = isPaused;
    emit SetStakingPaused(stakeToken, isPaused);
  }

  function transferStakeOwnership(address token, address newOwner)
    external
    onlyTokenStakeOwner(token)
  {
    require(newOwner != address(0), "!newOwner");
    tokenStakeOwner[token] = newOwner;
    emit TransferTokenStakeOwnership(token, newOwner);
  }

  function addStakeOwner(address token, address owner) external onlyOwner {
    require(token != address(0), "!token");
    require(owner != address(0), "!owner");
    require(tokenStakeOwner[token] == address(0), "already have owner");
    tokenStakeOwner[token] = owner;
    emit TokenStakeOwnerAdd(token, owner);
  }
}
