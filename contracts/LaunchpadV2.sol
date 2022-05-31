// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contract-0.6.0/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contract-0.6.0/token/ERC20/IERC20.sol";
import "@openzeppelin/contract-0.6.0/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contract-0.6.0/access/Ownable.sol";
import "@openzeppelin/contract-0.6.0/math/SafeMath.sol";
import "@openzeppelin/contract-0.6.0/utils/ReentrancyGuard.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

import "./ERC1155ReceiverImplementation.sol";
import "./passTicket/PassTicket.sol";

contract LaunchpadV2 is
    ERC1155ReceiverImplementation,
    Ownable,
    ReentrancyGuard
{
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    enum DepositTokenType {
        MMPRO,
        MMPRO_BUSD_LP
    }

    // Info of each user.
    struct UserInfo {
        uint256 depositedLp;
        uint256 depositedLpMMrpoShare; // what is MMPRO equivalent of deposited LPs
        uint256 depositedMMpro; // How many MMPro tokens the user has provided.
        uint256 allocatedAmount; // How many lTokens are available to the user for purchase
        uint256 purchasedAmount; // How many lTokens the user has already bought
        uint256 rewardDebt;
        bool passTicketTaken;
        bool passTicketWithdrawn;
        uint256 passTicketId;
    }

    // Info of each pool.
    struct PoolInfo {
        address owner; // owner of this pool
        IERC20 lToken; // Launched Token
        uint256 lTokenPrice; // 5 digits LToken price (in stables) ex. 1:1 lTokenPrice=100000
        uint256 lTokenPerSec; // How many Token distributed per second
        uint256 depositLimit; // MMProToken deposit limit
        uint256 startTimestamp; // Staking start timestamp
        // uint64 for timestamps to pack variables
        // into sinle storage slot
        uint64 stakingEnd; // Staking duration in seconds
        uint64 purchaseEnd; // Purchase duration in seconds, start = startTimestamp+stakingDuration
        uint64 lockupEnd; // lTokens lockup duration, start = startTimestamp+stakingDuration + purchaseDuration
        uint64 lastRewardTimestamp; // Last timestamp that lTokens distribution occurs.
        uint256 sharesTotal; // total staked amount
        uint256 accLTokenPerShare; // Accumulated lTokens per share, times 1e18.
        uint256 totalBought;
    }

    struct PassTicketPoolInfo {
        bool requiresTicket;
        bool supportsGenericTicket;
        uint256 ticketId;
    }

    // Stablecoin contracts
    IERC20[] public stablesInfo;

    /*
    [
        IERC20(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56),//BUSD
        IERC20(0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d),//USDC
        IERC20(0x55d398326f99059fF775485246999027B3197955),//USDT
        IERC20(0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3)//DAI
    ];
    */

    // The MMpro TOKEN!
    IERC20 public immutable MMpro;

    // MMPRO/BUSD LP token
    IUniswapV2Pair public immutable MMproLp;
    // fee in basis points
    address public feeAddress;
    uint256 feeBP = 500;
    uint256 public constant FEE_MAX = 2000; // 20%
    uint256 public immutable allocationDelay;

    address public immutable passTicket;

    // Info of each pool.
    PoolInfo[] public poolInfo;

    // pId => passTicketInfo
    mapping(uint256 => PassTicketPoolInfo) public passTicketPoolInfo;
    // Info of each user that stakes MMPROtoken.
    mapping(address => mapping(uint256 => UserInfo)) public userInfo;

    mapping(address => uint256) public totalAllocation;
    mapping(uint256 => bool) public pickUpTokensAllowed;

    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event BuyToken(address indexed user, uint256 indexed pid, uint256 amount);
    event PickUpTokens(
        address indexed user,
        uint256 indexed pid,
        uint256 amount
    );
    event TakeAwayUnsold(uint256 indexed pid, uint256 amount);
    event SetFeeAddress(address indexed user, address indexed newAddress);
    event ChangeFeeBP(uint256 feeBP);
    event WithdrawPassTicket(
        uint256 indexed pid,
        address indexed user,
        uint256 indexed passTicketId
    );

    modifier onlyPoolOwner(uint256 _pid) {
        require(
            poolInfo[_pid].owner == msg.sender,
            "the caller is not a pool owner"
        );
        _;
    }

    constructor(
        IERC20 _MMpro,
        IUniswapV2Pair _MMproLp,
        address _feeAddress,
        IERC20[] memory _stablesInfo,
        uint256 _allocationDelay,
        address _passTicket
    ) public {
        require(address(_MMpro) != address(0), "!mmpro");
        require(address(_MMproLp) != address(0), "!mmproLp");
        require(
            _MMproLp.token0() == address(_MMpro) ||
                _MMproLp.token1() == address(_MMpro),
            "invalid lp token"
        );

        MMpro = _MMpro;
        MMproLp = _MMproLp;
        feeAddress = _feeAddress;
        stablesInfo = _stablesInfo;
        allocationDelay = _allocationDelay;
        passTicket = _passTicket;
    }

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    // Add a new pool. Can only be called by the owner.
    function add(
        address _poolOwner,
        IERC20 _lToken,
        uint256 _lTokenPrice,
        uint256 _tokensAllocationQty,
        uint256 _depositLimit,
        uint256 _startTimestamp,
        uint256 _stakingDuration,
        uint256 _purchaseDuration,
        uint256 _lockupDuration,
        bool _pickUpTokensAllowed,
        PassTicketPoolInfo memory _passTicketInfo
    ) external onlyOwner {
        require(address(_lToken) != address(MMpro), "_lToken same as MMpro");
        require(
            _tokensAllocationQty <=
                _lToken.balanceOf(address(this)).sub(
                    totalAllocation[address(_lToken)]
                ),
            "_tokensAllocationQty has been exceeded"
        );
        require(
            _stakingDuration > allocationDelay,
            "_stakingDuration is too small"
        );

        require(
            _tokensAllocationQty > _stakingDuration,
            "not enough tokens on the contract balance"
        );

        if (_passTicketInfo.supportsGenericTicket) {
            require(_passTicketInfo.requiresTicket, "!requiresTicket");
        }

        if (
            _passTicketInfo.requiresTicket &&
            _passTicketInfo.supportsGenericTicket == false
        ) {
            require(_passTicketInfo.ticketId != 0, "!genericSupport");
        }

        totalAllocation[address(_lToken)] = totalAllocation[address(_lToken)]
            .add(_tokensAllocationQty);
        {
            uint256 startTimestamp = block.timestamp > _startTimestamp
                ? block.timestamp
                : _startTimestamp;

            PoolInfo memory _poolInfo = PoolInfo({
                owner: _poolOwner,
                lToken: _lToken,
                lTokenPrice: _lTokenPrice,
                lTokenPerSec: _tokensAllocationQty.div(
                    _stakingDuration.sub(allocationDelay)
                ),
                depositLimit: _depositLimit,
                startTimestamp: startTimestamp,
                stakingEnd: uint64(startTimestamp.add(_stakingDuration)),
                purchaseEnd: uint64(
                    startTimestamp.add(_stakingDuration).add(_purchaseDuration)
                ),
                lockupEnd: uint64(
                    startTimestamp
                        .add(_stakingDuration)
                        .add(_purchaseDuration)
                        .add(_lockupDuration)
                ),
                sharesTotal: 0,
                lastRewardTimestamp: uint64(
                    startTimestamp.add(allocationDelay)
                ),
                accLTokenPerShare: 0,
                totalBought: 0
            });

            passTicketPoolInfo[poolInfo.length] = _passTicketInfo;
            poolInfo.push(_poolInfo);
        }
        pickUpTokensAllowed[poolInfo.length - 1] = _pickUpTokensAllowed;
    }

    function changeFee(uint256 _feeBP) external onlyOwner {
        require(_feeBP <= FEE_MAX, "changeFee: the fee is too high");
        feeBP = _feeBP;
        emit ChangeFeeBP(_feeBP);
    }

    function setFeeAddress(address _feeAddress) external onlyOwner {
        feeAddress = _feeAddress;
        emit SetFeeAddress(msg.sender, _feeAddress);
    }

    // View function to see pending lToken allocation on frontend.
    function pendingAllocation(uint256 _pid, address _user)
        external
        view
        returns (uint256)
    {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_user][_pid];
        uint256 accLTokenPerShare = pool.accLTokenPerShare;
        uint256 lpSupply = pool.sharesTotal;
        if (
            block.timestamp > pool.lastRewardTimestamp &&
            pool.lastRewardTimestamp < pool.stakingEnd &&
            lpSupply != 0
        ) {
            uint256 multiplier = block.timestamp > pool.stakingEnd
                ? uint256(pool.stakingEnd).sub(pool.lastRewardTimestamp)
                : block.timestamp.sub(pool.lastRewardTimestamp);

            uint256 reward = multiplier.mul(pool.lTokenPerSec);
            accLTokenPerShare = accLTokenPerShare.add(
                reward.mul(1e18).div(lpSupply)
            );
        }
        return
            user
                .depositedMMpro
                .add(user.depositedLpMMrpoShare)
                .mul(accLTokenPerShare)
                .div(1e18)
                .sub(user.rewardDebt);
    }

    // Update reward variables of the given pool to be up-to-date.
    function updatePool(uint256 _pid) public {
        PoolInfo memory pool = poolInfo[_pid];
        _updatePool(pool);
        poolInfo[_pid] = pool;
    }

    // Deposit MMpro tokens for lTokens allocation.
    function deposit(
        uint256 _pid,
        DepositTokenType depositTokenType,
        uint256 _amount
    ) public nonReentrant {
        PoolInfo memory pool = poolInfo[_pid];

        require(
            block.timestamp > pool.startTimestamp &&
                block.timestamp <= pool.stakingEnd,
            "deposit: not time to deposit"
        );

        _updatePool(pool);

        UserInfo memory user = userInfo[msg.sender][_pid];

        PassTicketPoolInfo memory passTicketInfo = passTicketPoolInfo[_pid];

        if (passTicketInfo.requiresTicket && !user.passTicketTaken)
            (user.passTicketTaken, user.passTicketId) = _takePassTicket(
                msg.sender,
                passTicketInfo
            );

        _updateUserAllocatedAmount(pool, user);

        if (_amount > 0) {
            if (depositTokenType == DepositTokenType.MMPRO) {
                user.depositedMMpro = user.depositedMMpro.add(_amount);
                pool.sharesTotal = pool.sharesTotal.add(_amount);

                MMpro.safeTransferFrom(
                    address(msg.sender),
                    address(this),
                    _amount
                );
            } else {
                // recalculates the amout of shares for provided LPs
                // because share in LP can be changed from time to time
                pool.sharesTotal = pool.sharesTotal.sub(
                    user.depositedLpMMrpoShare
                );

                user.depositedLp = user.depositedLp.add(_amount);
                user.depositedLpMMrpoShare = calculateMmproShareFromLpToken(
                    user.depositedLp
                );

                pool.sharesTotal = pool.sharesTotal.add(
                    user.depositedLpMMrpoShare
                );

                IERC20(address(MMproLp)).safeTransferFrom(
                    address(msg.sender),
                    address(this),
                    _amount
                );
            }
            _checkDepositLimitExceeded(pool, user);
        }

        user.rewardDebt = user
            .depositedMMpro
            .add(user.depositedLpMMrpoShare)
            .mul(pool.accLTokenPerShare)
            .div(1e18);

        poolInfo[_pid] = pool;
        userInfo[msg.sender][_pid] = user;
        emit Deposit(msg.sender, _pid, _amount);
    }

    // Withdraw MMpro/MMPRO-LP tokens.
    function withdraw(
        uint256 _pid,
        DepositTokenType depositTokenType,
        uint256 _amount,
        bool withdrawPass
    ) public nonReentrant {
        PoolInfo memory pool = poolInfo[_pid];
        require(
            block.timestamp > pool.stakingEnd,
            "withdraw: not time to withdraw"
        );
        UserInfo memory user = userInfo[msg.sender][_pid];

        _updatePool(pool);

        _updateUserAllocatedAmount(pool, user);

        if (_amount > 0) {
            if (depositTokenType == DepositTokenType.MMPRO) {
                require(
                    user.depositedMMpro >= _amount,
                    "withdraw: _amount MMPRO not good"
                );

                user.depositedMMpro = user.depositedMMpro.sub(_amount);
                pool.sharesTotal = pool.sharesTotal.sub(_amount);
                MMpro.safeTransfer(address(msg.sender), _amount);
            } else {
                require(
                    user.depositedLp >= _amount,
                    "withdraw: _amount MMPRO_LP not good"
                );

                pool.sharesTotal = pool.sharesTotal.sub(
                    user.depositedLpMMrpoShare
                );

                user.depositedLp = user.depositedLp.sub(_amount);
                user.depositedLpMMrpoShare = calculateMmproShareFromLpToken(
                    user.depositedLp
                );

                pool.sharesTotal = pool.sharesTotal.add(
                    user.depositedLpMMrpoShare
                );

                _checkDepositLimitExceeded(pool, user);

                IERC20(address(MMproLp)).safeTransfer(
                    address(msg.sender),
                    _amount
                );
            }
        }

        user.rewardDebt = user
            .depositedMMpro
            .add(user.depositedLpMMrpoShare)
            .mul(pool.accLTokenPerShare)
            .div(1e18);

        if (withdrawPass) {
            _withdrawPassTicket(_pid, user);
        }

        poolInfo[_pid] = pool;
        userInfo[msg.sender][_pid] = user;

        emit Withdraw(msg.sender, _pid, _amount);
    }

    function buyToken(
        uint256 _pid,
        uint256 _amount,
        uint256 stableId
    ) public nonReentrant {
        require(
            stableId < stablesInfo.length,
            "buyToken: stableId out of range"
        );
        PoolInfo memory pool = poolInfo[_pid];

        require(
            block.timestamp > pool.stakingEnd &&
                block.timestamp <= pool.purchaseEnd,
            "buyToken: not time to buy"
        );

        UserInfo memory user = userInfo[msg.sender][_pid];

        _updatePool(pool);

        _updateUserAllocatedAmount(pool, user);

        uint256 stableTokenAmount = pool.lTokenPrice.mul(_amount).div(1e5);

        if (stableTokenAmount > 0) {
            require(
                user.allocatedAmount >= _amount,
                "buyToken: _amount not good"
            );

            user.allocatedAmount = user.allocatedAmount.sub(_amount);
            user.purchasedAmount = user.purchasedAmount.add(_amount);
            pool.totalBought = pool.totalBought.add(_amount);

            IERC20 stableToken = stablesInfo[stableId];
            uint256 feeAmount = stableTokenAmount.mul(feeBP).div(10000);
            if (feeAmount > 0) {
                stableTokenAmount = stableTokenAmount.sub(feeAmount);
                stableToken.safeTransferFrom(
                    address(msg.sender),
                    feeAddress,
                    feeAmount
                );
            }
            stableToken.safeTransferFrom(
                address(msg.sender),
                pool.owner,
                stableTokenAmount
            );
            emit BuyToken(msg.sender, _pid, _amount);
        }

        poolInfo[_pid] = pool;
        userInfo[msg.sender][_pid] = user;
    }

    function pickUpTokens(uint256 _pid) public nonReentrant {
        require(pickUpTokensAllowed[_pid], " not allowed");
        PoolInfo storage pool = poolInfo[_pid];
        require(
            block.timestamp > pool.lockupEnd,
            "pickUpTokens: tokens are still locked"
        );
        UserInfo storage user = userInfo[msg.sender][_pid];
        uint256 amount = user.purchasedAmount;
        user.purchasedAmount = 0;
        if (amount > 0) {
            pool.lToken.safeTransfer(msg.sender, amount);
            emit PickUpTokens(msg.sender, _pid, amount);
        }
    }

    function takeAwayUnsold(uint256 _pid) external onlyPoolOwner(_pid) {
        PoolInfo storage pool = poolInfo[_pid];
        require(
            block.timestamp > pool.purchaseEnd,
            "takeAwayUnsold: the sale is not over yet"
        );

        uint256 unsoldAmount = pool
            .lTokenPerSec
            .mul(
                uint256(pool.stakingEnd).sub(
                    pool.startTimestamp.add(allocationDelay)
                )
            )
            .sub(pool.totalBought);

        uint256 lTokenLeft = pool.lToken.balanceOf(address(this));

        if (unsoldAmount > lTokenLeft) {
            unsoldAmount = lTokenLeft;
        }
        if (unsoldAmount > 0) {
            pool.lToken.safeTransfer(msg.sender, unsoldAmount);
            emit TakeAwayUnsold(_pid, unsoldAmount);
        }
    }

    function withdrawPassTicket(uint256 pid) external {
        PoolInfo storage pool = poolInfo[pid];
        UserInfo memory user = userInfo[msg.sender][pid];

        require(block.timestamp > pool.stakingEnd, "!time");

        _withdrawPassTicket(pid, user);

        userInfo[msg.sender][pid] = user;
    }

    function calculateMmproShareFromLpToken(uint256 lpAmount)
        public
        view
        returns (uint256)
    {
        if (lpAmount == 0) return 0;

        uint256 lpTs = MMproLp.totalSupply();

        if (lpAmount > lpTs) return 0;

        address token0 = MMproLp.token0();
        (uint256 reserv0, uint256 reserve1, ) = MMproLp.getReserves();

        uint256 mmroReserve = token0 == address(MMpro) ? reserv0 : reserve1;

        return lpAmount.mul(mmroReserve).div(lpTs);
    }

    function _updatePool(PoolInfo memory pool) internal view {
        if (
            block.timestamp <= pool.lastRewardTimestamp ||
            pool.lastRewardTimestamp >= pool.stakingEnd
        ) {
            return;
        }

        if (pool.sharesTotal == 0) {
            pool.lastRewardTimestamp = uint64(block.timestamp);
            return;
        }

        uint256 multiplier = block.timestamp > pool.stakingEnd
            ? uint256(pool.stakingEnd).sub(pool.lastRewardTimestamp)
            : block.timestamp.sub(pool.lastRewardTimestamp);

        uint256 reward = multiplier.mul(pool.lTokenPerSec);
        pool.accLTokenPerShare = pool.accLTokenPerShare.add(
            reward.mul(1e18).div(pool.sharesTotal)
        );

        pool.lastRewardTimestamp = uint64(block.timestamp);
    }

    function _withdrawPassTicket(uint256 pid, UserInfo memory user) internal {
        require(passTicketPoolInfo[pid].requiresTicket, "!withdraw ticket");
        require(!user.passTicketWithdrawn, "ticket withdrawn");

        user.passTicketWithdrawn = true;

        _transferTicketFrom(address(this), msg.sender, user.passTicketId);

        emit WithdrawPassTicket(pid, msg.sender, user.passTicketId);
    }

    function _transferTicketFrom(
        address from,
        address to,
        uint256 ticketId
    ) internal {
        ERC1155(passTicket).safeTransferFrom(from, to, ticketId, 1, "");
    }

    function _takePassTicket(
        address takeFrom,
        PassTicketPoolInfo memory passTicketInfo
    ) internal returns (bool ticketTook, uint256 tookTicketId) {
        if (!passTicketInfo.requiresTicket) return (false, 0);

        try
            ERC1155(passTicket).safeTransferFrom(
                takeFrom,
                address(this),
                passTicketInfo.ticketId,
                1,
                ""
            )
        {
            return (true, passTicketInfo.ticketId);
        } catch {
            if (
                !passTicketInfo.supportsGenericTicket ||
                passTicketInfo.ticketId == 0
            ) revert("!ticket");

            // if generic MMPRO pass supports - try to transfer it
            // 0 - mmpro generic pass id
            _transferTicketFrom(takeFrom, address(this), 0);

            return (true, 0);
        }
    }

    function _checkDepositLimitExceeded(
        PoolInfo memory pool,
        UserInfo memory user
    ) internal pure {
        require(
            pool.depositLimit == 0 ||
                user.depositedMMpro.add(user.depositedLpMMrpoShare) <=
                pool.depositLimit,
            "deposit limit exceeded"
        );
    }

    function _updateUserAllocatedAmount(
        PoolInfo memory pool,
        UserInfo memory user
    ) internal pure {
        if (user.depositedMMpro > 0 || user.depositedLpMMrpoShare > 0) {
            user.allocatedAmount = user.allocatedAmount.add(
                user
                    .depositedMMpro
                    .add(user.depositedLpMMrpoShare)
                    .mul(pool.accLTokenPerShare)
                    .div(1e18)
                    .sub(user.rewardDebt)
            );
        }
    }
}
