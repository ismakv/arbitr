// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/v3-core/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * Flash loan arbitrage contract for Aave V3.
 * Borrows tokenA, swaps on DEX1 to tokenB, swaps back on DEX2, repays + keeps profit.
 */
contract FlashArb is FlashLoanSimpleReceiverBase, Ownable {
    struct SwapParams {
        address router;
        address[] path;
        uint256 minOut;
    }

    constructor(
        IPoolAddressesProvider provider
    )
        FlashLoanSimpleReceiverBase(provider)
        Ownable(msg.sender)
    {}

    function executeArbitrage(
        address flashLoanPool,
        address token,
        uint256 amount,
        SwapParams calldata swap1,
        SwapParams calldata swap2
    ) external onlyOwner {
        bytes memory params = abi.encode(swap1, swap2);

        POOL.flashLoanSimple(
            address(this),
            token,
            amount,
            params,
            0
        );
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "caller must be pool");
        require(initiator == address(this), "initiator must be this");

        (SwapParams memory swap1, SwapParams memory swap2) = abi.decode(
            params,
            (SwapParams, SwapParams)
        );

        // Approve router1
        IERC20(asset).approve(swap1.router, amount);

        // Swap 1: asset -> midToken on DEX1
        uint256[] memory amounts1 = IUniswapV2Router(swap1.router)
            .swapExactTokensForTokens(
                amount,
                swap1.minOut,
                swap1.path,
                address(this),
                block.timestamp + 300
            );

        uint256 midAmount = amounts1[amounts1.length - 1];
        address midToken = swap1.path[swap1.path.length - 1];

        // Approve router2
        IERC20(midToken).approve(swap2.router, midAmount);

        // Swap 2: midToken -> asset on DEX2
        IUniswapV2Router(swap2.router).swapExactTokensForTokens(
            midAmount,
            swap2.minOut,
            swap2.path,
            address(this),
            block.timestamp + 300
        );

        // Repay flash loan + premium
        uint256 totalOwed = amount + premium;
        IERC20(asset).approve(address(POOL), totalOwed);

        return true;
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }

    function withdrawNative() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }

    receive() external payable {}
}
