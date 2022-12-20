const { expectRevert, expectEvent, time, BN, balance } = require('@openzeppelin/test-helpers')

const chai = require('chai')

const ThetaVault = artifacts.require('ThetaVault')

const { MARGINS_TO_TEST } = require('./utils/TestUtils')
const { toBN, toUSD, toCVI } = require('./utils/BNUtils')
const { print } = require('./utils/DebugUtils')
const {
  deployFullPlatform,
  deployVolToken,
  setupVolTokenContracts,
  deployThetaVault,
  deployPlatformHelper,
  setupThetaVaultContracts,
  getContracts,
  getAccounts,
  ZERO_ADDRESS,
} = require('./utils/DeployUtils')
const {
  createState,
  depositAndValidate,
  calculateDepositAmounts,
  calculateWithdrawAmounts,
  calculatePositionBalance,
  calculateFundingFees,
  calculateFundingFeesWithSnapshot,
  calculateLiquidationDays,
  validateEmptyPosition,
  validatePosition,
  validateLPState,
  updateSnapshots,
  calculateOpenPositionAmounts,
  calculateMintAmount,
  calculateBurnAmount,
  calculateTokensByBurntLPTokensAmount,
  calculateBalance,
  MAX_FEE,
  GAS_PRICE,
  ONLY_COLLATERAL_PREMIUM,
  NO_FEES,
} = require('./utils/PlatformUtils.js')

const expect = chai.expect

const POOL_SKEW_PERCENTAGE = toBN(300)
const MAX_FEE_PERCENTAGE = toBN(10000)
const EXTRA_LIQUIDITY_PERCENTAGE = toBN(1500)
const MAX_REQUESTS_INCREASE = 30

const INITIAL_THETA_RATE = toBN(1, 12)

const SECONDS_PER_HOUR = 60 * 60
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24
const MIN_LIQUIDATION_TIME = SECONDS_PER_HOUR * 72

const DEPOSIT_REQUEST_TYPE = 1
const WITHDRAW_REQUEST_TYPE = 2

const DELAY_REQUEST_TIME = toBN(60 * 30)
const DEPOSIT_LOCK_TIME = toBN(60 * 60 * 24)

const SCALING_FACTOR_DECIMALS = toBN(1, 24)

let admin, bob, alice, carol, dave, eve, keeper
let accountsUsed

//TODO: Test rebalance with minted vol tokens not by vault
//TODO: Test everything with minted vol tokens not by vault?...

//TODO: Test vol token address < token address case and vice versa in one test (currently happens spontaniously on 3rd test)

//TODO: Test various (business) scenarios that mint tokens then adds them to dex not usnig the vault

//TODO: Test no rebase secnarios (no sync for a long time)

//TODO: Test withdrawing completely back to 0

//TODO: Test withdrawing reverts when colalteral gets broken

//TODO: Make sure gain is calculated properly

//TODO: Make sure balance of vault does *not* change over time!!! (fundin fees pass with arbitrage...)

//TODO: Test total amounts on events of fulfillDeposit and fulfillWithdraw

const setAccounts = async () => {
  ;[admin, bob, alice, carol, dave, eve, keeper] = await getAccounts()
  accountsUsed = [admin, bob, alice, carol, dave, eve, keeper]
}

const deployPlatform = async () => {
  await setAccounts()
  await deployFullPlatform(false)

  this.cviToken = getContracts().cviToken
  this.tokenAddress = getContracts().tokenAddress
  this.token = getContracts().token
  this.fakePriceProvider = getContracts().fakePriceProvider
  this.fakeOracle = getContracts().fakeOracle
  this.feesCalculator = getContracts().feesCalculator
  this.fakeFeesCollector = getContracts().fakeFeesCollector
  this.rewards = getContracts().rewards
  this.liquidation = getContracts().liquidation
  this.platform = getContracts().platform

  this.state = createState(accountsUsed)
}

const beforeEachToken = async (margin, isTest = false) => {
  await deployPlatform()
  setupVolTokenContracts()
  await deployVolToken(this.state, margin, isTest)

  this.requestFeesCalculator = getContracts().requestFeesCalculator
  this.keepersFeeVault = getContracts().keepersFeeVault
  this.volToken = getContracts().volToken
  this.requestFulfiller = getContracts().requestFulfiller
  this.platforms = getContracts().platforms

  await setupThetaVaultContracts()
  await deployThetaVault(this.state, margin, accountsUsed)
  await deployPlatformHelper(ZERO_ADDRESS, ZERO_ADDRESS)

  this.router = getContracts().router
  this.volTokenPair = getContracts().volTokenPair
  this.thetaVault = getContracts().thetaVault
  this.thetaRequestFulfiller = getContracts().thetaRequestFulfiller

  // Not initialized as is not part of accountsUsed
  this.state.lpBalances[this.thetaVault[margin.toString()].address] = toBN(0)

  const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(100000), admin, margin)
  await time.increase(DELAY_REQUEST_TIME)
  await fulfillAndValidate(requestId, admin, margin)

  const oldMinter = await await this.volToken[margin.toString()].minter()
  await this.volToken[margin.toString()].setMinter(admin, { from: admin })
  await this.token.approve(this.volToken[margin.toString()].address, toBN(100 * 100, 6))
  await this.volToken[margin.toString()].mintTokens(toBN(100 * 100, 6), { from: admin })
  const { latestTimestamp: timestamp, snapshot } = await updateSnapshots(this.state)
  await this.volToken[margin.toString()].setMinter(oldMinter, { from: admin })

  await this.volToken[margin.toString()].setRebaser(admin, { from: admin })
  await this.volToken[margin.toString()].setCappedRebase(false, { from: admin })
  await this.volToken[margin.toString()].rebaseCVI()

  //TODO: Import submitMintFulfillAndValidate and use it here...
  //TODO: Update vol token state + add vol token state check
  const { openPositionLeveragedTokens, positionUnits } = await calculateOpenPositionAmounts(
    this.state,
    timestamp,
    toBN(100 * 100, 6),
    NO_FEES,
    margin,
  )
  const { positionedTokenAmount, volTokens } = await calculateMintAmount(
    this.state,
    toBN(100 * 100, 6),
    toBN(0),
    toBN(margin),
    snapshot,
    undefined,
    false,
  )
  this.state.sharedPool = this.state.sharedPool.add(openPositionLeveragedTokens)
  this.state.totalMarginDebt = this.state.totalMarginDebt.add(openPositionLeveragedTokens.sub(toBN(100 * 100, 6)))
  this.state.totalPositionUnits = this.state.totalPositionUnits.add(positionUnits)

  this.state.positions[this.volToken[margin.toString()].address] = {
    positionUnitsAmount: positionUnits,
    creationTimestamp: timestamp,
    openCVIValue: toBN(10000),
    leverage: toBN(margin),
    originalCreationTimestamp: timestamp,
  }

  this.state[margin.toString()].volTokenSupply = await this.volToken[margin.toString()].totalSupply() // Gives total supply after rebase
  this.state[margin.toString()].volTokenPositionUnits = positionUnits

  const volTokenSupply = await this.volToken[margin.toString()].totalSupply()

  await this.token.approve(this.router.address, toBN(100 * 100, 6), { from: admin })
  await this.volToken[margin.toString()].approve(this.router.address, volTokenSupply, { from: admin })
  await this.router.addLiquidity(
    this.volToken[margin.toString()].address,
    this.token.address,
    volTokenSupply,
    volTokenSupply.mul(toBN(100, 6)).div(toBN(1, 18)),
    0,
    0,
    admin,
    (await time.latest()).add(toBN(1)),
    { from: admin },
  )

  // Initial add liquidity just sets the states to what is added
  this.state[margin.toString()].dexVolTokenAmount = volTokenSupply
  this.state[margin.toString()].dexUSDCAmount = volTokenSupply.mul(toBN(100, 6)).div(toBN(1, 18))

  console.log('a: ' + this.state[margin.toString()].dexUSDCAmount.toString())

  // Initial liquidity formula is complex and not-relevant, just get it from actual uniswap implementation
  this.state[margin.toString()].dexPairTotalSupply = await this.volTokenPair[margin.toString()].totalSupply()

  await validateState(margin)
}

const buyVolTokenInDex = (usdcAmount, margin) => {
  const amountInWithFee = usdcAmount.mul(toBN(997))
  const numerator = amountInWithFee.mul(this.state[margin.toString()].dexVolTokenAmount)
  const denominator = this.state[margin.toString()].dexUSDCAmount.mul(toBN(1000)).add(amountInWithFee)
  const amountOut = numerator.div(denominator)

  this.state[margin.toString()].dexVolTokenAmount = this.state[margin.toString()].dexVolTokenAmount.sub(amountOut)
  this.state[margin.toString()].dexUSDCAmount = this.state[margin.toString()].dexUSDCAmount.add(usdcAmount)

  console.log('after virtual swap:')
  console.log(this.state[margin.toString()].dexVolTokenAmount.toString())
  console.log(this.state[margin.toString()].dexUSDCAmount.toString())

  return amountOut
}

const sellVolTokenInDex = (volTokenAmount, margin) => {
  const amountInWithFee = volTokenAmount.mul(toBN(997))
  const numerator = amountInWithFee.mul(this.state[margin.toString()].dexUSDCAmount)
  const denominator = this.state[margin.toString()].dexVolTokenAmount.mul(toBN(1000)).add(amountInWithFee)
  const amountOut = numerator.div(denominator)

  console.log('after virtual swap:')
  this.state[margin.toString()].dexVolTokenAmount = this.state[margin.toString()].dexVolTokenAmount.add(volTokenAmount)
  this.state[margin.toString()].dexUSDCAmount = this.state[margin.toString()].dexUSDCAmount.sub(amountOut)

  return amountOut
}

const underlyingToValue = (amount, scalingFactor) => {
  return amount.mul(scalingFactor).div(SCALING_FACTOR_DECIMALS)
}

const valueToUnderlying = (amount, scalingFactor) => {
  return amount.mul(SCALING_FACTOR_DECIMALS).div(scalingFactor)
}

const addVolToken = (amount1, amount2, scalingFactor) => {
  return underlyingToValue(
    valueToUnderlying(amount1, scalingFactor).add(valueToUnderlying(amount2, scalingFactor)),
    scalingFactor,
  )
}

const subVolToken = (amount1, amount2, scalingFactor) => {
  return amount1.sub(amount2)
  //TODO: Understand why this doesn't work...
  //return underlyingToValue(valueToUnderlying(amount1, scalingFactor).sub(valueToUnderlying(amount2, scalingFactor)), scalingFactor);
}

//TODO: Add vol token state tests?... or export from VolToken test and use
//TODO: Check more things? afterThetaTokensBalances?
//TODO: IMPORTANT!!! Add totalLeveragedVaultAmount
const validateState = async margin => {
  expect(await this.volToken[margin.toString()].totalSupply()).to.be.bignumber.equal(
    this.state[margin.toString()].volTokenSupply,
  )
  expect(await this.thetaVault[margin.toString()].totalVaultLeveragedAmount()).to.be.bignumber.equal(
    this.state[margin.toString()].totalVaultLeveragedAmount,
  )

  expect(await this.thetaVault[margin.toString()].totalSupply()).to.be.bignumber.equal(
    this.state[margin.toString()].thetaTokenSupply,
  )
  expect(await this.thetaVault[margin.toString()].totalDepositRequestsAmount()).to.be.bignumber.equal(
    this.state[margin.toString()].totalDepositRequestsAmount,
  )
  expect(await this.thetaVault[margin.toString()].minRequestId()).to.be.bignumber.equal(
    this.state[margin.toString()].minRequestId,
  )
  expect(await this.thetaVault[margin.toString()].nextRequestId()).to.be.bignumber.equal(
    this.state[margin.toString()].nextRequestId,
  )
  expect(await this.volTokenPair[margin.toString()].totalSupply()).to.be.bignumber.equal(
    this.state[margin.toString()].dexPairTotalSupply,
  )

  //TODO: Add balance test?
  //TODO: Monitor dex pair tokens?...
  //expect(await this.volTokenPair[margin.toString()].balanceOf(this.volTokenPair[margin.toString()].address)).to.be.bignumber.equal(this.state[margin.toString()].dexPairTokens);

  const reserves = await this.volTokenPair[margin.toString()].getReserves()
  const token0 = await this.volTokenPair[margin.toString()].token0()

  if (token0 === this.volToken[margin.toString()].address) {
    expect(reserves._reserve0).to.be.bignumber.equal(this.state[margin.toString()].dexVolTokenAmount)
    expect(reserves._reserve1).to.be.bignumber.equal(this.state[margin.toString()].dexUSDCAmount)
  } else {
    expect(reserves._reserve0).to.be.bignumber.equal(this.state[margin.toString()].dexUSDCAmount)
    expect(reserves._reserve1).to.be.bignumber.equal(this.state[margin.toString()].dexVolTokenAmount)
  }

  if (
    this.state[margin.toString()].dexUSDCAmount.eq(toBN(0)) ||
    this.state[margin.toString()].dexVolTokenAmount.eq(toBN(0))
  ) {
    await expectRevert(
      getContracts().platformHelper.volTokenDexPrice(this.thetaVault[margin.toString()].address),
      'No liquidity',
    )
  } else {
    const volTokenDexPrice = await getContracts().platformHelper.volTokenDexPrice(
      this.thetaVault[margin.toString()].address,
    )
    const expectedVolTokenDexPrice = this.state[margin.toString()].dexUSDCAmount
      .mul(toBN(10).pow(toBN(18)))
      .div(this.state[margin.toString()].dexVolTokenAmount)

    expect(volTokenDexPrice).to.be.bignumber.equal(expectedVolTokenDexPrice)
  }

  for (let currId = 0; currId < this.state[margin.toString()].nextRequestId; currId++) {
    const stateRequest = this.state[margin.toString()].requests[currId]

    if (stateRequest === undefined) {
      const request = await this.thetaVault[margin.toString()].requests(currId)
      validateEmptyRequest(request)
    } else {
      const request = await this.thetaVault[margin.toString()].requests(currId)
      validateRequest(request, stateRequest)
    }
  }
}

const validateRequest = (actual, expected) => {
  expect(actual.requestType).to.be.bignumber.equal(expected.requestType)
  expect(actual.tokenAmount).to.be.bignumber.equal(expected.tokenAmount)
  expect(actual.owner).to.be.bignumber.equal(expected.owner)
  expect(actual.targetTimestamp).to.be.bignumber.equal(expected.targetTimestamp)
}

const validateEmptyRequest = actual => {
  expect(actual.requestType).to.be.bignumber.equal(toBN(0))
  expect(actual.tokenAmount).to.be.bignumber.equal(toBN(0))
  expect(actual.owner).to.be.bignumber.equal(ZERO_ADDRESS)
  expect(actual.targetTimestamp).to.be.bignumber.equal(toBN(0))
}

const submitAndValidate = async (requestType, tokensAmount, owner, margin, delayTime = DELAY_REQUEST_TIME) => {
  if (requestType === WITHDRAW_REQUEST_TYPE) {
    const allowance = await this.thetaVault[margin.toString()].allowance(
      owner,
      this.thetaVault[margin.toString()].address,
    )
    await this.thetaVault[margin.toString()].approve(
      this.thetaVault[margin.toString()].address,
      allowance.add(tokensAmount),
      { from: owner },
    )
  } else {
    await this.token.transfer(owner, tokensAmount, { from: admin })
    const allowance = await this.token.allowance(owner, this.thetaVault[margin.toString()].address)
    await this.token.approve(this.thetaVault[margin.toString()].address, allowance.add(tokensAmount), { from: owner })
  }

  const beforeSubmitTokenBalance = await this.token.balanceOf(owner)
  const beforeSubmitThetaTokenBalance = await this.thetaVault[margin.toString()].balanceOf(owner)
  const beforeContractTokenBalance = await this.token.balanceOf(this.thetaVault[margin.toString()].address)
  const beforeContractThetaTokenBalance = await this.thetaVault[margin.toString()].balanceOf(
    this.thetaVault[margin.toString()].address,
  )

  let tx
  if (requestType === DEPOSIT_REQUEST_TYPE) {
    tx = await this.thetaVault[margin.toString()].submitDepositRequest(tokensAmount, { from: owner })
  } else if (requestType === WITHDRAW_REQUEST_TYPE) {
    tx = await this.thetaVault[margin.toString()].submitWithdrawRequest(tokensAmount, { from: owner })
  } else {
    assert.fail('request type does not exist')
  }

  const now = await time.latest()
  const targetTimestamp = now.add(toBN(delayTime))

  const afterSubmitTokenBalance = await this.token.balanceOf(owner)
  const afterSubmitThetaTokenBalance = await this.thetaVault[margin.toString()].balanceOf(owner)
  const afterContractTokenBalance = await this.token.balanceOf(this.thetaVault[margin.toString()].address)
  const afterContractThetaTokenBalance = await this.thetaVault[margin.toString()].balanceOf(
    this.thetaVault[margin.toString()].address,
  )

  if (requestType === WITHDRAW_REQUEST_TYPE) {
    expect(beforeSubmitThetaTokenBalance.sub(afterSubmitThetaTokenBalance)).to.be.bignumber.equal(tokensAmount)
    expect(afterContractThetaTokenBalance.sub(beforeContractThetaTokenBalance)).to.be.bignumber.equal(tokensAmount)
    expect(beforeSubmitTokenBalance.sub(afterSubmitTokenBalance)).to.be.bignumber.equal(toBN(0))
    expect(afterContractTokenBalance.sub(beforeContractTokenBalance)).to.be.bignumber.equal(toBN(0))
  } else {
    expect(beforeSubmitTokenBalance.sub(afterSubmitTokenBalance)).to.be.bignumber.equal(tokensAmount)
    expect(afterContractTokenBalance.sub(beforeContractTokenBalance)).to.be.bignumber.equal(tokensAmount)
    expect(beforeSubmitThetaTokenBalance.sub(afterSubmitThetaTokenBalance)).to.be.bignumber.equal(toBN(0))
    expect(afterContractThetaTokenBalance.sub(beforeContractThetaTokenBalance)).to.be.bignumber.equal(toBN(0))

    this.state[margin.toString()].totalDepositRequestsAmount =
      this.state[margin.toString()].totalDepositRequestsAmount.add(tokensAmount)
  }

  await expectEvent(tx, 'SubmitRequest', {
    requestId: this.state[margin.toString()].nextRequestId,
    requestType: toBN(requestType),
    tokenAmount: tokensAmount,
    account: owner,
    targetTimestamp,
  })

  const requestId = this.state[margin.toString()].nextRequestId
  const request = await this.thetaVault[margin.toString()].requests(requestId)

  const newExpectedRequest = {
    requestType: new BN(requestType),
    tokenAmount: tokensAmount,
    owner,
    targetTimestamp,
  }

  validateRequest(request, newExpectedRequest)
  this.state[margin.toString()].requests[requestId] = newExpectedRequest
  this.state[margin.toString()].nextRequestId = this.state[margin.toString()].nextRequestId.add(toBN(1))

  await validateState(margin)

  return requestId
}

const calculateVaultDepositAmount = (amount, margin, snapshot, cviValue) => {
  //TODO: Function to get gain, use in vol token and export
  const position = this.state.positions[this.volToken[margin.toString()].address]

  let gain = new BN(0)
  let positionBalance = new BN(0)

  if (position !== undefined) {
    const fundingFees = calculateFundingFeesWithSnapshot(
      this.state,
      snapshot,
      this.volToken[margin.toString()].address,
      position.positionUnitsAmount,
    )
    positionBalance = position.positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees)
    const originalPositionBalance = position.positionUnitsAmount
      .mul(position.openCVIValue)
      .div(getContracts().maxCVIValue)

    if (positionBalance.gt(originalPositionBalance)) {
      gain = positionBalance.sub(originalPositionBalance)
    }
  }

  //TODO: Const for 10,18
  const dexPrice = this.state[margin.toString()].dexUSDCAmount
    .mul(toBN(1, 18))
    .div(this.state[margin.toString()].dexVolTokenAmount)
  const intrinsicPrice = positionBalance.mul(toBN(1, 18)).div(this.state[margin.toString()].volTokenSupply)

  const volTokenUSDCAmount = new BN(-1)
    .mul(
      intrinsicPrice.mul(
        margin
          .mul(gain)
          .mul(cviValue.sub(getContracts().maxCVIValue))
          .mul(MAX_FEE_PERCENTAGE.add(EXTRA_LIQUIDITY_PERCENTAGE))
          .add(cviValue.mul(MAX_FEE_PERCENTAGE).mul(amount)),
      ),
    )
    .div(
      intrinsicPrice
        .mul(margin)
        .mul(EXTRA_LIQUIDITY_PERCENTAGE)
        .mul(cviValue.sub(getContracts().maxCVIValue))
        .add(
          MAX_FEE_PERCENTAGE.mul(
            cviValue
              .mul(intrinsicPrice)
              .mul(margin.sub(toBN(1)))
              .sub(cviValue.mul(dexPrice))
              .sub(intrinsicPrice.mul(margin).mul(getContracts().maxCVIValue)),
          ),
        ),
    )

  return volTokenUSDCAmount
}

const calculateVaultBalance = async (margin, snapshot, cviValue) => {
  //TODO: Use calculateBalance from PositionUtils?
  const totalPlatformBalance = this.state.sharedPool
    .sub(this.state.totalPositionUnits.mul(cviValue).div(getContracts().maxCVIValue))
    .add(this.state.totalFundingFees)
  const platformLiquidityBalance = totalPlatformBalance
    .mul(this.state.lpBalances[this.thetaVault[margin.toString()].address])
    .div(this.state.lpTokensSupply)

  if (this.state[margin.toString()].dexVolTokenAmount.eq(toBN(0))) {
    return platformLiquidityBalance
  }

  const position = this.state.positions[this.volToken[margin.toString()].address]
  const fundingFees = calculateFundingFeesWithSnapshot(
    this.state,
    snapshot,
    this.volToken[margin.toString()].address,
    position.positionUnitsAmount,
  )
  const positionBalance = position.positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees)

  const dexVolTokenBalance = this.state[margin.toString()].dexVolTokenAmount
    .mul(positionBalance)
    .div(this.state[margin.toString()].volTokenSupply)

  const dexVolTokenTotalSupply = this.state[margin.toString()].dexPairTotalSupply
  const dexTokens = await this.volTokenPair[margin.toString()].balanceOf(this.volTokenPair[margin.toString()].address)

  console.log(
    'test balance: p: ' +
      platformLiquidityBalance.toString() +
      ' intrin: ' +
      dexVolTokenBalance.mul(dexTokens).div(dexVolTokenTotalSupply).toString() +
      ' dex usd : ' +
      this.state[margin.toString()].dexUSDCAmount.mul(dexTokens).div(dexVolTokenTotalSupply).toString(),
  )

  return this.state[margin.toString()].dexUSDCAmount
    .mul(dexTokens)
    .div(dexVolTokenTotalSupply)
    .add(dexVolTokenBalance.mul(dexTokens).div(dexVolTokenTotalSupply))
    .add(platformLiquidityBalance)
}

const addLiquidity = (volTokenAmount, margin, scalingFactor) => {
  const dexUSDCToAdd = volTokenAmount
    .mul(this.state[margin.toString()].dexUSDCAmount)
    .div(this.state[margin.toString()].dexVolTokenAmount)
  //TODO: Min between dex/total dex and vol/total vol?
  const dexLPTokensAmount = dexUSDCToAdd
    .mul(this.state[margin.toString()].dexPairTotalSupply)
    .div(this.state[margin.toString()].dexUSDCAmount)
  //TODO: Function + do this in other places...
  this.state[margin.toString()].dexVolTokenAmount = addVolToken(
    this.state[margin.toString()].dexVolTokenAmount,
    volTokenAmount,
    scalingFactor,
  )
  this.state[margin.toString()].dexUSDCAmount = this.state[margin.toString()].dexUSDCAmount.add(dexUSDCToAdd)
  this.state[margin.toString()].dexPairTotalSupply =
    this.state[margin.toString()].dexPairTotalSupply.add(dexLPTokensAmount)
  this.state[margin.toString()].dexPairVaultBalance =
    this.state[margin.toString()].dexPairVaultBalance.add(dexLPTokensAmount)

  return { dexUSDCAmount: dexUSDCToAdd, dexLPTokensAmount }
}

const depositToVault = async (
  tx,
  tokensAmount,
  margin,
  timestamp,
  lastLatestSnapshotTimestamp,
  snapshot,
  cviValue,
  scalingFactor,
  expectedPosition,
) => {
  // Calculate platform liquidity, usdc dex, vol token usdc buy then dex
  const volTokenUSDCAmount = calculateVaultDepositAmount(tokensAmount, toBN(margin), snapshot, cviValue)

  // Mint + update position of vol token on platform
  const { openPositionLeveragedTokens, positionUnits } = await calculateOpenPositionAmounts(
    this.state,
    timestamp,
    volTokenUSDCAmount,
    NO_FEES,
    margin,
  )
  const { positionedTokenAmount, volTokens } = await calculateMintAmount(
    this.state,
    volTokenUSDCAmount,
    toBN(0),
    toBN(margin),
    snapshot,
    lastLatestSnapshotTimestamp,
    false,
  )

  // Add to dex simulation + results (update dex LP tokens amount)
  const { dexUSDCAmount } = addLiquidity(volTokens, toBN(margin), scalingFactor)

  const platformLiquidityAmount = tokensAmount.sub(volTokenUSDCAmount).sub(dexUSDCAmount)
  const lpTokens = (await calculateDepositAmounts(this.state, platformLiquidityAmount, undefined, false)).lpTokens

  //TODO: Make internal
  //await expectEvent(tx, 'Mint', {account, tokenAmount: positionedTokenAmount, mintedTokens: volTokens});

  // TODO: Same as vol token test, make function...
  let finalPositionUnits = positionUnits
  let positionUnitsAdded = finalPositionUnits
  const isMerge = expectedPosition !== undefined
  if (isMerge) {
    const oldPositionUnits = this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount
    const fundingFees = calculateFundingFees(
      this.state,
      timestamp,
      this.volToken[margin.toString()].address,
      this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount,
    )
    const marginDebt = this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount
      .mul(this.state.positions[this.volToken[margin.toString()].address].openCVIValue)
      .mul(this.state.positions[this.volToken[margin.toString()].address].leverage.sub(new BN(1)))
      .div(getContracts().maxCVIValue)
      .div(this.state.positions[this.volToken[margin.toString()].address].leverage)
    const positionBalance = this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount
      .mul(cviValue)
      .div(getContracts().maxCVIValue)
      .sub(fundingFees)
      .sub(marginDebt)
    finalPositionUnits = positionBalance
      .add(volTokenUSDCAmount)
      .mul(new BN(margin))
      .mul(getContracts().maxCVIValue)
      .div(cviValue)

    positionUnitsAdded = new BN(0)
    if (oldPositionUnits.lt(finalPositionUnits)) {
      positionUnitsAdded = finalPositionUnits.sub(oldPositionUnits)
    }

    this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees)
    this.state.totalPositionUnits = this.state.totalPositionUnits.sub(
      this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount,
    )
    this.state.sharedPool = this.state.sharedPool
      .sub(positionBalance)
      .sub(marginDebt)
      .add(positionBalance.add(volTokenUSDCAmount).mul(new BN(margin)))
    this.state.totalMarginDebt = this.state.totalMarginDebt
      .sub(marginDebt)
      .add(positionBalance.add(volTokenUSDCAmount).mul(new BN(margin).sub(new BN(1))))

    if (this.state.totalPositionUnits.eq(toBN(0))) {
      this.state.totalFundingFees = toBN(0)
    }
  } else {
    this.state.sharedPool = this.state.sharedPool.add(openPositionLeveragedTokens)
    this.state.totalMarginDebt = this.state.totalMarginDebt.add(openPositionLeveragedTokens.sub(volTokenUSDCAmount))
  }

  this.state[margin.toString()].volTokenSupply = this.state[margin.toString()].volTokenSupply.add(volTokens)

  //TODO: Make it work
  /*await expectEvent.inTransaction(tx.tx, getContracts().platform, 'OpenPosition', {account: this.volToken[margin.toString()].address, tokenAmount: volTokenUSDCAmount,
        feeAmount: toBN(0), positionUnitsAmount: finalPositionUnits, leverage: toBN(margin), cviValue});*/

  if (!isMerge) {
    expectedPosition = {
      positionUnitsAmount: finalPositionUnits,
      creationTimestamp: timestamp,
      openCVIValue: cviValue,
      leverage: new BN(margin),
      originalCreationTimestamp: timestamp,
    }
    this.state.positions[this.volToken[margin.toString()].address] = expectedPosition
  } else {
    expectedPosition.positionUnitsAmount = finalPositionUnits
    expectedPosition.creationTimestamp = timestamp
    expectedPosition.openCVIValue = cviValue
  }

  this.state.positions[this.volToken[margin.toString()].address] = expectedPosition
  this.state.totalPositionUnits = finalPositionUnits
  this.state[margin.toString()].volTokenPositionUnits = finalPositionUnits

  this.state[margin.toString()].totalVaultLeveragedAmount = this.state[margin.toString()].totalVaultLeveragedAmount
    .add(volTokenUSDCAmount.mul(toBN(margin)))
    .add(platformLiquidityAmount)

  this.state.lpTokensSupply = this.state.lpTokensSupply.add(lpTokens)
  this.state.sharedPool = this.state.sharedPool.add(platformLiquidityAmount) // Note: no deposit fees ever!
  this.state.lpBalances[this.thetaVault[margin.toString()].address] =
    this.state.lpBalances[this.thetaVault[margin.toString()].address].add(lpTokens)

  return { lpTokens, platformLiquidityAmount }
}

//TODO: Test arbitrage on sumbit reuqests!

const arbitrageAndValidate = async (shouldArbitrage, snapshot, timestamp, cviValue, margin, availableUSDC) => {
  //TODO: Get position balance function
  let positionBalance = new BN(0)
  const position = this.state.positions[this.volToken[margin.toString()].address]

  if (position !== undefined) {
    const fundingFees = calculateFundingFeesWithSnapshot(
      this.state,
      snapshot,
      this.volToken[margin.toString()].address,
      position.positionUnitsAmount,
    )
    positionBalance = position.positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees)
  }

  const dexUSDC = this.state[margin.toString()].dexUSDCAmount

  console.log(this.state[margin.toString()].dexVolTokenAmount.toString())
  console.log(dexUSDC.toString())
  if (dexUSDC.gt(toBN(0)) && this.state[margin.toString()].dexVolTokenAmount.gt(toBN(0))) {
    const dexVolTokenUSDCByIntrinsic = positionBalance
      .mul(this.state[margin.toString()].dexVolTokenAmount)
      .div(this.state[margin.toString()].volTokenSupply)

    const diff = dexUSDC.sub(dexVolTokenUSDCByIntrinsic).abs()

    console.log('dexUSDC: ' + dexUSDC.toString())
    console.log('intrinsic: ' + dexVolTokenUSDCByIntrinsic.toString())
    console.log('diff: ' + diff.toString())

    if (diff.gt(dexVolTokenUSDCByIntrinsic.mul(POOL_SKEW_PERCENTAGE).div(MAX_FEE_PERCENTAGE))) {
      expect(shouldArbitrage).to.be.true

      console.log('arbitraging!')
      let usdcArbitrageAmount = diff.div(toBN(2))
      if (usdcArbitrageAmount.gt(availableUSDC)) {
        // Get rest from platform liquidity
        const neededPlatformUSDC = usdcArbitrageAmount.sub(availableUSDC)

        //TODO: Use calculateBalance
        const totalPlatformBalance = this.state.sharedPool
          .sub(this.state.totalPositionUnits.mul(cviValue).div(getContracts().maxCVIValue))
          .add(this.state.totalFundingFees)

        // NeededUSDC / totalBalance = neededLP / totalSupply => neededLP = neededUSDC * totalSupply / totalBalance
        const lpToWithdraw = neededPlatformUSDC
          .mul(this.state[margin.toString()].volTokenSupply)
          .div(totalPlatformBalance)
        const withdrawPlatformTokens = await calculateTokensByBurntLPTokensAmount(this.state, lpToWithdraw)
        usdcArbitrageAmount = usdcArbitrageAmount.add(withdrawPlatformTokens)

        this.state.lpBalances[this.thetaVault[margin.toString()].address] =
          this.state.lpBalances[this.thetaVault[margin.toString()].address].sub(lpToWithdraw)
        this.state.lpTokensSupply = this.state.lpTokensSupply.sub(lpToWithdraw)
        this.state.sharedPool = this.state.sharedPool.sub(withdrawPlatformTokens)
      }

      if (dexUSDC.gt(dexVolTokenUSDCByIntrinsic)) {
        // Mint vol tokens
        //TODO: Use lastLatest?... Why?...
        const { positionedTokenAmount, volTokens } = await calculateMintAmount(
          this.state,
          usdcArbitrageAmount,
          toBN(0),
          toBN(margin),
          snapshot,
          timestamp,
          false,
        )

        // Sell vol tokness
        const usdcReceived = sellVolTokenInDex(volTokens, margin)

        const arbitrageGain = usdcReceived.sub(usdcArbitrageAmount)

        //TODO: Make outside of it
        //---
        console.log('gain is : ' + arbitrageGain.toString())

        const lpTokens = (await calculateDepositAmounts(this.state, arbitrageGain, undefined, false)).lpTokens

        this.state.lpBalances[this.thetaVault[margin.toString()].address] =
          this.state.lpBalances[this.thetaVault[margin.toString()].address].add(lpTokens)
        this.state.lpTokensSupply = this.state.lpTokensSupply.add(lpTokens)
        this.state.sharedPool = this.state.sharedPool.add(arbitrageGain)
        //---
      } else {
        console.log('arbitrage amount : ' + usdcArbitrageAmount.toString())
        // Swap in pool
        const volTokensBought = buyVolTokenInDex(usdcArbitrageAmount, margin)
        console.log('tokens bought: ' + volTokensBought.toString())

        // Burn vol tokens
        const { tokensReceived, positionUnitsClosed, closeFees, fundingFees, positionBalance, marginDebt } =
          await calculateBurnAmount(this.state, volTokensBought, timestamp, margin, undefined, false)
        console.log('tokens after burn: ' + tokensReceived.toString())

        //TODO: Make it work
        /*await expectEvent.inTransaction(tx.tx, getContracts().platform, 'ClosePosition', {account: this.volToken[margin.toString()].address, tokenAmount: positionBalance.sub(marginDebt), feeAmount: fundingFees,
                    positionUnitsAmount: this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount.sub(positionUnitsClosed), leverage: new BN(margin), cviValue});*/

        // Deposit arbitrage gain
        const arbitrageGain = tokensReceived.sub(usdcArbitrageAmount)

        console.log('gain is : ' + arbitrageGain.toString())

        const lpTokens = (await calculateDepositAmounts(this.state, arbitrageGain, undefined, false)).lpTokens

        this.state.lpBalances[this.thetaVault[margin.toString()].address] =
          this.state.lpBalances[this.thetaVault[margin.toString()].address].add(lpTokens)
        this.state.lpTokensSupply = this.state.lpTokensSupply.add(lpTokens)
        this.state.sharedPool = this.state.sharedPool.add(arbitrageGain)
      }
    } else {
      expect(shouldArbitrage).to.be.false
    }
  } else {
    expect(shouldArbitrage).to.be.false
  }
}

const fulfillAndValidate = async (
  requestId,
  account,
  margin,
  keepersCalled = false,
  multipleKeeperAccount = keeper,
  shouldArbitrage = false,
) => {
  const isMultiple = Array.isArray(requestId)
  let expectedPosition = this.state.positions[this.volToken[margin.toString()].address]

  //TODO: Save in state?... rebaseAndValidate?... in vol token...
  const scalingFactor = await this.volToken[margin.toString()].scalingFactor()

  let requestIds, accounts
  if (isMultiple) {
    requestIds = requestId
    accounts = account
  } else {
    requestIds = [requestId]
    accounts = [account]
  }

  let afterContractTokensBalance = this.token.balanceOf(this.thetaVault[margin.toString()].address)
  let afterContractThetaTokensBalance = this.thetaVault[margin.toString()].balanceOf(
    this.thetaVault[margin.toString()].address,
  )
  let afterContractDEXLPTokensBalance = this.volTokenPair[margin.toString()].balanceOf(
    this.thetaVault[margin.toString()].address,
  )

  const afterBalances = {}
  const afterThetaTokensBalances = {}

  let i
  for (i = 0; i < requestIds.length; i++) {
    const account = accounts[i]
    const requestId = requestIds[i]

    //TODO: Take from state, for vol token as well!
    afterBalances[account] = await this.token.balanceOf(account)
    afterThetaTokensBalances[account] = this.state[margin.toString()].thetaTokenBalances[account]
  }

  let tx, mintedThetaTokensCall, tokensReceivedCall

  if (isMultiple) {
    tx = await this.requestFulfiller[margin.toString()].performUpkeep(0, { from: multipleKeeperAccount })
    print('FULFILL: ' + tx.receipt.gasUsed.toString())
  } else {
    const isDeposit = this.state[margin.toString()].requests[requestIds[0]].requestType == DEPOSIT_REQUEST_TYPE

    let timestampCall
    let snapshotCall
    let totalFundingFeesCall

    if (isDeposit) {
      mintedThetaTokensCall = await this.thetaVault[margin.toString()].fulfillDepositRequest.call(requestIds[0], {
        from: keepersCalled ? keeper : accounts[0],
      })

      const result = await updateSnapshots(this.state, false)
      timestampCall = result.latestTimestamp
      snapshotCall = result.snapshot
      totalFundingFeesCall = result.totalFundingFeesCall

      tx = await this.thetaVault[margin.toString()].fulfillDepositRequest(requestIds[0], {
        from: keepersCalled ? keeper : accounts[0],
      })
      print('DEPOSIT: ' + tx.receipt.gasUsed.toString())
    } else {
      tokensReceivedCall = await this.thetaVault[margin.toString()].fulfillWithdrawRequest.call(requestIds[0], {
        from: keepersCalled ? keeper : accounts[0],
      })

      const result = await updateSnapshots(this.state, false)
      timestampCall = result.latestTimestamp
      snapshotCall = result.snapshot

      tx = await this.thetaVault[margin.toString()].fulfillWithdrawRequest(requestIds[0], {
        from: keepersCalled ? keeper : accounts[0],
      })
      print('WITHDRAW: ' + tx.receipt.gasUsed.toString())
    }
  }

  const lastLatestSnapshotTimestamp = this.state.latestSnapshotTimestamp
  const {
    latestTimestamp: timestamp,
    snapshot,
    latestCVIRound,
    totalFundingFees,
    turbulence,
  } = await updateSnapshots(this.state)
  this.state.totalFundingFees = totalFundingFees

  const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue

  i = 0
  for (i = 0; i < requestIds.length; i++) {
    const account = accounts[i]
    const requestId = requestIds[i]
    const request = this.state[margin.toString()].requests[requestId]

    const isDeposit = request.requestType.toNumber() === DEPOSIT_REQUEST_TYPE
    const tokensAmount = request.tokenAmount

    if (isDeposit) {
      let totalBalance = undefined
      const isDEXEmpty = this.state[margin.toString()].dexVolTokenAmount.eq(toBN(0))

      await arbitrageAndValidate(shouldArbitrage, snapshot, timestamp, cviValue, margin, tokensAmount)

      if (!this.state[margin.toString()].thetaTokenSupply.eq(toBN(0))) {
        totalBalance = await calculateVaultBalance(margin, snapshot, cviValue)
      }

      let platformLiquidityAmount = tokensAmount
      let lpTokens
      if (!isDEXEmpty) {
        const result = await depositToVault(
          tx,
          tokensAmount,
          margin,
          timestamp,
          lastLatestSnapshotTimestamp,
          snapshot,
          cviValue,
          scalingFactor,
          expectedPosition,
        )
        lpTokens = result.lpTokens
        platformLiquidityAmount = result.platformLiquidityAmount
        this.state[margin.toString()].totalDepositRequestsAmount =
          this.state[margin.toString()].totalDepositRequestsAmount.sub(tokensAmount)
      } else {
        lpTokens = (await calculateDepositAmounts(this.state, platformLiquidityAmount, undefined, false)).lpTokens
        this.state[margin.toString()].totalVaultLeveragedAmount =
          this.state[margin.toString()].totalVaultLeveragedAmount.add(platformLiquidityAmount)

        //TODO: Function shared with depositToVault
        this.state.lpTokensSupply = this.state.lpTokensSupply.add(lpTokens)
        this.state.sharedPool = this.state.sharedPool.add(platformLiquidityAmount) // Note: no deposit fees ever!
        this.state.lpBalances[this.thetaVault[margin.toString()].address] =
          this.state.lpBalances[this.thetaVault[margin.toString()].address].add(lpTokens)
        this.state[margin.toString()].totalDepositRequestsAmount =
          this.state[margin.toString()].totalDepositRequestsAmount.sub(tokensAmount)
      }

      //TODO: Verify internal event
      //await expectEvent(tx, 'Deposit', {account, tokenAmount: depositTokens, lpTokensAmount: lpTokens, feeAmount: depositTokenFees});

      // Finally, calculate minted tokens and verify they were received
      //TODO: Function
      const totalSupply = this.state[margin.toString()].thetaTokenSupply

      let thetaTokens
      if (totalSupply.eq(toBN(0)) || totalBalance.eq(toBN(0))) {
        thetaTokens = tokensAmount.mul(INITIAL_THETA_RATE)
      } else {
        console.log('test balance: ' + totalBalance.toString())
        console.log('test supply: ' + totalSupply.toString())
        thetaTokens = tokensAmount.mul(totalSupply).div(totalBalance)
      }

      console.log('test theta tokens: ' + thetaTokens.toString())

      afterThetaTokensBalances[account] = afterThetaTokensBalances[account].add(thetaTokens)
      this.state[margin.toString()].thetaTokenSupply = this.state[margin.toString()].thetaTokenSupply.add(thetaTokens)

      if (!isMultiple) {
        //TODO: Test return value theta tokens
      }

      // Events
    } else {
      //TODO: Remove liquidity function?...
      const vaultAddress = this.thetaVault[margin.toString()].address
      const platformLPTokensToBurn = tokensAmount
        .mul(this.state.lpBalances[this.thetaVault[margin.toString()].address])
        .div(this.state[margin.toString()].thetaTokenSupply)
      const dexLPTokensToBurn = tokensAmount
        .mul(this.state[margin.toString()].dexPairVaultBalance)
        .div(this.state[margin.toString()].thetaTokenSupply)
      const usdcFromDex = dexLPTokensToBurn
        .mul(this.state[margin.toString()].dexUSDCAmount)
        .div(this.state[margin.toString()].dexPairTotalSupply)
      const volTokenFromDex = dexLPTokensToBurn
        .mul(this.state[margin.toString()].dexVolTokenAmount)
        .div(this.state[margin.toString()].dexPairTotalSupply)

      // Burn vol tokens...
      //TODO: Burn function... to be exported from voltoken test, same for mint
      const { tokensReceived, positionUnitsClosed, closeFees, fundingFees, positionBalance, marginDebt } =
        await calculateBurnAmount(this.state, volTokenFromDex, timestamp, margin, undefined, false)
      await expectEvent.inTransaction(tx.tx, getContracts().platform, 'ClosePosition', {
        account: this.volToken[margin.toString()].address,
        tokenAmount: positionBalance.sub(marginDebt),
        feeAmount: fundingFees,
        positionUnitsAmount:
          this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount.sub(positionUnitsClosed),
        leverage: new BN(margin),
        cviValue,
      })

      //TODO: Burn event (of vol token, also add Mint event)
      /*if (isMultiple) {
                //TODO: Fix somehow for multiples
                //await expectEvent.inTransaction(tx.tx, this.volToken[margin.toString()], 'FulfillRequest', expectedFulfillRequestEvent);
                await expectEvent.inTransaction(tx.tx, this.volToken[margin.toString()], 'Burn', expectedBurnEvent);
            } else {
                await expectEvent(tx, 'FulfillRequest', expectedFulfillRequestEvent);
                await expectEvent(tx, 'Burn', expectedBurnEvent);
            }*/

      expectedPosition.positionUnitsAmount = expectedPosition.positionUnitsAmount.sub(positionUnitsClosed)

      this.state.totalPositionUnits = this.state.totalPositionUnits.sub(positionUnitsClosed)
      if (this.state.totalFundingFees.sub(fundingFees).lt(new BN(0))) {
        this.state.totalFundingFees = new BN(0)
      } else {
        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees)
      }

      if (this.state.totalPositionUnits.eq(new BN(0))) {
        this.state.totalFundingFees = new BN(0)
      }

      this.state.sharedPool = this.state.sharedPool.sub(positionBalance).add(fundingFees)
      this.state.totalMarginDebt = this.state.totalMarginDebt.sub(marginDebt)

      //TODO: Function
      this.state[margin.toString()].volTokenSupply = this.state[margin.toString()].volTokenSupply.sub(
        volTokenFromDex.mul(SCALING_FACTOR_DECIMALS).div(scalingFactor).mul(scalingFactor).div(SCALING_FACTOR_DECIMALS),
      )
      this.state[margin.toString()].volTokenPositionUnits =
        this.state[margin.toString()].volTokenPositionUnits.sub(positionUnitsClosed)

      // Remove from liquidity...
      //TODO: Function
      const withdrawPlatformTokens = await calculateTokensByBurntLPTokensAmount(this.state, platformLPTokensToBurn)

      this.state.lpTokensSupply = this.state.lpTokensSupply.sub(platformLPTokensToBurn)
      this.state.sharedPool = this.state.sharedPool.sub(withdrawPlatformTokens)

      this.state[margin.toString()].dexPairTotalSupply =
        this.state[margin.toString()].dexPairTotalSupply.sub(dexLPTokensToBurn)
      this.state[margin.toString()].dexPairVaultBalance =
        this.state[margin.toString()].dexPairVaultBalance.sub(volTokenFromDex)
      this.state[margin.toString()].dexUSDCAmount = this.state[margin.toString()].dexUSDCAmount.sub(usdcFromDex)

      //TODO: Make underlying and back function and use it everywhere...
      this.state[margin.toString()].dexVolTokenAmount = subVolToken(
        this.state[margin.toString()].dexVolTokenAmount,
        volTokenFromDex,
        scalingFactor,
      )
      this.state.lpBalances[this.thetaVault[margin.toString()].address] =
        this.state.lpBalances[this.thetaVault[margin.toString()].address].sub(platformLPTokensToBurn)

      // Sum it all up + burn theta tokens
      const totalWithdrawTokens = withdrawPlatformTokens.add(usdcFromDex).add(tokensReceived)

      this.state[margin.toString()].totalVaultLeveragedAmount = this.state[margin.toString()].totalVaultLeveragedAmount
        .sub(marginDebt)
        .sub(tokensReceived)
        .sub(withdrawPlatformTokens)

      afterThetaTokensBalances[account] = afterThetaTokensBalances[account].sub(tokensAmount)
      this.state[margin.toString()].thetaTokenSupply = this.state[margin.toString()].thetaTokenSupply.sub(tokensAmount)

      afterBalances[account] = afterBalances[account].add(totalWithdrawTokens)

      if (!isMultiple) {
        //TODO: Test return value tokens
      }

      // Events
    }

    removeRequest(requestId, margin)
  }

  i = 0
  for (i = 0; i < requestIds.length; i++) {
    const account = accounts[i]
    const requestId = requestIds[i]

    const currAccountBalance = await this.token.balanceOf(account)
    const currAcountThetaTokensBalance = await this.thetaVault[margin.toString()].balanceOf(account)

    expect(currAccountBalance).to.be.bignumber.equal(afterBalances[account])
    expect(currAcountThetaTokensBalance).to.be.bignumber.equal(afterThetaTokensBalances[account])

    this.state[margin.toString()].thetaTokenBalances[account] = afterThetaTokensBalances[account]

    i++
  }

  const actualPosition = await getContracts().platform.positions(this.volToken[margin.toString()].address)

  if (expectedPosition !== undefined) {
    if (expectedPosition.positionUnitsAmount.toNumber() === 0) {
      validateEmptyPosition(actualPosition)
      delete this.state.positions[this.volToken[margin.toString()].address]
    }

    validatePosition(actualPosition, expectedPosition)
  }

  await validateLPState(this.state)
  await validateState(margin)
}

const submitDepositFulfillAndValidate = async (account, amount, margin) => {
  const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, amount, account, margin)
  await time.increase(DELAY_REQUEST_TIME)
  await fulfillAndValidate(requestId, account, margin)

  return requestId
}

const submitWithdrawFulfillAndValidate = async (account, amount, margin) => {
  const requestId = await submitAndValidate(WITHDRAW_REQUEST_TYPE, amount, account, margin)
  await time.increase(DELAY_REQUEST_TIME)
  await fulfillAndValidate(requestId, account, margin)

  return requestId
}

const removeRequest = (requestId, margin) => {
  this.state[margin.toString()].requests[requestId] = undefined
  let currRequestId = this.state[margin.toString()].minRequestId
  const nextRequestId = this.state[margin.toString()].nextRequestId

  for (let i = 0; i < MAX_REQUESTS_INCREASE; i++) {
    if (currRequestId.eq(nextRequestId) || this.state[margin.toString()].requests[currRequestId] !== undefined) {
      break
    }
    currRequestId = this.state[margin.toString()].minRequestId.add(toBN(i + 1))
  }
  this.state[margin.toString()].minRequestId = currRequestId
}

const liquidateAndValidate = async (requestId, liquidator, margin) => {
  await validateLPState(this.state)

  const request = this.state[margin.toString()].requests[requestId]

  const beforeOwnerTokenBalance = await this.token.balanceOf(request.owner)
  const beforeOwnerThetaTokenBalance = await this.thetaVault[margin.toString()].balanceOf(request.owner)

  const beforeContractTokensBalance = await this.token.balanceOf(this.thetaVault[margin.toString()].address)
  const beforeContractThetaTokensBalance = await this.thetaVault[margin.toString()].balanceOf(
    this.thetaVault[margin.toString()].address,
  )

  const tx = await this.thetaVault[margin.toString()].liquidateRequest(requestId, { from: liquidator })

  const isDeposit = request.requestType.toNumber() === DEPOSIT_REQUEST_TYPE

  const afterOwnerTokenBalance = await this.token.balanceOf(request.owner)
  const afterOwnerThetaTokenBalance = await this.thetaVault[margin.toString()].balanceOf(request.owner)

  const afterContractTokensBalance = await this.token.balanceOf(this.thetaVault[margin.toString()].address)
  const afterContractThetaTokensBalance = await this.thetaVault[margin.toString()].balanceOf(
    this.thetaVault[margin.toString()].address,
  )

  if (isDeposit) {
    this.state[margin.toString()].totalDepositRequestsAmount = this.state[
      margin.toString()
    ].totalDepositRequestsAmount.sub(request.tokenAmount)

    expect(afterOwnerTokenBalance.sub(beforeOwnerTokenBalance)).to.be.bignumber.equal(request.tokenAmount)
    expect(afterOwnerThetaTokenBalance).to.be.bignumber.equal(beforeOwnerThetaTokenBalance)

    expect(beforeContractTokensBalance.sub(afterContractTokensBalance)).to.be.bignumber.equal(request.tokenAmount)
    expect(beforeContractThetaTokensBalance).to.be.bignumber.equal(afterContractThetaTokensBalance)
  } else {
    expect(afterOwnerThetaTokenBalance.sub(beforeOwnerThetaTokenBalance)).to.be.bignumber.equal(request.tokenAmount)
    expect(afterOwnerTokenBalance).to.be.bignumber.equal(beforeOwnerTokenBalance)

    expect(beforeContractThetaTokensBalance.sub(afterContractThetaTokensBalance)).to.be.bignumber.equal(
      request.tokenAmount,
    )
    expect(beforeContractTokensBalance).to.be.bignumber.equal(afterContractTokensBalance)
  }

  removeRequest(requestId, margin)

  await validateLPState(this.state)
  await validateState(margin)
}

const rebalanceAndValidate = async margin => {
  const tx = await this.thetaVault[margin.toString()].rebalance({ from: admin })

  const lastLatestSnapshotTimestamp = this.state.latestSnapshotTimestamp
  const { latestTimestamp: timestamp, snapshot } = await updateSnapshots(this.state)

  const dexPositionUnits = this.state[margin.toString()].volTokenPositionUnits
    .mul(this.state[margin.toString()].dexVolTokenAmount)
    .div(this.state[margin.toString()].volTokenSupply)
  const adjustedPositionUnits = dexPositionUnits
    .mul(MAX_FEE_PERCENTAGE.add(EXTRA_LIQUIDITY_PERCENTAGE))
    .div(MAX_FEE_PERCENTAGE)

  const extraLiquidity = this.state[margin.toString()].totalVaultLeveragedAmount.sub(adjustedPositionUnits)

  const { burnedLPTokens } = await calculateWithdrawAmounts(this.state, extraLiquidity)
  this.state.lpBalances[this.thetaVault[margin.toString()].address] =
    this.state.lpBalances[this.thetaVault[margin.toString()].address].sub(burnedLPTokens)
  this.state.lpTokensSupply = this.state.lpTokensSupply.sub(burnedLPTokens)
  this.state.sharedPool = this.state.sharedPool.sub(extraLiquidity)

  this.state[margin.toString()].totalVaultLeveragedAmount =
    this.state[margin.toString()].totalVaultLeveragedAmount.sub(extraLiquidity)

  const scalingFactor = await this.volToken[margin.toString()].scalingFactor()
  const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue
  let expectedPosition = this.state.positions[this.volToken[margin.toString()].address]

  await depositToVault(
    tx,
    extraLiquidity,
    margin,
    timestamp,
    lastLatestSnapshotTimestamp,
    snapshot,
    cviValue,
    scalingFactor,
    expectedPosition,
  )

  //TODO: Verify expectedPosition? More?

  await validateLPState(this.state)
  await validateState(margin)
}

//TODO: Make sure no open fees occurs when minting tokens (built-in in all tests)
//TODO: Make sure no close fees occurs when burning tokens (built-in in all tests)
//TODO: Make sure depositing when no liquidity in dex does only platform deposit and withdrawing only platform withdraw

for (let margin of [1]) {
  //MARGINS_TO_TEST) {
  describe(`ThetaVault (margin = ${margin})`, () => {
    beforeEach(async () => {
      await beforeEachToken(margin)
    })

    it('reverts when initializing with any zero address component', async () => {
      const initialThetaRate = toBN(1, 12)

      await deployPlatform()
      const token = getContracts().token

      const thetaVault = await ThetaVault.new({ from: admin })
      await expectRevert.unspecified(
        thetaVault.initialize(
          initialThetaRate,
          ZERO_ADDRESS,
          margin,
          token.address,
          token.address,
          token.address,
          'CVI-THETA',
          'CVI-THETA',
        ),
      )
      await expectRevert.unspecified(
        thetaVault.initialize(
          initialThetaRate,
          token.address,
          margin,
          ZERO_ADDRESS,
          token.address,
          token.address,
          'CVI-THETA',
          'CVI-THETA',
        ),
      )
      await expectRevert.unspecified(
        thetaVault.initialize(
          initialThetaRate,
          token.address,
          margin,
          token.address,
          ZERO_ADDRESS,
          token.address,
          'CVI-THETA',
          'CVI-THETA',
        ),
      )
      await expectRevert.unspecified(
        thetaVault.initialize(
          initialThetaRate,
          token.address,
          margin,
          token.address,
          token.address,
          ZERO_ADDRESS,
          'CVI-THETA',
          'CVI-THETA',
        ),
      )
    })

    it('reverts when initializing with zero initial token to theta rate ratio', async () => {
      await deployPlatform()
      const token = getContracts().token

      const thetaVault = await ThetaVault.new({ from: admin })
      await expectRevert.unspecified(
        thetaVault.initialize(
          0,
          token.address,
          margin,
          token.address,
          token.address,
          token.address,
          'CVI-THETA',
          'CVI-THETA',
        ),
      )
    })

    it('reverts when submitting requests for zero tokens', async () => {
      await expectRevert(
        this.thetaVault[margin.toString()].submitDepositRequest(0, { from: bob }),
        'Token amount must be positive',
      )
      await expectRevert(
        this.thetaVault[margin.toString()].submitWithdrawRequest(0, { from: bob }),
        'Token amount must be positive',
      )
    })

    it('reverts when fulfilling deposit reuqests of different owner', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, new BN(1000), bob, margin)
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillDepositRequest(requestId, { from: alice }),
        'Not allowed',
      )
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillDepositRequest(requestId, { from: admin }),
        'Not allowed',
      )
    })

    it('reverts when fulfilling withdraw request of different owner', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(requestId, bob, margin)

      await time.increase(DEPOSIT_LOCK_TIME)
      const bobThetaTokensAmount = await this.thetaVault[margin.toString()].balanceOf(bob)
      const withdrawRequestId = await submitAndValidate(WITHDRAW_REQUEST_TYPE, bobThetaTokensAmount, bob, margin)

      await time.increase(DELAY_REQUEST_TIME)
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillWithdrawRequest(withdrawRequestId, { from: alice }),
        'Not allowed',
      )
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillWithdrawRequest(withdrawRequestId, { from: admin }),
        'Not allowed',
      )
    })

    it('reverts when fulfilling reuqests with an invalid id', async () => {
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillDepositRequest(0, { from: bob }),
        'Invalid request id',
      )
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillWithdrawRequest(6, { from: bob }),
        'Invalid request id',
      )
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillDepositRequest(1, { from: bob }),
        'Invalid request id',
      )
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillWithdrawRequest(7, { from: bob }),
        'Invalid request id',
      )
    })

    it('reverts when fulfilling deposit reuqest with withdraw request id', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(requestId, bob, margin)

      await time.increase(DEPOSIT_LOCK_TIME)
      const bobThetaTokensAmount = await this.thetaVault[margin.toString()].balanceOf(bob)

      const withdrawRequestId = await submitAndValidate(WITHDRAW_REQUEST_TYPE, bobThetaTokensAmount, bob, margin)
      const depositRequestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)

      await expectRevert(
        this.thetaVault[margin.toString()].fulfillDepositRequest(withdrawRequestId, { from: bob }),
        'Wrong request type',
      )
    })

    it('reverts when fulfilling withdraw request with deposit withdraw id', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)

      await expectRevert(
        this.thetaVault[margin.toString()].fulfillWithdrawRequest(requestId, { from: bob }),
        'Wrong request type',
      )
    })

    it('reverts when fulfilling deposit request ahead of time', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME.sub(toBN(10)))
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillDepositRequest(requestId, { from: bob }),
        'Target time not reached',
      )
    })

    it('reverts when fulfilling withdraw request ahead of time', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(requestId, bob, margin)

      await time.increase(DEPOSIT_LOCK_TIME)
      const bobThetaTokensAmount = await this.thetaVault[margin.toString()].balanceOf(bob)

      const withdrawRequestId = await submitAndValidate(WITHDRAW_REQUEST_TYPE, bobThetaTokensAmount, bob, margin)
      await time.increase(DELAY_REQUEST_TIME.sub(toBN(10)))
      await expectRevert(
        this.thetaVault[margin.toString()].fulfillWithdrawRequest(withdrawRequestId, { from: bob }),
        'Target time not reached',
      )
    })

    it('reverts when submitting a deposit request which exceeds the cap', async () => {
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))
      await submitDepositFulfillAndValidate(bob, toUSD(99000), margin)

      await expectRevert(submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1001), alice, margin), 'Deposit cap reached')
    })

    it('reverts when submitting a deposit request and cap was already reached', async () => {
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))

      const balance = (await this.thetaVault[margin.toString()].totalBalance()).balance
      //TODO: Why is balance not exact?... (funding fees...)

      console.log(balance.toString())
      await submitDepositFulfillAndValidate(bob, toUSD(200000).sub(balance).sub(toUSD(1)), margin)

      // Move time so balance goes up over cap
      await time.increase(SECONDS_PER_DAY)

      const balance2 = (await this.thetaVault[margin.toString()].totalBalance()).balance
      expect(balance2).to.be.bignumber.above(toUSD(200000))

      await expectRevert(submitAndValidate(DEPOSIT_REQUEST_TYPE, toBN(1), alice, margin), 'Deposit cap reached')
    })

    it('reverts when submitting a deposit request that, along with other waiting requests, exceeds the cap', async () => {
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))
      await submitDepositFulfillAndValidate(bob, toUSD(99000), margin)
      await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(200), alice, margin)
      await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(300), carol, margin)
      await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(400), dave, margin)

      await expectRevert(submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(101), eve, margin), 'Deposit cap reached')
    })

    it('does not revert when submitting a deposit request after balance changes to be lower than cap', async () => {
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))
      const requestId = await submitDepositFulfillAndValidate(bob, toUSD(99000), margin)

      await expectRevert(submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1001), alice, margin), 'Deposit cap reached')

      await time.increase(DEPOSIT_LOCK_TIME)

      await submitWithdrawFulfillAndValidate(
        bob,
        (await this.thetaVault[margin.toString()].balanceOf(bob)).div(toBN(200)),
        margin,
      )
      await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1001), alice, margin)
    })

    it('does not revert when submitting a deposit request which nearly exceeds the cap', async () => {
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))
      const requestId = await submitDepositFulfillAndValidate(bob, toUSD(99000), margin)

      await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(999), alice, margin)
    })

    // Note: tested in beforeEach, so no need to do anything, test is here to make sure it is tested
    it('deposits entire amount to platform when fulfilling deposit and reserves are zero', async () => {})

    it.skip('withdraws entire amount from platform when fulfilling deposit and reserves are zero', async () => {})

    it.skip('withdraws entire amount from platform when fulfilling deposit and reserves are not zero, but no dex lp tokens exist in vault', async () => {})

    it('reverts when fulfilling withdraw while locked', async () => {
      const requestId = await submitDepositFulfillAndValidate(bob, toUSD(1000), margin)

      await time.increase(DEPOSIT_LOCK_TIME.sub(toBN(10)))

      await expectRevert(
        submitWithdrawFulfillAndValidate(bob, await this.thetaVault[margin.toString()].balanceOf(bob), margin),
        'Deposit locked',
      )
    })

    it('withdraws properly when locking period just passed', async () => {
      const requestId = await submitDepositFulfillAndValidate(bob, toUSD(1000), margin)

      await time.increase(DEPOSIT_LOCK_TIME)

      await submitWithdrawFulfillAndValidate(bob, await this.thetaVault[margin.toString()].balanceOf(bob), margin)
    })

    it.skip('reverts when fulfilling a too small deposit that mints zero theta lp tokens (it will then be liquidable)', async () => {})

    it('submits a withdraw request properly when cap is exceeded', async () => {
      //TODO: Function (except last statement) and reuse
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))
      const balance = (await this.thetaVault[margin.toString()].totalBalance()).balance
      await submitDepositFulfillAndValidate(bob, toUSD(200000).sub(balance).sub(toUSD(1)), margin)

      await time.increase(SECONDS_PER_DAY)

      const balance2 = (await this.thetaVault[margin.toString()].totalBalance()).balance
      expect(balance2).to.be.bignumber.above(toUSD(200000))

      await expectRevert(submitAndValidate(DEPOSIT_REQUEST_TYPE, toBN(1), alice, margin), 'Deposit cap reached')

      await submitAndValidate(
        WITHDRAW_REQUEST_TYPE,
        await this.thetaVault[margin.toString()].balanceOf(bob),
        bob,
        margin,
      )
    })

    it('does not count withdraw requests in deposit cap', async () => {
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))
      const requestId = await submitDepositFulfillAndValidate(bob, toUSD(50000), margin)

      await time.increase(DEPOSIT_LOCK_TIME)

      await submitAndValidate(
        WITHDRAW_REQUEST_TYPE,
        await this.thetaVault[margin.toString()].balanceOf(bob),
        bob,
        margin,
      )
      await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(4999), alice, margin)
    })

    it.skip('allows submitting a request after maxed out by liquidating an existing deposit request', async () => {
      //TODO: Function (except last statement) and reuse
      await this.thetaVault[margin.toString()].setDepositCap(toUSD(200000))
      const balance = (await this.thetaVault[margin.toString()].totalBalance()).balance
      await submitDepositFulfillAndValidate(bob, toUSD(200000).sub(balance).sub(toUSD(1)), margin)

      await time.increase(SECONDS_PER_DAY)

      const balance2 = (await this.thetaVault[margin.toString()].totalBalance()).balance
      expect(balance2).to.be.bignumber.above(toUSD(200000))

      await expectRevert(submitAndValidate(DEPOSIT_REQUEST_TYPE, toBN(1), alice, margin), 'Deposit cap reached')

      await submitAndValidate(
        WITHDRAW_REQUEST_TYPE,
        await this.thetaVault[margin.toString()].balanceOf(bob),
        bob,
        margin,
      )

      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(1000)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      const { requestId, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        new BN(1000),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )

      await time.increase(new BN(SECONDS_PER_HOUR).add(new BN(MAX_PENALTY_TIME)).add(new BN(1)))
      await liquidateAndValidate(requestId, request, alice, margin)

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1001), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )
      await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin)
    })

    it.skip('allows submitting a request after maxed out by fulfilling an existing withdraw request', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)

      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(1000)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        new BN(1000),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )

      await time.increase(SECONDS_PER_HOUR)
      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, isCollateralized)

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1001), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )
      await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin)
    })

    it.skip('sets deposit cap properly', async () => {
      expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.true
      await this.volToken[margin.toString()].setVerifyTotalRequestsAmount(false, { from: admin })
      expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.false

      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.sub(new BN(1)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      const { requestId, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        new BN(1000),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await this.volToken[margin.toString()].setVerifyTotalRequestsAmount(true, { from: admin })
      expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.true

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )

      await time.increase(new BN(SECONDS_PER_HOUR).add(new BN(MAX_PENALTY_TIME)).add(new BN(1)))
      await liquidateAndValidate(requestId, request, alice, margin)

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(2), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )
      await submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin)
    })

    it('submits a deposit request properly', async () => {
      await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
    })

    it.skip('submits a withdraw request properly', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await fulfillAndValidate(requestId, bob)

      //TODO: Complete
      //await testSubmitRequest(BURN_REQUEST_TYPE, margin);
    })

    it('deposits properly for first user', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(requestId, bob, margin)
    })

    it.skip('deposits properly when intrinsic price is higher than dex price', async () => {})

    it.skip('deposits properly when intrinsic price is lower than dex price', async () => {})

    it.skip('deposits properly when intrinsic price is equal to dex price', async () => {})

    it.skip('advances min request id properly to skip already fulfilled requests', async () => {
      await depositAndValidate(this.state, margin * 50000 * 10, alice)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2))
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      for (let i = 0; i < 5; i++) {
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
        expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2 + i + 1))
        expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      }

      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(7))
    })

    it.skip('advances min request id but up to maximum only', async () => {
      await depositAndValidate(this.state, margin * 50000 * 10, alice)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2))
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      for (let i = 0; i < 40; i++) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
        expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2 + i + 1))
        expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      }

      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(31))
    })

    it.skip('deposits tokens properly by keepers', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(3 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
    })

    it.skip('withdraws tokens properly by keepers', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(3 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
    })

    it.skip('reverts when fulfilling deposit request by keepers before target timestamp', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      const requestTimestamp = await time.latest()
      await time.increaseTo(requestTimestamp.add(toBN(2 * SECONDS_PER_HOUR).sub(toBN(3))))

      await expectRevert(
        fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true),
        'Target time not reached',
      )
    })

    it.skip('deposits properly when there is a premium fee', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(11000), 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin)
    })

    it.skip('deposits properly for multi users when time, cvi and pool skew changes', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await time.increase(60 * 60)
      await submitMintFulfillAndValidate(new BN(700), 2 * SECONDS_PER_HOUR, carol, margin)
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await time.increase(60 * 70)
      await submitMintFulfillAndValidate(new BN(200), 2 * SECONDS_PER_HOUR, dave, margin)
      await time.increase(60 * 80)
      await submitMintFulfillAndValidate(new BN(500), 2 * SECONDS_PER_HOUR, bob, margin)
    })

    //TODO: All arbitrage tests on submitting deposit

    //TOOD: All arbitrage tests on submitting withdraw

    it(/*.only*/ 'reverts when fulfilling a deposit and pool is still skewed after dex price high arbitrage', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)

      // Skew pool by buying tons of tokens pumping up their price
      const timestamp = await time.latest()

      await this.token.transfer(bob, toUSD(1000), { from: admin })
      await this.token.approve(this.router.address, toUSD(1000), { from: bob })
      await this.router.swapExactTokensForTokens(
        toUSD(1000),
        0,
        [this.token.address, this.volToken[margin.toString()].address],
        bob,
        timestamp.add(toBN(100)),
        { from: bob },
      )

      const reserves = await this.volTokenPair[margin.toString()].getReserves()
      console.log('after swap:')
      console.log(reserves._reserve0.toString())
      console.log(reserves._reserve1.toString())
      buyVolTokenInDex(toUSD(1000), margin)

      await fulfillAndValidate(requestId, bob, margin, undefined, undefined, true)
    })

    it.skip('reverts when fulfilling a deposit and pool is still skewed after dex price low arbitrage', async () => {})

    it.skip('reverts when fulfilling a deposit and dex price high arbitrage fails to gain usdc', async () => {})

    it.skip('reverts when fulfilling a deposit and dex price low arbitrage fails to gain usdc', async () => {})

    it.skip('deposits properly when pool is unskewed by dex price high arbitrage, without needing to withdraw liqudiity', async () => {})

    it.skip('deposits properly when pool is unskewed by dex price low arbitrage, without needing to withdraw liqudiity', async () => {})

    it.skip('deposits properly when pool is unskewed by dex price high arbitrage, with withdraw liquidity', async () => {})

    it.skip('deposits properly when pool is unskewed by dex price low arbitrage, with withdrawn liquidity', async () => {})

    it.skip('arbitrage gap is closed properly in various skew percentages when depositting', async () => {})

    //TODO: Update after TODO in code is resolved
    it.skip('reverts when submitting a deposit request and pool is skewed', async () => {})

    //TODO: What does both ways mean?....
    it.skip('reverts when pool is skewed both ways', async () => {})

    it.skip('reverts when fulfilling a withdraw request and pool is still skewed after dex price high arbitrage', async () => {})

    it.skip('reverts when fulfilling a withdraw request and pool is still skewed after dex price low arbitrage', async () => {})

    it.skip('reverts when fulfilling a withdraw request and dex price high arbitrage fails to gain usdc', async () => {})

    it.skip('reverts when fulfilling a withdraw request and dex price low arbitrage fails to gain usdc', async () => {})

    it.skip('withdraws properly when pool is unskewed by dex price high arbitrage', async () => {})

    it.skip('withdraws properly when pool is unskewed by dex price low arbitrage', async () => {})

    it.skip('arbitrage gap is closed properly in various skew percentages when withdrawing', async () => {})

    it.skip('does not revert when submitting a withdraw request and pool is skewed', async () => {})

    it.skip('does not revert when submitting a deposit request and pool is nearly skewed', async () => {})

    it.skip('does not revert when fulfilling a deposit request and pool is nearly skewed', async () => {})

    it.skip('does not revert when fulfilling a withdraw request and pool is nearly skewed', async () => {})

    it.skip('deposits proportionaly', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await submitMintFulfillAndValidate(new BN(2000), 2 * SECONDS_PER_HOUR, carol, margin)
      await submitMintFulfillAndValidate(new BN(3000), 2 * SECONDS_PER_HOUR, dave, margin)

      const bobVolTokens = await this.volToken[margin.toString()].balanceOf(bob)
      const carolVolTokens = await this.volToken[margin.toString()].balanceOf(carol)
      const daveVolTokens = await this.volToken[margin.toString()].balanceOf(dave)

      expect(carolVolTokens.toNumber() / bobVolTokens.toNumber()).to.be.at.least(2.0)
      expect(carolVolTokens.toNumber() / bobVolTokens.toNumber()).to.be.at.most(2.01)

      expect(daveVolTokens.toNumber() / bobVolTokens.toNumber()).to.be.at.least(3.0)
      expect(daveVolTokens.toNumber() / bobVolTokens.toNumber()).to.be.at.most(3.01)
    })

    it.skip('splits deposits sum correctly when there is a position gain or position loss', async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
      await this.fakePriceProvider.setPrice(toCVI(9900))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
      await this.fakePriceProvider.setPrice(toCVI(10500))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
    })

    //TODO: Can this happen?...
    it.skip('returns tokens when fulfilling deposit without a possibility to cover liquidity', async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
      await this.fakePriceProvider.setPrice(toCVI(20000))

      await submitMintFulfillAndValidate(toBN(5000), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true, true)
      const balanceAfterAbort = await this.token.balanceOf(bob)
      expect(balanceAfterAbort).to.be.bignumber.equal(toBN(5000)) // Make sure bob got all his money back (penalty + time delay)
    })

    it.skip('deposits and withdraws properly for multi users', async () => {})

    it.skip('withdraws properly for first user', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(requestId, bob, margin)

      await time.increase(DEPOSIT_LOCK_TIME)

      const bobThetaTokens = await this.thetaVault[margin.toString()].balanceOf(bob)
      const withdrawRequestId = await submitAndValidate(WITHDRAW_REQUEST_TYPE, bobThetaTokens, bob, margin)
      time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(withdrawRequestId, bob, margin)
    })

    it.skip('withdraws properly by keepers', async () => {
      await depositAndValidate(this.state, margin * 10000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        BURN_REQUEST_TYPE,
        volTokens,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
      )
      await time.increase(2 * SECONDS_PER_HOUR)
      await fulfillBurnAndValidate(requestId, request, timeDelayFee, bob, margin, true)
    })

    it.skip('withdraws properly for multi users when time, cvi and pool skew changes', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await submitMintFulfillAndValidate(new BN(700), 2 * SECONDS_PER_HOUR, carol, margin)
      await submitMintFulfillAndValidate(new BN(200), 2 * SECONDS_PER_HOUR, dave, margin)
      await submitMintFulfillAndValidate(new BN(500), 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokensBob = await this.volToken[margin.toString()].balanceOf(bob)
      await submitBurnFulfillAndValidate(volTokensBob.div(toBN(2)), 2 * SECONDS_PER_HOUR, bob, margin)
      await time.increase(60 * 60)
      const volTokensCarol = await this.volToken[margin.toString()].balanceOf(carol)
      await submitBurnFulfillAndValidate(volTokensCarol, SECONDS_PER_HOUR, carol, margin)
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await time.increase(60 * 70)
      const volTokensDave = await this.volToken[margin.toString()].balanceOf(dave)
      await submitBurnFulfillAndValidate(volTokensDave, 2 * SECONDS_PER_HOUR, dave, margin)
      await time.increase(60 * 80)
      await submitBurnFulfillAndValidate(volTokensBob.div(toBN(2)), 3 * SECONDS_PER_HOUR, bob, margin)
    })

    it.skip('reverts when trying to liquidate before max request fulfill time passed', async () => {
      for (let delay of DELAYS_TO_TEST) {
        await expectRevert(
          submitAndLiquidate(
            MINT_REQUEST_TYPE,
            new BN(1000),
            delay,
            bob,
            alice,
            margin,
            MAX_PENALTY_FEE.sub(new BN(2)),
          ),
          'Not liquidable',
        )
      }
    })

    it.skip('reverts when trying to deposit/withdraw when vol token position balance is negative', async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))

      await depositAndValidate(this.state, margin * 10000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const daysToLiquidation = await calculateLiquidationDays(
        this.state,
        this.volToken[margin.toString()].address,
        11000,
        true,
      )
      await time.increase(SECONDS_PER_DAY.mul(daysToLiquidation))

      const result = await this.platform.calculatePositionBalance(this.volToken[margin.toString()].address)
      expect(result.isPositive).to.be.false

      await expectRevert(
        submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin),
        'Negative balance',
      )
      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      await expectRevert(submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin), 'Negative balance')
      await expectRevert(this.volToken[margin.toString()].rebaseCVI({ from: admin }), 'Negative balance')
    })

    it('reverts when liquidating a non-existent request id', async () => {
      await expectRevert(this.thetaVault[margin.toString()].liquidateRequest(2, { from: bob }), 'Request id not found')
    })

    it.skip('reverts when liquidating a deposit request not by owner', async () => {})

    it.skip('reverts when liquidating a withdraw request not by owner', async () => {})

    it('allows deposit request liquidation properly', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(MIN_LIQUIDATION_TIME)
      await liquidateAndValidate(requestId, bob, margin)
    })

    it('allows withdraw request liquidation properly', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(requestId, bob, margin)

      await time.increase(DEPOSIT_LOCK_TIME)

      const bobThetaTokens = await this.thetaVault[margin.toString()].balanceOf(bob)
      const withdrawRequestId = await submitAndValidate(WITHDRAW_REQUEST_TYPE, bobThetaTokens, bob, margin)
      time.increase(MIN_LIQUIDATION_TIME)
      await liquidateAndValidate(withdrawRequestId, bob, margin)
    })

    it.skip('does not liquidate when fulfilling a liquidable deposit request', async () => {})

    it.skip('does not liquidate when fulfilling a liquidable withdraw request', async () => {})

    it.skip('reverts when fulfilling a deposit request not by fulfiller or owner', async () => {})

    it.skip('reverts when fulfilling a withdraw request not by fulfiller or owner', async () => {})

    it.skip('reverts when rebalancing and pool is still skewed after dex price high arbitrage', async () => {})

    it.skip('reverts when rebalancing and pool is still skewed after dex price low arbitrage', async () => {})

    it.skip('reverts when rebalancing and dex price high arbitrage fails to gain usdc', async () => {})

    it.skip('reverts when rebalancing and dex price low arbitrage fails to gain usdc', async () => {})

    it.skip('reverts when rebalancing is not needed', async () => {})

    it.skip('rebalances properly when needed', async () => {
      const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, margin)
      await time.increase(DELAY_REQUEST_TIME)
      await fulfillAndValidate(requestId, bob, margin)

      // Cause funding fee to allow rebalancing
      //TODO: Better constant
      await time.increase(SECONDS_PER_HOUR * 24 * 5)

      await this.fakePriceProvider.setPrice(toCVI(10000))
      await rebalanceAndValidate(margin)
    })

    it.skip('rebalances properly when pool is unskewed by dex price high arbitrage', async () => {})

    it.skip('rebalances properly when pool is unskewed by dex price low arbitrage', async () => {})

    it.skip('arbitrage gap is closed properly in various skew percentages when rebalancing', async () => {})

    it.skip('reverts when running only owner functions not by owner', async () => {})

    it.skip('sets fulfiller properly', async () => {})

    it.skip('sets min pool skewed percentage properly', async () => {})

    it.skip('sets deposit cap properly', async () => {})

    it.skip('sets lockup period properly', async () => {})

    it.skip('sets request delay period properly', async () => {})

    it.skip('sets liquidation period properly', async () => {})

    it.skip('sets extra liquidity percentage properly', async () => {})

    it.skip('calculates total balance correctly when cvi, time and pool skew changes', async () => {})

    it.skip('reverts when trying to get total balance and pool is too skewed', async () => {})

    it.skip('sets initial values properly after intiailization', async () => {})

    it.skip('allows fulfilling when totalDepositRequestsAmount becomes negative (zeroes it instead)', async () => {
      await beforeEachToken(margin, true)
      await depositAndValidate(this.state, toBN(100000, 6), bob)

      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000, 6),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      // Zero out totalRequestsAmount
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(1000, 6))
      await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(0), { from: admin })
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))

      await time.increase(SECONDS_PER_HOUR)

      // Should pass properly
      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin)
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))

      const {
        requestId: requestId2,
        timeDelayFee: timeDelayFee2,
        request: request2,
      } = await submitAndValidate(MINT_REQUEST_TYPE, toBN(2000, 6), SECONDS_PER_HOUR, bob, margin)

      // Subtract 1 from totalRequestsAmount
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(2000, 6))
      await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(2000, 6).sub(toBN(1)), { from: admin })
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(
        toBN(2000, 6).sub(toBN(1)),
      )

      await time.increase(SECONDS_PER_HOUR)

      // Should pass properly
      await fulfillMintAndValidate(requestId2, request2, timeDelayFee2, bob, margin)
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))
    })
  })
}

describe('ThetaVaultRequestFulfiller', () => {
  beforeEach(async () => {
    await beforeEachToken(1)
    this.thetaRequestFulfiller['1'].setFulfillerAddress(keeper, true)
    this.volToken['1'].setFulfiller(this.thetaRequestFulfiller['1'].address, { from: admin })
  })

  it('shows no upkeep when no requests exist', async () => {
    expect((await this.thetaRequestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.thetaRequestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it('shows no upkeep when all requests are before target timestamp', async () => {
    const requestId = await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, 1)
    await time.increase(DELAY_REQUEST_TIME)
    await fulfillAndValidate(requestId, bob, 1)

    await time.increase(DEPOSIT_LOCK_TIME)

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        await submitAndValidate(DEPOSIT_REQUEST_TYPE, toUSD(1000), bob, 1)
      } else {
        await submitAndValidate(
          WITHDRAW_REQUEST_TYPE,
          (await this.thetaVault['1'].balanceOf(bob)).div(toBN(10)),
          bob,
          1,
        )
      }
    }

    await time.increase(DELAY_REQUEST_TIME.sub(toBN(30)))

    expect((await this.thetaRequestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.thetaRequestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it.skip('shows no upkeep when all requests are already fulfilled', async () => {
    await depositAndValidate(this.state, toBN(500000, 6), bob)

    this.volToken['1'].setFulfiller(keeper, { from: admin })

    for (let i = 0; i < 5; i++) {
      await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR, false, false, true)
      await this.fakePriceProvider.setPrice(toCVI(10000))
    }

    for (let i = 0; i < 5; i++) {
      await submitBurnFulfillAndValidate(
        (await this.volToken['1'].balanceOf(bob)).div(toBN(5)),
        2 * SECONDS_PER_HOUR,
        bob,
        1,
        true,
      )
    }

    this.volToken['1'].setFulfiller(this.requestFulfiller['1'].address, { from: admin })

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it.skip('shows no upkeep when all keepers requests are already fulfilled and existing requests are before target timestamp', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)

    this.volToken['1'].setFulfiller(keeper, { from: admin })

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      } else {
        await submitAndValidate(BURN_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      }
    }

    for (let i = 0; i < 5; i++) {
      await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR, false, false, true)
      await this.fakePriceProvider.setPrice(toCVI(10000))
    }

    for (let i = 0; i < 5; i++) {
      await submitBurnFulfillAndValidate(
        (await this.volToken['1'].balanceOf(bob)).div(toBN(5)),
        2 * SECONDS_PER_HOUR,
        bob,
        1,
      )
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    this.volToken['1'].setFulfiller(this.requestFulfiller['1'].address, { from: admin })

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it.skip('shows upkeep when only withdraw requests exist', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)

    for (let i = 0; i < 5; i++) {
      await submitAndValidate(BURN_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1, true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.true
    await this.requestFulfiller['1'].performUpkeep(0, { from: keeper })
  })

  it.skip('shows upkeep when only deposit requests exist', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    for (let i = 0; i < 5; i++) {
      await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1, true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.true
    await this.requestFulfiller['1'].performUpkeep(0, { from: keeper })
  })

  it.skip('fulfills properly both deposit and withdraw requests when performing upkeep', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, dave, 1, SECONDS_PER_HOUR)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      2 * SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )

    const accounts = [bob]
    const requestIds = [requestId]
    const timeDelayFees = [timeDelayFee]
    const shouldFulfill = [true]

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        const account = i >= 2 ? alice : carol
        const { requestId, timeDelayFee } = await submitAndValidate(
          MINT_REQUEST_TYPE,
          toBN(1000),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      } else {
        const account = i >= 2 ? bob : dave
        const { requestId, timeDelayFee } = await submitAndValidate(
          BURN_REQUEST_TYPE,
          (await this.volToken['1'].balanceOf(account)).div(toBN(10)),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      }

      shouldFulfill.push(true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    await fulfillAndValidate(
      requestIds,
      undefined,
      timeDelayFees,
      accounts,
      1,
      false,
      false,
      true,
      undefined,
      shouldFulfill,
    )
  })

  it.skip('checks requests from minRequestId to nextRequestId only (and not before minRequestId)', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, dave, 1, SECONDS_PER_HOUR)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      2 * SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )

    // Does not include first request
    const accounts = []
    const requestIds = []
    const timeDelayFees = []
    const shouldFulfill = []

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        const account = i >= 2 ? alice : carol
        const { requestId, timeDelayFee } = await submitAndValidate(
          MINT_REQUEST_TYPE,
          toBN(1000),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      } else {
        const account = i >= 2 ? bob : dave
        const { requestId, timeDelayFee } = await submitAndValidate(
          BURN_REQUEST_TYPE,
          (await this.volToken['1'].balanceOf(account)).div(toBN(10)),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      }

      shouldFulfill.push(true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)
    await this.volToken['1'].setMinRequestId(requestId.add(toBN(1))) // Should skip first request
    this.state['1'].minRequestId = requestId.add(toBN(1))

    await fulfillAndValidate(
      requestIds,
      undefined,
      timeDelayFees,
      accounts,
      1,
      false,
      false,
      true,
      undefined,
      shouldFulfill,
    )

    // Make sure request still exists
    const request = await this.volToken['1'].requests(requestId)
    expect(request.requestType).to.be.bignumber.equal(toBN(MINT_REQUEST_TYPE))
  })

  it.skip('checks requests from minRequestId to up to maxMinRequestIncrements only', async () => {
    expect(await this.volToken['1'].maxMinRequestIncrements()).to.be.bignumber.equal(toBN(30))

    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, dave, 1, SECONDS_PER_HOUR)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      2 * SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )

    // Does not include first request
    const accounts = [bob]
    const requestIds = [requestId]
    const timeDelayFees = [timeDelayFee]
    const shouldFulfill = [true]

    const extraAccounts = []
    const extraRequestIds = []
    const extraTimeDelayFees = []
    const extraShouldFulfill = []

    for (let i = 0; i < 35; i++) {
      if (i % 2 === 0) {
        const account = i >= 2 ? alice : carol
        const { requestId, timeDelayFee } = await submitAndValidate(
          MINT_REQUEST_TYPE,
          toBN(1000),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )

        if (i < 29) {
          accounts.push(account)
          timeDelayFees.push(timeDelayFee)
          requestIds.push(requestId)
          shouldFulfill.push(true)
        } else {
          extraAccounts.push(account)
          extraTimeDelayFees.push(timeDelayFee)
          extraRequestIds.push(requestId)
          extraShouldFulfill.push(true)
        }
      } else {
        const account = i >= 2 ? bob : dave
        const { requestId, timeDelayFee } = await submitAndValidate(
          BURN_REQUEST_TYPE,
          (await this.volToken['1'].balanceOf(account)).div(toBN(30)),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )

        if (i < 29) {
          accounts.push(account)
          timeDelayFees.push(timeDelayFee)
          requestIds.push(requestId)
          shouldFulfill.push(true)
        } else {
          extraAccounts.push(account)
          extraTimeDelayFees.push(timeDelayFee)
          extraRequestIds.push(requestId)
          extraShouldFulfill.push(true)
        }
      }
    }

    await time.increase(2 * SECONDS_PER_HOUR)
    await fulfillAndValidate(
      requestIds,
      undefined,
      timeDelayFees,
      accounts,
      1,
      false,
      false,
      true,
      undefined,
      shouldFulfill,
    )

    // Make sure requests in indices 33 to 37 still exists, and others are fulfilled or non-existent
    for (let i = 1; i < 40; i++) {
      const request = await this.volToken['1'].requests(toBN(i))

      if (i >= 39) {
        expect(request.requestType).to.be.bignumber.equal(toBN(0))
      } else if (i >= 33) {
        expect(request.requestType).to.be.bignumber.not.equal(toBN(0))
      } else {
        expect(request.requestType).to.be.bignumber.equal(toBN(0))
      }
    }

    await fulfillAndValidate(
      extraRequestIds,
      undefined,
      extraTimeDelayFees,
      extraAccounts,
      1,
      false,
      false,
      true,
      undefined,
      extraShouldFulfill,
    )

    // Make sure all remaining requests are now fulfilled
    for (let i = 1; i < 40; i++) {
      const request = await this.volToken['1'].requests(toBN(i))
      expect(request.requestType).to.be.bignumber.equal(toBN(0))
    }
  })

  it.skip('allows upkeep from any address when whitelist is disabled', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    await this.requestFulfiller['1'].setEnableWhitelist(false, { from: admin })

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate([requestId], undefined, [timeDelayFee], [bob], 1, false, false, true, undefined, [
      true,
    ])

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate([requestId2], undefined, [timeDelayFee2], [bob], 1, false, false, true, undefined, [
      true,
    ])

    const { requestId: requestId3, timeDelayFee: timeDelayFee3 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate([requestId3], undefined, [timeDelayFee3], [bob], 1, false, false, true, undefined, [
      true,
    ])
  })

  it.skip('reverts when trying to upkeep from non-whitelisted address and whitelist is enabled', async () => {
    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: bob }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: admin }), 'Not allowed')
  })

  it.skip('allows multiple addresses whiltelisting', async () => {
    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await depositAndValidate(this.state, toBN(50000, 6), bob)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setFulfillerAddress(alice, true, { from: admin })
    await this.requestFulfiller['1'].setFulfillerAddress(carol, true, { from: admin })

    await fulfillMintAndValidate(
      [requestId],
      undefined,
      [timeDelayFee],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      alice,
    )

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate(
      [requestId2],
      undefined,
      [timeDelayFee2],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      carol,
    )
  })

  it.skip('sets whitelisted addresses properly', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setFulfillerAddress(alice, true, { from: admin })

    await fulfillMintAndValidate(
      [requestId],
      undefined,
      [timeDelayFee],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      alice,
    )

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)
    await this.requestFulfiller['1'].setFulfillerAddress(alice, false, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setFulfillerAddress(carol, true, { from: admin })

    await fulfillMintAndValidate(
      [requestId2],
      undefined,
      [timeDelayFee2],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      carol,
    )
  })

  it.skip('sets requests manager properly', async () => {})

  it.skip('sets whitelist enabled properly', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })
    await this.requestFulfiller['1'].setFulfillerAddress(alice, true, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setEnableWhitelist(false, { from: admin })

    await fulfillMintAndValidate(
      [requestId],
      undefined,
      [timeDelayFee],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      carol,
    )

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await fulfillMintAndValidate(
      [requestId2],
      undefined,
      [timeDelayFee2],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      alice,
    )
  })
})
