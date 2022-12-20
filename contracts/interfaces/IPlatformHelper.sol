// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./IPlatform.sol";
import "./IVolatilityToken.sol";
import "./IThetaVault.sol";

interface IPlatformHelper {

    function dailyFundingFee(IPlatform platform) external view returns (uint256 fundingFeePercent);
    function fundingFeeValues(IPlatform platform, uint16 minCVI, uint16 maxCVI, uint256 minCollateral, uint256 maxCollateral) external view returns (uint256[][] memory fundingFeeRatePercent);    	
    function collateralRatio(IPlatform platform) external view returns (uint256);

    function volTokenIntrinsicPrice(IVolatilityToken volToken) external view returns (uint256);
    function volTokenDexPrice(IThetaVault thetaVault) external view returns (uint256);

    function calculatePreMintAmounts(IVolatilityToken volToken, bool isKeepers, uint256 requestId, uint168 usdcAmount, uint256 timeWindow) external view returns (uint168 netMintAmount, uint256 expectedVolTokensAmount, uint256 buyingPremiumPercentage);
    function calculatePreBurnAmounts(IVolatilityToken volToken, bool isKeepers, uint256 requestId, uint256 volTokensAmount, uint256 timeWindow) external view returns (uint256 netBurnAmount, uint256 expectedUSDCAmount);

    function stakedGOVI(address account) external view returns (uint256 stakedAmount, uint256 share);
    function calculateStakingAPR() external view returns (uint256 apr);
}
