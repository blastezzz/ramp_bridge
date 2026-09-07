// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * RampStaking — lets holders lock $RAMP to unlock a lower RAMP routing fee.
 *
 * This is deliberately simple and self-contained (no external imports) so it
 * can be pasted straight into Remix with zero dependency setup:
 *   - No rewards/yield — staking here is purely a fee-tier gate, matching
 *     the site's "stake $RAMP -> pay less" copy. It doesn't mint or emit
 *     anything extra.
 *   - Non-custodial in the sense that matters: only the depositor can ever
 *     withdraw their own stake (owner has zero special access to funds).
 *   - Uses OpenZeppelin-style checks-effects-interactions + a reentrancy
 *     guard even though it's a test deployment — cheap insurance, no
 *     reason to skip it.
 *
 * Tiers match the site's fee-schedule table exactly (index.html ->
 * #stake -> .fee-table): amounts are in whole tokens, scaled by the
 * token's own decimals() at construction time.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

contract RampStaking {
    IERC20 public immutable rampToken;

    // fee in basis points (1 bp = 0.01%), lowest threshold first
    uint256 public constant BRONZE_MIN = 1_000;
    uint256 public constant SILVER_MIN = 10_000;
    uint256 public constant GOLD_MIN   = 50_000;

    uint16 public constant FEE_NONE_BPS   = 30; // 0.30%
    uint16 public constant FEE_BRONZE_BPS = 20; // 0.20%
    uint16 public constant FEE_SILVER_BPS = 12; // 0.12%
    uint16 public constant FEE_GOLD_BPS   = 5;  // 0.05%

    uint256 private immutable oneToken; // 1 * 10**decimals, precomputed once

    mapping(address => uint256) public stakedBalance;
    uint256 public totalStaked;

    bool private locked; // reentrancy guard

    event Staked(address indexed user, uint256 amount, uint256 newBalance);
    event Unstaked(address indexed user, uint256 amount, uint256 newBalance);

    error ZeroAmount();
    error InsufficientStake();
    error TransferFailed();
    error Reentrant();

    modifier nonReentrant() {
        if (locked) revert Reentrant();
        locked = true;
        _;
        locked = false;
    }

    constructor(address rampTokenAddress) {
        rampToken = IERC20(rampTokenAddress);
        oneToken = 10 ** IERC20(rampTokenAddress).decimals();
    }

    /// @notice Lock `amount` of $RAMP (in the token's smallest unit) into this contract.
    /// @dev Caller must `approve` this contract for `amount` first.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        if (!rampToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Staked(msg.sender, amount, stakedBalance[msg.sender]);
    }

    /// @notice Withdraw `amount` of previously staked $RAMP back to yourself.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = stakedBalance[msg.sender];
        if (amount > bal) revert InsufficientStake();
        stakedBalance[msg.sender] = bal - amount;
        totalStaked -= amount;
        if (!rampToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Unstaked(msg.sender, amount, stakedBalance[msg.sender]);
    }

    /// @notice Withdraw your entire stake in one call.
    function unstakeAll() external {
        uint256 bal = stakedBalance[msg.sender];
        if (bal > 0) {
            // re-enter the public function so the guard + event stay in one place
            this.unstake(bal);
        }
    }

    /// @notice Routing fee, in basis points, for `user` given their current stake.
    function feeBpsOf(address user) public view returns (uint16) {
        uint256 whole = stakedBalance[user] / oneToken;
        if (whole >= GOLD_MIN) return FEE_GOLD_BPS;
        if (whole >= SILVER_MIN) return FEE_SILVER_BPS;
        if (whole >= BRONZE_MIN) return FEE_BRONZE_BPS;
        return FEE_NONE_BPS;
    }

    /// @notice Human-readable tier name for `user` — handy for the frontend to display directly.
    function tierNameOf(address user) external view returns (string memory) {
        uint256 whole = stakedBalance[user] / oneToken;
        if (whole >= GOLD_MIN) return "gold";
        if (whole >= SILVER_MIN) return "silver";
        if (whole >= BRONZE_MIN) return "bronze";
        return "none";
    }
}
