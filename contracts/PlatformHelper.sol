
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "./interfaces/IStaking.sol";
import "./interfaces/IPlatformHelper.sol";

contract PlatformHelper is IPlatformHelper {
    uint16 private constant MAX_PERCENTAGE = 10000;

    IERC20 private govi;
    IStaking private staking;


    constructor(IERC20 _govi, IStaking _staking) {
        govi = _govi;
        staking = _staking;
    }

    function dailyFundingFee(IPlatform _platform) external view override returns (uint256 fundingFeePercent) {
        (uint16 cviValue,,) = _platform.cviOracle().getCVILatestRoundData();
        (, fundingFeePercent) = _platform.feesCalculator().calculateSingleUnitPeriodFundingFee(IFeesCalculator.CVIValue(1 days, cviValue), collateralRatio(_platform));
    }

    function fundingFeeValues(IPlatform _platform, uint16 _minCVI, uint16 _maxCVI, uint256 _minCollateral, uint256 _maxCollateral) external view override returns (uint256[][] memory fundingFeeRatePercent) {
        fundingFeeRatePercent = new uint256[][]((_maxCollateral - _minCollateral) / 100 + 1);
        uint256 currCollateralIndex = 0;
        for (uint256 currCollateral = _minCollateral; currCollateral <= _maxCollateral; currCollateral += 100) {
            uint256[] memory currValues = new uint256[]((_maxCVI - _minCVI) / 100 + 1);
            uint256 currCVIIndex = 0;
            for (uint16 currCVI = _minCVI; currCVI <= _maxCVI; currCVI += 100) {
                (,uint256 feePercent) = _platform.feesCalculator().calculateSingleUnitPeriodFundingFee(IFeesCalculator.CVIValue(1 days, currCVI), currCollateral);
                currValues[currCVIIndex] = feePercent;
                currCVIIndex += 1;
            }
            fundingFeeRatePercent[currCollateralIndex] = currValues;
            currCollateralIndex += 1;
        }
    }

    function collateralRatio(IPlatform _platform) public view override returns (uint256) {
        if (_platform.totalLeveragedTokensAmount() == 0) {
            return MAX_PERCENTAGE;
        }

        return _platform.totalPositionUnitsAmount() * _platform.PRECISION_DECIMALS() / _platform.totalLeveragedTokensAmount();
    }

    function volTokenIntrinsicPrice(IVolatilityToken _volToken) external view override returns (uint256) {
        require(IERC20(address(_volToken)).totalSupply() > 0, "No supply");

        uint256 volTokenBalance = calculateVolTokenPositionBalance(_volToken);

        return volTokenBalance * 10 ** ERC20(address(_volToken)).decimals() / IERC20(address(_volToken)).totalSupply();
    }

    function volTokenDexPrice(IThetaVault _thetaVault) external view override returns (uint256) {
        (uint256 volTokenAmount, uint256 usdcAmount) = _thetaVault.getReserves();
        require(volTokenAmount > 0 && usdcAmount > 0, "No liquidity");
        return usdcAmount * 10 ** ERC20(address(_thetaVault.volToken())).decimals() / volTokenAmount;
    }

    function calculatePreMintAmounts(IVolatilityToken _volToken, bool _isKeepers, uint256 _requestId, uint168 _usdcAmount, uint256 _timeWindow) external view override returns (uint168 netMintAmount, uint256 expectedVolTokensAmount, uint256 buyingPremiumFeePercentage) {
        {
            uint256 timeWindowFees = _usdcAmount * _volToken.requestFeesCalculator().calculateTimeDelayFee(_timeWindow) / MAX_PERCENTAGE;
            uint256 keepersFee = _isKeepers ? _volToken.requestFeesCalculator().calculateKeepersFee(_usdcAmount) : 0;

            //TODO: Function
            uint256 fulfillFees = 0;
            if (!_isKeepers) {
                IVolatilityToken.Request memory request;
                (,,,,, request.requestTimestamp, request.targetTimestamp, request.useKeepers,) = _volToken.requests(_requestId);

                if (!request.useKeepers || block.timestamp < request.targetTimestamp) {
                    fulfillFees = _usdcAmount * _volToken.requestFeesCalculator().calculateTimePenaltyFee(request) / MAX_PERCENTAGE;
                }
            }

            netMintAmount = _usdcAmount - uint168(timeWindowFees) - uint168(keepersFee) - uint168(fulfillFees);
        }

        {
            uint256 openPositionFee = netMintAmount * _volToken.platform().feesCalculator().openPositionFeePercent() / MAX_PERCENTAGE;

            (uint16 cviValue,,) = _volToken.platform().cviOracle().getCVILatestRoundData();

            uint256 maxPositionUnitsAmount = (netMintAmount - openPositionFee) * _volToken.leverage() * _volToken.platform().maxCVIValue() / cviValue;
            uint256 collateral = (_volToken.platform().totalPositionUnitsAmount() + maxPositionUnitsAmount) * _volToken.platform().PRECISION_DECIMALS() / 
                (_volToken.platform().totalLeveragedTokensAmount() + (netMintAmount - openPositionFee) * _volToken.leverage());

            uint256 buyingPremiumFee;
            (buyingPremiumFee, buyingPremiumFeePercentage) = 
                _volToken.platform().feesCalculator().calculateBuyingPremiumFee(netMintAmount, _volToken.leverage(), collateral, 0, false);

            netMintAmount = (netMintAmount - uint168(buyingPremiumFee) - uint168(openPositionFee)) / _volToken.leverage();
        }

        uint256 supply = IERC20(address(_volToken)).totalSupply();
        uint256 balance = calculateVolTokenPositionBalance(_volToken);
        if (supply > 0 && balance > 0) {
            expectedVolTokensAmount = uint256(netMintAmount) * supply / balance;
        } else {
            expectedVolTokensAmount = uint256(netMintAmount) * _volToken.initialTokenToLPTokenRate();
        }
    }

    function calculatePreBurnAmounts(IVolatilityToken _volToken, bool _isKeepers, uint256 _requestId, uint256 _volTokensAmount, uint256 _timeWindow) external view override returns (uint256 netBurnAmount, uint256 expectedUSDCAmount) {
        IPlatform platform = _volToken.platform();
        uint256 burnUSDCAmountBeforeFees = _volTokensAmount * calculateVolTokenPositionBalance(_volToken) / IERC20(address(_volToken)).totalSupply();
        uint256 closeFees = burnUSDCAmountBeforeFees * (platform.feesCalculator().closePositionLPFeePercent() + 
            platform.feesCalculator().calculateClosePositionFeePercent(0, true)) / MAX_PERCENTAGE;

        expectedUSDCAmount = burnUSDCAmountBeforeFees - closeFees;

        uint256 fulfillFees = 0;
        if (!_isKeepers) {
            IVolatilityToken.Request memory request;
            (,,,,, request.requestTimestamp, request.targetTimestamp, request.useKeepers,) = _volToken.requests(_requestId);

            if (!request.useKeepers || block.timestamp < request.targetTimestamp) {
                fulfillFees = expectedUSDCAmount * _volToken.requestFeesCalculator().calculateTimePenaltyFee(request) / MAX_PERCENTAGE;
            }
        }

        uint256 timeWindowFees = expectedUSDCAmount * _volToken.requestFeesCalculator().calculateTimeDelayFee(_timeWindow) / MAX_PERCENTAGE;
        uint256 keepersFee = _isKeepers ? _volToken.requestFeesCalculator().calculateKeepersFee(expectedUSDCAmount) : 0;

        expectedUSDCAmount = expectedUSDCAmount - timeWindowFees - fulfillFees - keepersFee;
        netBurnAmount = _volTokensAmount * expectedUSDCAmount / burnUSDCAmountBeforeFees;
    }

    function stakedGOVI(address account) external view override returns (uint256 stakedAmount, uint256 share) {
        uint256 totalStaked = govi.balanceOf(address(staking));
        uint256 addedReward = staking.rewardPerSecond() * (block.timestamp - staking.lastUpdateTime());

        uint256 totalSupply = IERC20(address(staking)).totalSupply();

        if (totalSupply > 0) {
            uint256 balance = IERC20(address(staking)).balanceOf(account);
            stakedAmount = (totalStaked + addedReward) * balance / totalSupply;
            share = balance * MAX_PERCENTAGE / totalSupply;
        }
    }

    function calculateStakingAPR() external view override returns (uint256 apr) {
        uint256 totalStaked = govi.balanceOf(address(staking));
        uint256 periodReward = staking.rewardPerSecond() * 1 days * 365;
        apr = totalStaked == 0 ?  0 : periodReward * MAX_PERCENTAGE / totalStaked;
    }

    function calculateVolTokenPositionBalance(IVolatilityToken _volToken) private view returns (uint256 volTokenBalance) {
        IPlatform platform = _volToken.platform();

        bool isPositive = true;
        (uint256 currPositionUnits,,,,) = platform.positions(address(_volToken));
        if (currPositionUnits != 0) {
            (volTokenBalance, isPositive,,,,) = platform.calculatePositionBalance(address(_volToken));
        }
        require(isPositive, "Negative balance");
    }
}
