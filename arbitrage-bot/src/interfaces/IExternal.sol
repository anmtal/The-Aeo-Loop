// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal external interfaces used by the arbitrage contract.
/// @dev Kept lean on purpose — importing full vendor interfaces drags in code we never call.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Balancer V2 Vault flash loan. Balancer charges a 0% flash-loan fee, which is
///      why it is preferred over Aave (0.05%) for thin arbitrage margins.
interface IBalancerVault {
    function flashLoan(
        address recipient,
        IERC20[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

/// @dev Callback every Balancer flash-loan recipient must implement.
interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external;
}

/// @dev Uniswap V2 / Sushiswap-style router. We use the low-level pair swap in the
///      contract for gas, but the router interface documents the canonical math.
interface IUniswapV2Pair {
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data)
        external;
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @dev Uniswap V3 router (exactInputSingle) for V2<->V3 cross-DEX arbitrage.
interface ISwapRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
