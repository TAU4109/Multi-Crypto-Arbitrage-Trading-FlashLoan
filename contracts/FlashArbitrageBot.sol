// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20 as OZIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    
    function exactInputSingle(ExactInputSingleParams calldata params) 
        external 
        payable 
        returns (uint256 amountOut);
}

interface IQuickSwapRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external 
        view 
        returns (uint256[] memory amounts);
}

contract FlashArbitrageBot is IFlashLoanRecipient, ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for OZIERC20;
    
    IVault private constant VAULT = IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    
    address public constant UNISWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant QUICKSWAP_ROUTER = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    
    mapping(address => bool) public authorizedCallers;
    uint256 public maxTradeSize = 100000 * 1e18;
    uint256 public minProfitThreshold = 1e16;
    uint256 private constant MAX_SLIPPAGE = 500;
    uint256 private constant BASIS_POINTS = 10000;
    
    struct ArbitrageParams {
        address tokenA;
        address tokenB;
        uint256 amount;
        uint256 minProfit;
        uint256 maxSlippage;
        uint8 sourceExchange;
        uint8 targetExchange;
        uint24 uniswapFee;
        address[] quickswapPath;
    }
    
    enum Exchange {
        UNISWAP,
        QUICKSWAP,
        SUSHISWAP
    }
    
    event ArbitrageExecuted(
        address indexed tokenA,
        address indexed tokenB,
        uint256 amount,
        uint256 profit,
        uint8 sourceExchange,
        uint8 targetExchange
    );
    
    event EmergencyStop(address indexed caller, uint256 timestamp);
    
    error InsufficientProfit();
    error SlippageExceeded();
    error UnauthorizedCaller();
    error InvalidTradeSize();
    error FlashLoanFailed();
    
    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender] && msg.sender != owner()) {
            revert UnauthorizedCaller();
        }
        _;
    }
    
    modifier profitabilityCheck(uint256 expectedProfit) {
        if (expectedProfit < minProfitThreshold) {
            revert InsufficientProfit();
        }
        _;
    }
    
    modifier validTradeSize(uint256 amount) {
        if (amount > maxTradeSize) {
            revert InvalidTradeSize();
        }
        _;
    }
    
    constructor() {
        authorizedCallers[msg.sender] = true;
    }
    
    function executeArbitrage(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        ArbitrageParams memory params
    ) 
        external 
        onlyAuthorized 
        nonReentrant 
        whenNotPaused 
        profitabilityCheck(params.minProfit)
        validTradeSize(params.amount)
    {
        bytes memory userData = abi.encode(params);
        VAULT.flashLoan(this, tokens, amounts, userData);
    }
    
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(VAULT), "Unauthorized flash loan callback");
        
        ArbitrageParams memory params = abi.decode(userData, (ArbitrageParams));
        
        uint256 profit = _performArbitrage(tokens[0], amounts[0], params);
        
        if (profit < params.minProfit) {
            revert InsufficientProfit();
        }
        
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 amountOwing = amounts[i] + feeAmounts[i];
            OZIERC20(address(tokens[i])).safeTransfer(address(VAULT), amountOwing);
        }
        
        emit ArbitrageExecuted(
            params.tokenA,
            params.tokenB,
            params.amount,
            profit,
            params.sourceExchange,
            params.targetExchange
        );
    }
    
    function _performArbitrage(
        IERC20 token,
        uint256 amount,
        ArbitrageParams memory params
    ) internal returns (uint256 profit) {
        uint256 balanceBefore = OZIERC20(address(token)).balanceOf(address(this));
        
        uint256 intermediateAmount;
        if (params.sourceExchange == uint8(Exchange.UNISWAP)) {
            intermediateAmount = _swapOnUniswap(
                params.tokenA,
                params.tokenB,
                amount,
                params.uniswapFee
            );
        } else if (params.sourceExchange == uint8(Exchange.QUICKSWAP)) {
            intermediateAmount = _swapOnQuickSwap(
                params.quickswapPath,
                amount
            );
        }
        
        uint256 finalAmount;
        if (params.targetExchange == uint8(Exchange.UNISWAP)) {
            finalAmount = _swapOnUniswap(
                params.tokenB,
                params.tokenA,
                intermediateAmount,
                params.uniswapFee
            );
        } else if (params.targetExchange == uint8(Exchange.QUICKSWAP)) {
            address[] memory reversePath = new address[](params.quickswapPath.length);
            for (uint i = 0; i < params.quickswapPath.length; i++) {
                reversePath[i] = params.quickswapPath[params.quickswapPath.length - 1 - i];
            }
            finalAmount = _swapOnQuickSwap(reversePath, intermediateAmount);
        }
        
        uint256 balanceAfter = OZIERC20(address(token)).balanceOf(address(this));
        profit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        
        return profit;
    }
    
    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        OZIERC20(tokenIn).safeApprove(UNISWAP_ROUTER, amountIn);
        
        IUniswapV3Router.ExactInputSingleParams memory params = IUniswapV3Router
            .ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });
        
        amountOut = IUniswapV3Router(UNISWAP_ROUTER).exactInputSingle(params);
    }
    
    function _swapOnQuickSwap(
        address[] memory path,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        OZIERC20(path[0]).safeApprove(QUICKSWAP_ROUTER, amountIn);
        
        uint256[] memory amounts = IQuickSwapRouter(QUICKSWAP_ROUTER)
            .swapExactTokensForTokens(
                amountIn,
                0,
                path,
                address(this),
                block.timestamp + 300
            );
        
        amountOut = amounts[amounts.length - 1];
    }
    
    function emergencyStop() external onlyAuthorized {
        _pause();
        emit EmergencyStop(msg.sender, block.timestamp);
    }
    
    function resume() external onlyOwner {
        _unpause();
    }
    
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
    }
    
    function setMaxTradeSize(uint256 _maxTradeSize) external onlyOwner {
        maxTradeSize = _maxTradeSize;
    }
    
    function setMinProfitThreshold(uint256 _minProfitThreshold) external onlyOwner {
        minProfitThreshold = _minProfitThreshold;
    }
    
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        OZIERC20(token).safeTransfer(owner(), amount);
    }
    
    function withdrawETH() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }
    
    receive() external payable {}
}