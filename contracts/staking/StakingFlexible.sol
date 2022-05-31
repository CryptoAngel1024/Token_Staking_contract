//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contract-0.8.0/token/ERC20/IERC20.sol";
import "@openzeppelin/contract-0.8.0/token/ERC20/ERC20.sol";
import "@openzeppelin/contract-0.8.0/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contract-0.8.0/token/ERC20/extensions/draft-IERC20Permit.sol";
import "@openzeppelin/contract-0.8.0/security/Pausable.sol";
import "@openzeppelin/contract-0.8.0/security/ReentrancyGuard.sol";
import "@openzeppelin/contract-0.8.0/access/Ownable.sol";

import "./TokenStakeOwnable.sol";

/// @notice one user's stake information
struct StakeInfo {
  address stakeToken;
  uint256 amount; // amount of tokens in stake
  uint256 lastCI;
  uint256 start;
  uint256 unclaimedRewards;
  uint256 claimed;
}

struct TokenStakeInfo {
  // this address set on stake creation
  // and cannot be changed latter!
  address rewardToken;
  uint256 emissionPerSecond;
  uint256 totalStaked;
  uint256 cumulativeIndex;
  uint256 lastUpdatedTimestamp;
}

/// @title Solo-staking token contract
/// @notice Staking token for one of pre-defined periods with different rewards and bonus percentage.
contract StakingFlexible is TokenStakeOwnable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice stores information about users stakes
  mapping(address => StakeInfo[]) public usersStake;

  /// @notice stores information about token staking
  /// @dev token => info
  mapping(address => TokenStakeInfo) public tokenStakeInfo;

  /// @notice emitted when user successfuly staked tokens
  event Stake(
    address indexed sender,
    address indexed stakeToken,
    uint256 amount,
    uint256 timestamp,
    uint256 stakeIndex
  );

  /// @notice emitted when user successfuly claimed tokens
  event Claim(
    address indexed sender,
    address indexed stakeToken,
    uint256 amount,
    uint256 timestamp,
    uint16 stakeIndex
  );

  /// @notice emitted when user successfuly unstaked tokens
  event Withdraw(
    address indexed sender,
    address indexed stakeToken,
    uint256 amount,
    uint256 timestamp,
    uint16 stakeIndex
  );

  modifier validStaking(address stakeToken) {
    require(stakeToken != address(0), "!stakeToken");
    require(tokenStakeInfo[stakeToken].rewardToken != address(0), "!exists");
    _;
  }

  /// @dev Check for value is greater then zero
  modifier gtZero(uint256 value) {
    require(value > 0, "value == 0");
    _;
  }

  modifier validStakeIndex(uint16 stakeIndex) {
    require(usersStake[_msgSender()].length > stakeIndex, "!index");
    _;
  }

  modifier updateCumulativeIndex(address stakeToken) {
    _updateCumulativeIndex(stakeToken);
    _;
  }

  /// @notice stake function with permit support
  /// (see stake(..) func for more info)
  function stakeWithPermit(
    address stakeToken,
    uint256 amount,
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
    _stake(_msgSender(), stakeToken, amount);
  }

  /// @notice stake tokens for give option
  /// @param stakeToken - stake token address
  /// @param amount - amount of tokens
  function stake(address stakeToken, uint256 amount) external {
    IERC20(stakeToken).safeTransferFrom(_msgSender(), address(this), amount);
    _stake(_msgSender(), stakeToken, amount);
  }

  /// @notice create a staking for user
  /// @param stakeToken - staking token,
  /// @param account - account, to create staking for,
  /// @param amount - amount of tokens
  function stakeFor(
    address stakeToken,
    uint256 amount,
    address account
  ) external {
    IERC20(stakeToken).safeTransferFrom(_msgSender(), address(this), amount);
    _stake(account, stakeToken, amount);
  }

  /// @notice internal function for stake logic implementation (without transfer tokens)
  /// @param account - address of user account
  /// @param stakeToken - stake token address,
  /// @param amount - amount of tokens,
  function _stake(
    address account,
    address stakeToken,
    uint256 amount
  )
    internal
    nonReentrant
    validStaking(stakeToken)
    whenStakingNotPaused(stakeToken)
    gtZero(amount)
    updateCumulativeIndex(stakeToken)
  {
    TokenStakeInfo storage tokenStake = tokenStakeInfo[stakeToken];

    tokenStake.totalStaked += amount;

    usersStake[account].push(
      StakeInfo(
        stakeToken,
        amount,
        tokenStake.cumulativeIndex,
        block.timestamp,
        0,
        0
      )
    );

    emit Stake(
      account,
      stakeToken,
      amount,
      block.timestamp,
      usersStake[account].length - 1
    );
  }

  function withdrawAllWithRewards(uint16 stakeIndex)
    external
    validStakeIndex(stakeIndex)
    updateCumulativeIndex(usersStake[_msgSender()][stakeIndex].stakeToken)
  {
    StakeInfo memory _userStake = usersStake[_msgSender()][stakeIndex];
    TokenStakeInfo memory _stakeInfo = tokenStakeInfo[_userStake.stakeToken];

    _recalculateUserStakeRewards(_userStake);

    _withdrawWithoutRewards(
      _msgSender(),
      stakeIndex,
      _userStake,
      _stakeInfo,
      _userStake.amount
    );

    _claimStakeRewards(_msgSender(), stakeIndex, _userStake, _stakeInfo);

    _onAfterClaimOrWithdraw(_msgSender(), stakeIndex, _userStake, _stakeInfo);
  }

  function withdrawWithoutRewards(uint16 stakeIndex, uint256 amountToWithdraw)
    external
    validStakeIndex(stakeIndex)
    updateCumulativeIndex(usersStake[_msgSender()][stakeIndex].stakeToken)
  {
    StakeInfo memory _userStake = usersStake[_msgSender()][stakeIndex];
    TokenStakeInfo memory _stakeInfo = tokenStakeInfo[_userStake.stakeToken];

    _recalculateUserStakeRewards(_userStake);

    _withdrawWithoutRewards(
      _msgSender(),
      stakeIndex,
      _userStake,
      _stakeInfo,
      amountToWithdraw
    );

    _onAfterClaimOrWithdraw(_msgSender(), stakeIndex, _userStake, _stakeInfo);
  }

  function claimRewards(uint16 stakeIndex)
    external
    validStakeIndex(stakeIndex)
    updateCumulativeIndex(usersStake[_msgSender()][stakeIndex].stakeToken)
  {
    StakeInfo memory _userStake = usersStake[_msgSender()][stakeIndex];
    TokenStakeInfo memory _stakeInfo = tokenStakeInfo[_userStake.stakeToken];

    _recalculateUserStakeRewards(_userStake);

    require(_userStake.unclaimedRewards > 0, "claim: !rewards");

    _claimStakeRewards(_msgSender(), stakeIndex, _userStake, _stakeInfo);

    _onAfterClaimOrWithdraw(_msgSender(), stakeIndex, _userStake, _stakeInfo);
  }

  // /// @notice withdraw tokens from the contract.
  // /// Sender should be owner of _stakeToken staking
  // /// @param stakeToken - address of the stake token
  // /// @param withdrawToken - address of the token, that you want to withdraw
  // /// @param amount - amount to withdraw
  // function withdrawExtraTokens(
  //     address stakeToken,
  //     address withdrawToken,
  //     uint256 amount
  // ) external onlyTokenStakeOwner(stakeToken) {
  //     require(
  //         withdrawToken == tokenStakeInfo[stakeToken].rewardToken,
  //         "!withdrawToken"
  //     );

  //     if (tokenStakeInfo[withdrawToken].totalStaked > 0)
  //         require(amount <= freeAmount(withdrawToken), "!free");

  //     IERC20(withdrawToken).safeTransfer(_msgSender(), amount);
  // }

  /// @notice set emission per second for all options
  function setEmissionPerDay(address stakeToken, uint256 emissionPerDay)
    external
    onlyTokenStakeOwner(stakeToken)
  {
    require(emissionPerDay > 0, "!emission");
    _setEmissionPerDay(stakeToken, emissionPerDay);
  }

  /// @notice set emission per second for all options
  function initializeStake(
    address stakeToken,
    uint256 initEmissionPerDay,
    address rewardToken
  ) external onlyTokenStakeOwner(stakeToken) {
    require(
      tokenStakeInfo[stakeToken].rewardToken == address(0),
      "already initialized"
    );

    require(initEmissionPerDay > 0, "!emission");
    require(rewardToken != address(0), "!rewardToken");

    _setEmissionPerDay(stakeToken, initEmissionPerDay);

    tokenStakeInfo[stakeToken].rewardToken = rewardToken;
  }

  /// @notice returns all stakes of user
  function getUserStakes(address user)
    external
    view
    returns (StakeInfo[] memory)
  {
    return usersStake[user];
  }

  /// @notice calculates current rewards by index of stake
  function calcRewardsByIndex(address user, uint16 stakeIndex)
    external
    view
    returns (uint256 rewards)
  {
    return _calcRewards(usersStake[user][stakeIndex]);
  }

  // /// @notice returns how many tokens is free in particular staking
  // function freeAmount(address token) public view returns (uint256) {
  //     uint256 balance = IERC20(token).balanceOf(address(this));
  //     return
  //         balance > tokenStakeInfo[token].totalStaked
  //             ? balance - tokenStakeInfo[token].totalStaked
  //             : 0;
  // }

  /// @notice Calculate cumulative index
  function calculateCumulativeIndex(address stakeToken)
    public
    view
    returns (uint256 index)
  {
    TokenStakeInfo memory info = tokenStakeInfo[stakeToken];

    if (info.totalStaked > 0) {
      index =
        info.cumulativeIndex +
        ((block.timestamp - info.lastUpdatedTimestamp) *
          info.emissionPerSecond *
          10**18) /
        info.totalStaked;
    } else {
      index = info.cumulativeIndex;
    }
  }

  function _withdrawWithoutRewards(
    address _user,
    uint16 _stakeIndex,
    StakeInfo memory _userStake,
    TokenStakeInfo memory _stakeInfo,
    uint256 _amountToWithdraw
  ) internal gtZero(_amountToWithdraw) {
    require(
      _amountToWithdraw <= _userStake.amount,
      "withdraw: !amountToWithdraw"
    );

    _stakeInfo.totalStaked -= _amountToWithdraw;
    _userStake.amount -= _amountToWithdraw;

    IERC20(_userStake.stakeToken).safeTransfer(_user, _amountToWithdraw);

    emit Withdraw(
      _user,
      _userStake.stakeToken,
      _amountToWithdraw,
      block.timestamp,
      _stakeIndex
    );
  }

  function _claimStakeRewards(
    address _user,
    uint16 _stakeIndex,
    StakeInfo memory _userStake,
    TokenStakeInfo memory _stakeInfo
  ) internal {
    // require(
    //     freeAmount(_stakeInfo.rewardToken) >= _userStake.unclaimedRewards,
    //     "claim !freeAmount"
    // );
    uint256 toClaimRewards = _userStake.unclaimedRewards;

    _userStake.claimed += _userStake.unclaimedRewards;
    _userStake.unclaimedRewards = 0;

    IERC20(_stakeInfo.rewardToken).safeTransfer(_user, toClaimRewards);

    emit Claim(
      _user,
      _userStake.stakeToken,
      toClaimRewards,
      block.timestamp,
      _stakeIndex
    );
  }

  function _setEmissionPerDay(address _stakeToken, uint256 _initEmissionPerDay)
    internal
    updateCumulativeIndex(_stakeToken)
  {
    tokenStakeInfo[_stakeToken].emissionPerSecond =
      _initEmissionPerDay /
      24 /
      60 /
      60;
  }

  function _updateCumulativeIndex(address _stakeToken) internal {
    tokenStakeInfo[_stakeToken].cumulativeIndex = calculateCumulativeIndex(
      _stakeToken
    );

    tokenStakeInfo[_stakeToken].lastUpdatedTimestamp = block.timestamp;
  }

  /// @dev needed to remove stake, if its already done
  /// operates with storage, so needs to be called only
  /// after all operations with user stakes
  function _removeStakingIfDone(address _user, uint16 _stakeIndex) internal {
    if (
      usersStake[_user][_stakeIndex].amount != 0 ||
      usersStake[_user][_stakeIndex].unclaimedRewards != 0
    ) {
      return;
    }

    usersStake[_user][_stakeIndex] = usersStake[_user][
      usersStake[_user].length - 1
    ];
    usersStake[_user].pop();
  }

  function _onAfterClaimOrWithdraw(
    address _user,
    uint16 _stakeIndex,
    StakeInfo memory _userStake,
    TokenStakeInfo memory _stakeInfo
  ) internal {
    usersStake[_user][_stakeIndex] = _userStake;
    tokenStakeInfo[_userStake.stakeToken] = _stakeInfo;
    _removeStakingIfDone(_msgSender(), _stakeIndex);
  }

  /// @notice calculate rewards and check if user can claim/withdraw tokens
  function _calcRewards(StakeInfo memory _userStake)
    internal
    view
    returns (uint256 rewards)
  {
    rewards =
      ((tokenStakeInfo[_userStake.stakeToken].cumulativeIndex -
        _userStake.lastCI) * _userStake.amount) /
      10**18;

    if (rewards > _userStake.claimed + _userStake.unclaimedRewards)
      rewards -= (_userStake.claimed + _userStake.unclaimedRewards);
    else rewards = 0;
  }

  function _recalculateUserStakeRewards(StakeInfo memory _userStake)
    internal
    view
  {
    _userStake.unclaimedRewards += _calcRewards(_userStake);
  }
}
