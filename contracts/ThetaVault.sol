// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "./interfaces/IThetaVault.sol";
import "./interfaces/IRequestManager.sol";
import "./external/IUniswapV2Pair.sol";
import "./external/IUniswapV2Router02.sol";
import "./external/IUniswapV2Factory.sol";

contract ThetaVault is Initializable, IThetaVault, IRequestManager, OwnableUpgradeable, ERC20Upgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    struct Request {
        uint8 requestType; // 1 => deposit, 2 => withdraw
        uint168 tokenAmount;
        uint32 targetTimestamp;
        address owner;
    }

    uint8 public constant DEPOSIT_REQUEST_TYPE = 1;
    uint8 public constant WITHDRAW_REQUEST_TYPE = 2;

    uint256 public constant PRECISION_DECIMALS = 1e10;
    uint16 public constant MAX_PERCENTAGE = 10000;

    address public fulfiller;

    IERC20Upgradeable public token;
    IPlatform public platform;
    IVolatilityToken public override volToken;
    IUniswapV2Router02 public router;
    uint8 public leverage;

    uint256 public override nextRequestId;
    mapping(uint256 => Request) public override requests;
    mapping(address => uint256) public lastDepositTimestamp;

    uint256 public initialTokenToThetaTokenRate;

    uint256 public totalDepositRequestsAmount;
    uint256 public totalVaultLeveragedAmount;

    uint16 public minPoolSkewPercentage;
    uint16 public extraLiqidityPercentage;
    uint256 public depositCap;
    uint256 public requestDelay;
    uint256 public lockupPeriod;
    uint256 public liquidationPeriod;

    uint256 public override minRequestId;
    uint256 public override maxMinRequestIncrements;

    function initialize(uint256 _initialTokenToThetaTokenRate, IPlatform _platform, uint8 _leverage, IVolatilityToken _volToken, IERC20Upgradeable _token, IUniswapV2Router02 _router, string memory _lpTokenName, string memory _lpTokenSymbolName) public initializer {
        require(address(_platform) != address(0));
        require(address(_volToken) != address(0));
        require(address(_token) != address(0));
        require(address(_router) != address(0));
        require(_initialTokenToThetaTokenRate > 0);

        nextRequestId = 1;
        minRequestId = 1;
        initialTokenToThetaTokenRate = _initialTokenToThetaTokenRate;
        minPoolSkewPercentage = 300;
        extraLiqidityPercentage = 1500;
        depositCap = type(uint256).max;
        requestDelay = 0.5 hours;
        lockupPeriod = 24 hours;
        liquidationPeriod = 3 days;
        maxMinRequestIncrements = 30;

        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();
        OwnableUpgradeable.__Ownable_init();
        ERC20Upgradeable.__ERC20_init(_lpTokenName, _lpTokenSymbolName);

        platform = _platform;
        token = _token;
        volToken = _volToken;
        router = _router;
        leverage = _leverage;

        token.safeApprove(address(platform), type(uint256).max);
        token.safeApprove(address(router), type(uint256).max);
        token.safeApprove(address(volToken), type(uint256).max);
        IERC20Upgradeable(address(volToken)).safeApprove(address(router), type(uint256).max);
        IERC20Upgradeable(address(getPair())).safeApprove(address(router), type(uint256).max);
        IERC20Upgradeable(address(volToken)).safeApprove(address(volToken), type(uint256).max);
    }

    function submitDepositRequest(uint168 _tokenAmount) external override nonReentrant returns (uint256 requestId) {
        return submitRequest(DEPOSIT_REQUEST_TYPE, _tokenAmount);
    }

    function submitWithdrawRequest(uint168 _thetaTokenAmount) external override nonReentrant returns (uint256 requestId) {
        require(lastDepositTimestamp[msg.sender] + lockupPeriod <= block.timestamp, "Deposit locked");
        return submitRequest(WITHDRAW_REQUEST_TYPE, _thetaTokenAmount);
    }

    struct FulfillDepositLocals {
        uint256 mintVolTokenUSDCAmount;
        uint256 addedLiquidityUSDCAmount;
        uint256 mintedVolTokenAmount;
        uint256 platformLiquidityAmount;
    }

    function fulfillDepositRequest(uint256 _requestId) external override nonReentrant returns (uint256 thetaTokensMinted) {
        uint168 amountToFulfill;
        address owner;
        uint256 volTokenPositionBalance;

        {
            (amountToFulfill, owner) = preFulfillRequest(_requestId, requests[_requestId], DEPOSIT_REQUEST_TYPE);

            // Note: reverts if pool is skewed after arbitrage, as intended
            uint256 balance;
            (balance,,, volTokenPositionBalance,) = totalBalanceWithArbitrage(amountToFulfill);

            // Mint theta lp tokens
            if (totalSupply() > 0 && balance > 0) {
                thetaTokensMinted = (amountToFulfill * totalSupply()) / balance;
            } else {
                thetaTokensMinted = amountToFulfill * initialTokenToThetaTokenRate;
            }
        }

        require(thetaTokensMinted > 0, "Too few tokens");
        _mint(owner, thetaTokensMinted);

        lastDepositTimestamp[owner] = block.timestamp;

        // Avoid crashing in case an old request existed when totalDepositRequestsAmount was initialized
        if (totalDepositRequestsAmount < amountToFulfill) {
            totalDepositRequestsAmount = 0;
        } else {
            totalDepositRequestsAmount -= amountToFulfill;
        }

        FulfillDepositLocals memory locals = deposit(amountToFulfill, volTokenPositionBalance);

        emit FulfillDeposit(_requestId, owner, amountToFulfill, locals.platformLiquidityAmount, locals.mintVolTokenUSDCAmount, locals.mintedVolTokenAmount, 
            locals.addedLiquidityUSDCAmount, thetaTokensMinted);
    }

    function fulfillWithdrawRequest(uint256 _requestId) external override nonReentrant returns (uint256 tokenWithdrawnAmount) {
        (,, uint256 dexUSDCAmount, uint256 dexVolTokensAmount, uint256 marginDebt) = calculatePoolValueWithArbitrage(0);

        (uint168 amountToFulfill, address owner) = preFulfillRequest(
            _requestId,
            requests[_requestId],
            WITHDRAW_REQUEST_TYPE
        );

        uint256 removedVolTokensAmount;
        uint256 dexRemovedUSDC;
        uint256 burnedVolTokensUSDCAmount;

        uint256 poolLPTokensAmount = (amountToFulfill * IERC20Upgradeable(address(getPair())).balanceOf(address(this))) /
            totalSupply();
        if (poolLPTokensAmount > 0) {
            (removedVolTokensAmount, dexRemovedUSDC) = router.removeLiquidity(address(volToken), address(token), poolLPTokensAmount, 
                (poolLPTokensAmount * dexVolTokensAmount) / IERC20Upgradeable(address(getPair())).totalSupply(),
                (poolLPTokensAmount * dexUSDCAmount) / IERC20Upgradeable(address(getPair())).totalSupply(),
                address(this), block.timestamp);

            burnedVolTokensUSDCAmount = burnVolTokens(removedVolTokensAmount);
        }

        uint256 platformLPTokensToRemove = (amountToFulfill * IERC20Upgradeable(address(platform)).balanceOf(address(this))) / totalSupply();
        (, uint256 withdrawnLiquidity) = platform.withdrawLPTokens(platformLPTokensToRemove);

        tokenWithdrawnAmount = withdrawnLiquidity + dexRemovedUSDC + burnedVolTokensUSDCAmount;
        totalVaultLeveragedAmount -= (burnedVolTokensUSDCAmount + marginDebt + withdrawnLiquidity);

        _burn(address(this), amountToFulfill);

        token.safeTransfer(owner, tokenWithdrawnAmount);

        emit FulfillWithdraw(_requestId, owner, tokenWithdrawnAmount, withdrawnLiquidity, removedVolTokensAmount, burnedVolTokensUSDCAmount, dexRemovedUSDC, amountToFulfill);
    }

    function liquidateRequest(uint256 _requestId) external override nonReentrant {
        Request memory request = requests[_requestId];
        require(request.requestType != 0, "Request id not found");
        require(request.targetTimestamp + liquidationPeriod >= block.timestamp, "Not liquidable");

        if (request.requestType == DEPOSIT_REQUEST_TYPE) {
            totalDepositRequestsAmount -= request.tokenAmount;
        }

        deleteRequest(_requestId);

        if (request.requestType == WITHDRAW_REQUEST_TYPE) {
            IERC20Upgradeable(address(this)).safeTransfer(request.owner, request.tokenAmount);
        } else {
            token.safeTransfer(request.owner, request.tokenAmount);
        }

        emit LiquidateRequest(_requestId, request.requestType, request.owner, msg.sender, request.tokenAmount);
    }

    function rebalance() external override onlyOwner {
        // Note: reverts if pool is skewed, as intended
        (, uint256 volTokenPositionBalance,,,) = calculatePoolValueWithArbitrage(0);

        (uint256 dexVolTokensAmount,) = getReserves();
        IERC20Upgradeable poolPair = IERC20Upgradeable(address(getPair()));
        uint256 dexVaultVolTokensAmount = (dexVolTokensAmount * poolPair.balanceOf(address(this))) / poolPair.totalSupply();

        (uint256 totalPositionUnits,,,,) = platform.positions(address(volToken));
        uint256 vaultPositionUnits = (totalPositionUnits * dexVaultVolTokensAmount) /
            IERC20Upgradeable(address(volToken)).totalSupply();

        uint256 adjustePositionUnits = (vaultPositionUnits * (MAX_PERCENTAGE + extraLiqidityPercentage)) / MAX_PERCENTAGE;

        require(totalVaultLeveragedAmount > adjustePositionUnits, "Not needed");

        uint256 extraLiquidityAmount = totalVaultLeveragedAmount - adjustePositionUnits;

        totalVaultLeveragedAmount = totalVaultLeveragedAmount - extraLiquidityAmount;

        (, uint256 withdrawnAmount) = platform.withdraw(extraLiquidityAmount, type(uint256).max);

        deposit(withdrawnAmount, volTokenPositionBalance);
    }

    function setFulfiller(address _newFulfiller) external override onlyOwner {
        fulfiller = _newFulfiller;
    }

    function setMinPoolSkew(uint16 _newMinPoolSkewPercentage) external override onlyOwner {
        minPoolSkewPercentage = _newMinPoolSkewPercentage;
    }

    function setExtraLiquidity(uint16 _newExtraLiquidityPercentage) external override onlyOwner {
        extraLiqidityPercentage = _newExtraLiquidityPercentage;
    }

    function setRequestDelay(uint256 _newRequestDelay) external override onlyOwner {
        requestDelay = _newRequestDelay;
    }

    function setDepositCap(uint256 _newDepositCap) external override onlyOwner {
        depositCap = _newDepositCap;
    }

    function setLockupPeriod(uint256 _newLockupPeriod) external override onlyOwner {
        lockupPeriod = _newLockupPeriod;
    }

    function setLiquidationPeriod(uint256 _newLiquidationPeriod) external override onlyOwner {
        liquidationPeriod = _newLiquidationPeriod;
    }

    function totalBalance() public view override returns (uint256 balance, uint256 usdcPlatformLiquidity, uint256 intrinsicDEXVolTokenBalance, uint256 volTokenPositionBalance, uint256 dexUSDCAmount) {
        (intrinsicDEXVolTokenBalance, volTokenPositionBalance, dexUSDCAmount,,,) = calculatePoolValue();
        (balance, usdcPlatformLiquidity) = _totalBalance(intrinsicDEXVolTokenBalance, dexUSDCAmount);
    }

    function totalBalanceWithArbitrage(uint256 _usdcArbitrageAmount) private returns (uint256 balance, uint256 usdcPlatformLiquidity, uint256 intrinsicDEXVolTokenBalance, uint256 volTokenPositionBalance, uint256 dexUSDCAmount) {
        (intrinsicDEXVolTokenBalance, volTokenPositionBalance, dexUSDCAmount,,) = calculatePoolValueWithArbitrage(
            _usdcArbitrageAmount
        );
        (balance, usdcPlatformLiquidity) = _totalBalance(intrinsicDEXVolTokenBalance, dexUSDCAmount);
    }

    function _totalBalance(uint256 _intrinsicDEXVolTokenBalance, uint256 _dexUSDCAmount) private view returns (uint256 balance, uint256 usdcPlatformLiquidity)
    {
        IERC20Upgradeable poolPair = IERC20Upgradeable(address(getPair()));
        uint256 poolLPTokens = poolPair.balanceOf(address(this));

        if (poolLPTokens == 0 || poolPair.totalSupply() == 0) {
            _intrinsicDEXVolTokenBalance = 0;
            _dexUSDCAmount = 0;
        } else {
            _intrinsicDEXVolTokenBalance = (_intrinsicDEXVolTokenBalance * poolLPTokens) / poolPair.totalSupply();
            _dexUSDCAmount = (_dexUSDCAmount * poolLPTokens) / poolPair.totalSupply();
        }

        usdcPlatformLiquidity = getUSDCPlatformLiquidity();

        balance = usdcPlatformLiquidity + _intrinsicDEXVolTokenBalance + _dexUSDCAmount;
    }

    function deposit(uint256 _tokenAmount, uint256 _volTokenPositionBalance) private returns (FulfillDepositLocals memory locals)
    {
        (uint256 dexVolTokensAmount, uint256 dexUSDCAmount) = getReserves();

        uint256 dexVolTokenPrice;
        uint256 intrinsicVolTokenPrice;
        bool dexHasLiquidity = true;

        if (dexVolTokensAmount == 0 || dexUSDCAmount == 0) {
            dexHasLiquidity = false;
        } else {
            intrinsicVolTokenPrice =
                (_volTokenPositionBalance * 10**ERC20Upgradeable(address(volToken)).decimals()) /
                IERC20Upgradeable(address(volToken)).totalSupply();
            dexVolTokenPrice = (dexUSDCAmount * 10**ERC20Upgradeable(address(volToken)).decimals()) / dexVolTokensAmount;
        }

        if (dexHasLiquidity) {
            (locals.mintVolTokenUSDCAmount, locals.platformLiquidityAmount) = calculateDepositAmounts(
                _tokenAmount,
                dexVolTokenPrice,
                intrinsicVolTokenPrice
            );

            platform.deposit(locals.platformLiquidityAmount, 0);
            (locals.addedLiquidityUSDCAmount, locals.mintedVolTokenAmount) = addDEXLiquidity(locals.mintVolTokenUSDCAmount);
        } else {
            locals.platformLiquidityAmount = _tokenAmount;
            platform.deposit(locals.platformLiquidityAmount, 0);
        }

        totalVaultLeveragedAmount += dexHasLiquidity ? locals.mintVolTokenUSDCAmount * leverage + locals.platformLiquidityAmount : locals.platformLiquidityAmount;
    }

    function calculatePoolValue() private view returns (uint256 intrinsicDEXVolTokenBalance, uint256 volTokenBalance, uint256 dexUSDCAmount, uint256 dexVolTokensAmount, uint256 marginDebt, bool isPoolSkewed) {
        (dexVolTokensAmount, dexUSDCAmount) = getReserves();

        bool isPositive = true;
        (uint256 currPositionUnits,,,,) = platform.positions(address(volToken));
        if (currPositionUnits != 0) {
            (volTokenBalance, isPositive,,,, marginDebt) = platform.calculatePositionBalance(address(volToken));
        }
        require(isPositive, "Negative balance");

        // No need to check skew if pool is still empty
        if (dexVolTokensAmount > 0 && dexUSDCAmount > 0) {
            // Multiply by vol token decimals to get intrinsic worth in USDC
            intrinsicDEXVolTokenBalance =
                (dexVolTokensAmount * volTokenBalance) /
                IERC20Upgradeable(address(volToken)).totalSupply();
            uint256 delta = intrinsicDEXVolTokenBalance > dexUSDCAmount ? intrinsicDEXVolTokenBalance - dexUSDCAmount : dexUSDCAmount - intrinsicDEXVolTokenBalance;

            if (delta > (intrinsicDEXVolTokenBalance * minPoolSkewPercentage) / MAX_PERCENTAGE) {
                isPoolSkewed = true;
            }
        }
    }

    function calculatePoolValueWithArbitrage(uint256 _usdcArbitrageAmount) private returns (uint256 intrinsicDEXVolTokenBalance, uint256 volTokenBalance, uint256 dexUSDCAmount, uint256 dexVolTokensAmount, uint256 marginDebt) {
        bool isPoolSkewed;
        (intrinsicDEXVolTokenBalance, volTokenBalance, dexUSDCAmount, dexVolTokensAmount, marginDebt, isPoolSkewed) = calculatePoolValue();

        if (isPoolSkewed) {
            attemptArbitrage(_usdcArbitrageAmount, intrinsicDEXVolTokenBalance, dexUSDCAmount);
            (intrinsicDEXVolTokenBalance, volTokenBalance, dexUSDCAmount, dexVolTokensAmount, marginDebt, isPoolSkewed) = calculatePoolValue();
            require(!isPoolSkewed, "Pool too skewed");
        }
    }

    function attemptArbitrage(uint256 _usdcAmount, uint256 _intrinsicDEXVolTokenBalance, uint256 _dexUSDCAmount) private {
        uint256 usdcAmountNeeded = _dexUSDCAmount > _intrinsicDEXVolTokenBalance ? (_dexUSDCAmount - _intrinsicDEXVolTokenBalance) / 2 : 
            (_intrinsicDEXVolTokenBalance - _dexUSDCAmount) / 2; // A good estimation to close arbitrage gap

        uint256 withdrawnLiquidity = 0;
        if (_usdcAmount < usdcAmountNeeded) {
            uint256 leftAmount = usdcAmountNeeded - _usdcAmount;

            // Get rest of amount needed from platform liquidity (will revert if not enough collateral)
            (, withdrawnLiquidity) = platform.withdrawLPTokens(
                (leftAmount * IERC20Upgradeable(address(platform)).totalSupply()) / platform.totalBalance(true)
            );
            usdcAmountNeeded = withdrawnLiquidity + _usdcAmount;
        }

        uint256 updatedUSDCAmount;
        if (_dexUSDCAmount > _intrinsicDEXVolTokenBalance) {
            // Price is higher than intrinsic value, mint at lower price, then buy on dex

            uint256 mintedVolTokenAmount = mintVolTokens(usdcAmountNeeded);

            address[] memory path = new address[](2);
            path[0] = address(volToken);
            path[1] = address(token);

            // Note: No need for slippage since we checked the price in this current block
            uint256[] memory amounts = router.swapExactTokensForTokens(mintedVolTokenAmount, 0, path, address(this), block.timestamp);

            updatedUSDCAmount = amounts[1];
        } else {
            // Price is lower than intrinsic value, buy on dex, then burn at higher price

            address[] memory path = new address[](2);
            path[0] = address(token);
            path[1] = address(volToken);

            // Note: No need for slippage since we checked the price in this current block
            uint256[] memory amounts = router.swapExactTokensForTokens(usdcAmountNeeded, 0, path, address(this), block.timestamp);

            updatedUSDCAmount = burnVolTokens(amounts[1]);
        }

        // Make sure we didn't lose by doing arbitrage (for example, mint/burn fees exceeds arbitrage gain)
        require(updatedUSDCAmount > usdcAmountNeeded, "Arbitrage failed");

        // Deposit arbitrage gains back to vault as platform liquidity as well
        platform.deposit(updatedUSDCAmount - usdcAmountNeeded, 0);
    }

    function preFulfillRequest(uint256 _requestId, Request memory _request, uint8 _expectedType) private returns (uint168 amountToFulfill, address owner) {
        require(_request.owner != address(0), "Invalid request id");
        require(msg.sender == fulfiller || msg.sender == _request.owner, "Not allowed");
        require(_request.requestType == _expectedType, "Wrong request type");
        require(block.timestamp >= _request.targetTimestamp, "Target time not reached");

        amountToFulfill = _request.tokenAmount;
        owner = _request.owner;

        deleteRequest(_requestId);
    }

    function submitRequest(uint8 _type, uint168 _tokenAmount) private returns (uint256 requestId) {
        require(_tokenAmount > 0, "Token amount must be positive");

        if (_type == DEPOSIT_REQUEST_TYPE) {
            collectRelevantTokens(_type, _tokenAmount);
            (uint256 balance,,,,) = totalBalanceWithArbitrage(_tokenAmount);
            require(balance + _tokenAmount + totalDepositRequestsAmount <= depositCap, "Deposit cap reached");
        } else {
            calculatePoolValueWithArbitrage(0);
        }

        requestId = nextRequestId;
        nextRequestId = nextRequestId + 1; // Overflow allowed to keep id cycling

        uint32 targetTimestamp = uint32(block.timestamp + requestDelay);

        requests[requestId] = Request(_type, _tokenAmount, targetTimestamp, msg.sender);

        if (_type == DEPOSIT_REQUEST_TYPE) {
            totalDepositRequestsAmount += _tokenAmount;
        } else {
            collectRelevantTokens(_type, _tokenAmount);
        }

        emit SubmitRequest(requestId, _type, _tokenAmount, targetTimestamp, msg.sender);
    }

    function calculateDepositAmounts(uint256 _totalAmount, uint256 _dexVolTokenPrice, uint256 _intrinsicVolTokenPrice) private view returns (uint256 mintVolTokenUSDCAmount, uint256 platformLiquidityAmount) {
        (uint256 cviValue,,) = platform.cviOracle().getCVILatestRoundData();

        uint256 maxCVIValue = platform.maxCVIValue();
        uint256 currentGain = 0;
        uint256 currentBalance;

        {
            (uint168 positionUnitsAmount,, uint16 openCVIValue,,) = platform.positions(address(volToken));

            if (positionUnitsAmount != 0) {
                bool isBalancePositive;
                uint256 marginDebt;
                (currentBalance, isBalancePositive,,,, marginDebt) = platform.calculatePositionBalance(address(volToken));

                uint256 originalBalance = (positionUnitsAmount * openCVIValue) / maxCVIValue;

                if (isBalancePositive && currentBalance > originalBalance - marginDebt) {
                    currentGain = currentBalance - (originalBalance - marginDebt);
                }
            }
        }

        mintVolTokenUSDCAmount = (_intrinsicVolTokenPrice * 
            (_totalAmount * MAX_PERCENTAGE * cviValue - currentGain * leverage * (maxCVIValue - cviValue) * (extraLiqidityPercentage + MAX_PERCENTAGE))) /
                (_intrinsicVolTokenPrice * leverage * extraLiqidityPercentage * (maxCVIValue - cviValue) + 
                    (_dexVolTokenPrice * cviValue + _intrinsicVolTokenPrice * leverage * maxCVIValue - _intrinsicVolTokenPrice * (leverage - 1) * cviValue) * MAX_PERCENTAGE);

        // Note: must be not-first mint (otherwise dex is empty, and this function won't be called)
        uint256 expectedMintedVolTokensAmount = (mintVolTokenUSDCAmount *
            IERC20Upgradeable(address(volToken)).totalSupply()) / currentBalance;

        (uint256 dexVolTokensAmount, uint256 dexUSDCAmount) = getReserves();
        uint256 usdcDEXAmount = (expectedMintedVolTokensAmount * dexUSDCAmount) / dexVolTokensAmount;

        platformLiquidityAmount = _totalAmount - mintVolTokenUSDCAmount - usdcDEXAmount;
    }

    function addDEXLiquidity(uint256 _mintVolTokensUSDCAmount) private returns (uint256 addedLiquidityUSDCAmount, uint256 mintedVolTokenAmount) {
        mintedVolTokenAmount = mintVolTokens(_mintVolTokensUSDCAmount);

        (uint256 dexVolTokenAmount, uint256 dexUSDCAmount) = getReserves();
        uint256 _usdcDEXAmount = (mintedVolTokenAmount * dexUSDCAmount) / dexVolTokenAmount;

        uint256 addedVolTokenAmount;

        (addedVolTokenAmount, addedLiquidityUSDCAmount,) = router.addLiquidity(address(volToken), address(token), mintedVolTokenAmount, _usdcDEXAmount, 
            mintedVolTokenAmount, _usdcDEXAmount, address(this), block.timestamp);

        require(addedLiquidityUSDCAmount == _usdcDEXAmount);
        require(addedVolTokenAmount == mintedVolTokenAmount);

        (dexVolTokenAmount, dexUSDCAmount) = getReserves();
    }

    function burnVolTokens(uint256 _tokensToBurn) private returns (uint256 burnedVolTokensUSDCAmount) {
        uint168 __tokensToBurn = uint168(_tokensToBurn);
        require(__tokensToBurn == _tokensToBurn); // Sanity, should very rarely fail
        burnedVolTokensUSDCAmount = volToken.burnTokens(__tokensToBurn);
    }

    function mintVolTokens(uint256 _usdcAmount) private returns (uint256 mintedVolTokenAmount) {
        uint168 __usdcAmount = uint168(_usdcAmount);
        require(__usdcAmount == _usdcAmount); // Sanity, should very rarely fail
        mintedVolTokenAmount = volToken.mintTokens(__usdcAmount);
    }

    function collectRelevantTokens(uint8 _requestType, uint256 _tokenAmount) private {
        if (_requestType == WITHDRAW_REQUEST_TYPE) {
            require(balanceOf(msg.sender) >= _tokenAmount, "Not enough tokens");
            IERC20Upgradeable(address(this)).safeTransferFrom(msg.sender, address(this), _tokenAmount);
        } else {
            token.safeTransferFrom(msg.sender, address(this), _tokenAmount);
        }
    }

    function deleteRequest(uint256 _requestId) private {
        delete requests[_requestId];

        uint256 currMinRequestId = minRequestId;
        uint256 increments = 0;
        bool didIncrement = false;

        while (currMinRequestId < nextRequestId && increments < maxMinRequestIncrements && requests[currMinRequestId].owner == address(0)) {
            increments++;
            currMinRequestId++;
            didIncrement = true;
        }

        if (didIncrement) {
            minRequestId = currMinRequestId;
        }
    }

    function getPair() private view returns (IUniswapV2Pair pair) {
        return IUniswapV2Pair(IUniswapV2Factory(router.factory()).getPair(address(volToken), address(token)));
    }

    function getReserves() public view override returns (uint256 volTokenAmount, uint256 usdcAmount) {
        (uint256 amount1, uint256 amount2,) = getPair().getReserves();

        if (address(volToken) < address(token)) {
            volTokenAmount = amount1;
            usdcAmount = amount2;
        } else {
            volTokenAmount = amount2;
            usdcAmount = amount1;
        }
    }

    function getUSDCPlatformLiquidity() private view returns (uint256 usdcPlatformLiquidity) {
        uint256 platformLPTokensAmount = IERC20Upgradeable(address(platform)).balanceOf(address(this));

        if (platformLPTokensAmount > 0) {
            usdcPlatformLiquidity = (platformLPTokensAmount * platform.totalBalance(true)) / IERC20Upgradeable(address(platform)).totalSupply();
        }
    }
}
