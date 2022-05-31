//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contract-0.8.0/token/ERC20/IERC20.sol";
import "@openzeppelin/contract-0.8.0/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contract-0.8.0/token/ERC20/extensions/draft-IERC20Permit.sol";
import "@openzeppelin/contract-0.8.0/security/ReentrancyGuard.sol";
import "@openzeppelin/contract-0.8.0/access/Ownable.sol";
import "./TokenStakeOwnable.sol";

import "hardhat/console.sol";

/// @notice one user staking information (amount, end time)
struct StakeInfo {
  address stakeToken;
  address rewardToken;
  uint256 amount;
  uint256 rewards;
  uint64 start;
  uint64 end;
}

/// @notice period option(period in days and total period bonus in percentage)
struct StakeOption {
  uint16 periodInDays;
  uint16 bonusInPercentage;
  address rewardToken;
}

/// @title Solo-staking token contract
/// @notice Staking token for one of pre-defined periods with different rewards and bonus percentage.
contract StakingFixed is TokenStakeOwnable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice store information about users stakes
  mapping(address => StakeInfo[]) public usersStake;

  /// @notice store information about stake options
  mapping(address => StakeOption[]) public stakeOptions;

  /// @notice staked amount in for each option
  /// @dev stakeToken => reservedAmount
  mapping(address => uint256) public totalReservedAmount;

  /// @notice emits on stake
  event Stake(
    address indexed sender,
    address indexed stakeToken,
    uint256 amount,
    uint16 option
  );

  /// @notice emits on token withdrawal from staking
  event Withdraw(
    address indexed sender,
    address indexed stakeToken,
    address indexed rewardToken,
    uint256 amount,
    uint256 rewards
  );

  /// @notice emits when option for stake token is changed
  event OptionChange(address indexed stakeToken, uint16 indexed option);

  /// @notice emits when new option for stake token is created
  event OptionAdd(address indexed stakeToken, uint16 indexed newOption);

  /// @dev Check for value is greater then zero
  modifier gtZero(uint256 value) {
    require(value > 0, "value == 0");
    _;
  }

  /// @dev Checks that selected stake option is valid
  modifier validOption(address stakeToken, uint16 option) {
    require(option < stakeOptions[stakeToken].length, "!option");
    require(
      stakeOptions[stakeToken][option].periodInDays != 0 &&
        stakeOptions[stakeToken][option].bonusInPercentage != 0 &&
        stakeOptions[stakeToken][option].rewardToken != address(0),
      "!active option"
    );
    _;
  }

  /// @notice stake function with permit support
  /// (see stake(..) func for more info)
  function stakeWithPermit(
    address stakeToken,
    uint256 amount,
    uint16 option,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external {
    IERC20Permit(stakeToken).permit(
      _msgSender(),
      address(this),
      amount,
      deadline,
      v,
      r,
      s
    );

    IERC20(stakeToken).safeTransferFrom(_msgSender(), address(this), amount);
    _stake(_msgSender(), stakeToken, amount, option);
  }

  /// @notice puts tokens into staking for given option
  /// @param amount - amount of tokens to put into stake,
  /// @param option - index of the option in stakeOptions array
  function stake(
    address stakeToken,
    uint256 amount,
    uint16 option
  ) external gtZero(amount) {
    IERC20(stakeToken).safeTransferFrom(_msgSender(), address(this), amount);
    _stake(_msgSender(), stakeToken, amount, option);
  }

  /// @notice puts tokens into staking for given option for specified user
  /// @param amount - amount of tokens to put into stake,
  /// @param option - index of the option in stakeOptions array
  function stakeFor(
    address account,
    address stakeToken,
    uint256 amount,
    uint16 option
  ) external gtZero(amount) {
    IERC20(stakeToken).safeTransferFrom(_msgSender(), address(this), amount);
    _stake(account, stakeToken, amount, option);
  }

  /// @dev internal function for stake logic implementation (without transfer tokens)
  /// @param amount - amount of tokens,
  /// @param option - index of the option in stakeOptions mapping
  /// @param account - address of user account
  function _stake(
    address account,
    address stakeToken,
    uint256 amount,
    uint16 option
  )
    internal
    nonReentrant
    validOption(stakeToken, option)
    whenStakingNotPaused(stakeToken)
  {
    require(account != address(0), "!account");
    StakeOption memory opt = stakeOptions[stakeToken][option];

    uint256 rewards = calculateRewards(stakeToken, amount, option);

    require(
      IERC20(opt.rewardToken).balanceOf(address(this)) >= rewards + amount,
      "!reserves"
    );

    usersStake[account].push(
      StakeInfo({
        stakeToken: stakeToken,
        rewardToken: opt.rewardToken,
        amount: amount,
        rewards: rewards,
        start: uint64(block.timestamp),
        end: uint64(block.timestamp + opt.periodInDays * 1 minutes)
      })
    );

    totalReservedAmount[stakeToken] += amount;
    totalReservedAmount[opt.rewardToken] += rewards;

    emit Stake(account, stakeToken, amount, option);
  }

  /// @notice withdraw tokens
  /// @param stakeToken - stake token
  /// @param stakeIndex - index of user`s stake
  function withdraw(address stakeToken, uint16 stakeIndex)
    external
    nonReentrant
  {
    require(usersStake[_msgSender()].length > stakeIndex, "!index");

    StakeInfo memory s = usersStake[_msgSender()][stakeIndex];

    require(s.stakeToken == stakeToken, "!stakeToken");
    require(block.timestamp > s.end, "!end");

    // remove stake from user stakes
    usersStake[_msgSender()][stakeIndex] = usersStake[_msgSender()][
      usersStake[_msgSender()].length - 1
    ];

    usersStake[_msgSender()].pop();

    totalReservedAmount[stakeToken] -= s.amount;
    totalReservedAmount[s.rewardToken] -= s.rewards;

    if (stakeToken == s.rewardToken) {
      IERC20(stakeToken).safeTransfer(_msgSender(), s.amount + s.rewards);
    } else {
      IERC20(stakeToken).safeTransfer(_msgSender(), s.amount);
      IERC20(s.rewardToken).safeTransfer(_msgSender(), s.rewards);
    }

    emit Withdraw(_msgSender(), stakeToken, s.rewardToken, s.amount, s.rewards);
  }

  /// @notice set option values. Will affect only new stakes
  /// @dev to make option inactive set period to 0
  /// @param optionIndex - option indexes
  /// @param period - period for options
  /// @param bonusInPercentage - bonuse for each option in percents (100 = 1%)
  function setStakeOptions(
    address token,
    uint16 optionIndex,
    uint16 period,
    uint16 bonusInPercentage,
    address rewardToken
  ) external onlyTokenStakeOwner(token) {
    require(optionIndex < stakeOptions[token].length, "!option");
    stakeOptions[token][optionIndex] = StakeOption(
      period,
      bonusInPercentage,
      rewardToken
    );
    emit OptionChange(token, optionIndex);
  }

  /// @notice add new option
  /// @param token - stake token
  /// @param period - period for options
  /// @param bonusInPercentage - bonuse for each option in percents (100 = 1%)
  function addStakeOptions(
    address token,
    uint16 period,
    uint16 bonusInPercentage,
    address rewardToken
  ) external onlyTokenStakeOwner(token) {
    stakeOptions[token].push(
      StakeOption(period, bonusInPercentage, rewardToken)
    );
    emit OptionAdd(token, uint16(stakeOptions[token].length) - 1);
  }

  /// @notice withdraw free tokens from the contract
  /// @param token - address of the token
  /// @param amount - amount to withdraw
  function withdrawFreeTokens(address token, uint256 amount) external {
    if (totalReservedAmount[token] != 0) {
      require(_msgSender() == tokenStakeOwner[token], "not a pool owner");
      require(amount <= notReservedTokenAmount(token), "!free");
    } else {
      require(_msgSender() == owner(), "not a owner");
    }

    IERC20(token).safeTransfer(_msgSender(), amount);
  }

  /// @notice returns all user stakes
  function getUserStakes(address account)
    external
    view
    returns (StakeInfo[] memory)
  {
    return usersStake[account];
  }

  /// @notice return stake options array
  function getStakeOptions(address stakeToken)
    external
    view
    returns (StakeOption[] memory)
  {
    return stakeOptions[stakeToken];
  }

  /// @notice calculate user stake rewards
  function calculateRewards(
    address stakeToken,
    uint256 amount,
    uint16 optionIndex
  ) public view returns (uint256) {
    return
      (amount * stakeOptions[stakeToken][optionIndex].bonusInPercentage) /
      10000;
  }

  /// @notice returns how many tokens free
  function notReservedTokenAmount(address token) public view returns (uint256) {
    return IERC20(token).balanceOf(address(this)) - totalReservedAmount[token];
  }
}
