const sdk = require('@defillama/sdk');
const utils = require('../utils');
const superagent = require('superagent');
const { request, gql } = require('graphql-request');
const { BigNumber}  = require('ethers');

const hub = '0xb5087f95643a9a4069471a28d32c569d9bd57fe4';
const lens = '0xb73f303472c4fd4ff3b9f59ce0f9b13e47fbfd19';
const zeroAddress = '0x0000000000000000000000000000000000000000';

const viewHelper = {
  ethereum: '0xD58dd6deF2d0e8E16ffc537c7f269719e19b9fE4',
}

const booster = {
  ethereum: '0x631e58246A88c3957763e1469cb52f93BC1dDCF2',
}

const admin = {
  ethereum: '0x4cc39af0d46b0f66fd33778c6629a696bdc310a0',
};

const controller = {
  ethereum: '0x901c8aa6a61f74ac95e7f397e22a0ac7c1242218',
};

const lit = {
  ethereum: '0xfd0205066521550d7d7ab19da8f72bb004b4c341',
};

const liqLIT = {
  ethereum: '0x03C6F0Ca0363652398abfb08d154F114e61c4Ad8',
};

const olit = {
  ethereum: '0x627fee87d0d9d2c55098a06ac805db8f98b158aa',
};

const oracle = {
  ethereum: '0x9d43ccb1ad7e0081cc8a8f1fd54d16e54a637e30',
};

const hubABI = require('./abis/BunniHub.json');
const lensABI = require('./abis/BunniLens.json');
const adminABI = require('./abis/TokenAdmin.json'); 
const gaugeABI = require('./abis/LiquidityGauge.json');
const controllerABI = require('./abis/GaugeController.json');
const oracleABI = require('./abis/OptionsOracle.json');
const boosterABI = require('./abis/Booster.json');
const viewHelperABI = require('./abis/ViewHelper.json');

const baseUrl = 'https://api.thegraph.com/subgraphs/name/bunniapp';
const chains = {
  ethereum: `${baseUrl}/bunni-mainnet`,
};

const query = gql`
    {
        bunniTokens(first: 1000, block: {number: <PLACEHOLDER>}) {
            address
            liquidity
            pool {
                fee
                tick
                liquidity
                totalFeesToken0
                totalFeesToken1
                totalVolumeToken0
                totalVolumeToken1
            }
        }
    }
`;

const queryPrior = gql`
    {
        pools(first: 1000, block: {number: <PLACEHOLDER>}) {
            address
            totalFeesToken0
            totalFeesToken1
            totalVolumeToken0
            totalVolumeToken1
        }
    }
`;

const apy = (apr, num_periods) => {
  const periodic_rate = apr / num_periods / 100;
  const apy = Math.pow(1 + periodic_rate, num_periods) - 1;
  return apy * 100;
};

const topLvl = async (chainString, url, timestamp) => {
  try {
    const [block, blockPrior] = await utils.getBlocks(chainString, timestamp, [
      url,
    ]);

    let [
      dataNowSubgraph,
      dataNow,
      dataPriorSubgraph,
      dataPrior,
      { output: protocolFee },
      { output: inflationRate },
      { output: multiplier },
    ] = await Promise.all([
      request(url, query.replace('<PLACEHOLDER>', block)),
      sdk.api.abi.call({
        target: viewHelper[chainString],
        abi: viewHelperABI.find((n) => n.name === 'getPools'),
        params: [booster[chainString]],
        chain: chainString,
        block,
      }),
      request(url, queryPrior.replace('<PLACEHOLDER>', blockPrior)),
      sdk.api.abi.call({
        target: viewHelper[chainString],
        abi: viewHelperABI.find((n) => n.name === 'getPools'),
        params: [booster[chainString]],
        chain: chainString,
        block: blockPrior,
      }),
      sdk.api.abi.call({
        target: hub,
        abi: hubABI.find((n) => n.name === 'protocolFee'),
        chain: chainString,
      }),

      admin[chainString] &&
        sdk.api.abi.call({
          target: admin[chainString],
          abi: adminABI.find((n) => n.name === 'rate'),
          chain: chainString,
        }),
      oracle[chainString] &&
        sdk.api.abi.call({
          target: oracle[chainString],
          abi: oracleABI.find((n) => n.name === 'multiplier'),
          chain: chainString,
        }),
    ]);

    dataNow = dataNow.output.map((b) => ({
      ...b,
      ...dataNowSubgraph.bunniTokens.find((t) => t.address.toLowerCase() === b.lptoken.toLowerCase()),
    }));
    dataPrior = dataPrior.output.map((b) => ({
      ...b,
      ...dataPriorSubgraph.pools.find((p) => p.address.toLowerCase() === b.uniV3Pool.toLowerCase()),
    }));

    dataNow = dataNow.filter((b) => !b.shutdown).filter((b) => b.token != liqLIT[chainString]);
    dataPrior = dataPrior.filter((b) => !b.shutdown).filter((b) => b.token != liqLIT[chainString]);

    protocolFee = protocolFee / 1e18;
    inflationRate = inflationRate ? inflationRate / 1e18 : null;
    multiplier = multiplier ? multiplier / 10000 : null;

    // create a list of unique tokens
    let tokens = dataNow.reduce((tokens, b) => {
      if (!tokens.includes(b.poolTokens[0])) tokens.push(b.poolTokens[0]);
      if (!tokens.includes(b.poolTokens[1])) tokens.push(b.poolTokens[1]);
      return tokens;
    }, []);

    // add LIT to the token list (used for calculating oLIT price)
    if (lit[chainString] && !tokens.includes(lit[chainString]))
      tokens.push(lit[chainString]);

    // create of list of gauges
    const gauges = dataNow.reduce((gauges, b) => {
      if (b.gauge) gauges.push(b.gauge);
      return gauges;
    }, []);

    const week = 604800 * 1000;
    const this_period_timestamp = (Math.floor(Date.now() / week) * week) / 1000;

    const [
      { output: tokenSymbols },
      { output: tokenDecimals },
      { output: poolTotalSupply },
      { output: reserves },
      { output: shares },
      { output: gaugesWorkingSupply },
      { output: gaugesTokenlessProduction },
      { output: gaugesIsKilled },
      { output: gaugesRelativeWeight },
      { output: gaugesExists },
    ] = await Promise.all([
      sdk.api.abi.multiCall({
        abi: 'erc20:symbol',
        calls: tokens.map((token) => ({ target: token })),
        chain: chainString,
      }),
      sdk.api.abi.multiCall({
        abi: 'erc20:decimals',
        calls: tokens.map((token) => ({ target: token })),
        chain: chainString,
      }),
      sdk.api.abi.multiCall({
        abi: 'erc20:totalSupply',
        calls: dataNow.map((token) => ({ target: token.lptoken })),
        chain: chainString,
      }),
      sdk.api.abi.multiCall({
        abi: lensABI.find((n) => n.name === 'getReserves'),
        target: lens,
        calls: dataNow.map((b) => ({
          params: [
            { pool: b.uniV3Pool, tickLower: b.ticks[0], tickUpper: b.ticks[1] },
          ],
        })),
        chain: chainString,
      }),
      sdk.api.abi.multiCall({
        abi: lensABI.find((n) => n.name === 'pricePerFullShare'),
        target: lens,
        calls: dataNow.map((b) => ({
          params: [
            { pool: b.uniV3Pool, tickLower: b.ticks[0], tickUpper: b.ticks[1] },
          ],
        })),
        chain: chainString,
      }),
      gauges.length &&
        sdk.api.abi.multiCall({
          abi: gaugeABI.find((n) => n.name === 'working_supply'),
          calls: gauges.map((gauge) => ({ target: gauge })),
          chain: chainString,
        }),
      gauges.length &&
        sdk.api.abi.multiCall({
          abi: gaugeABI.find((n) => n.name === 'tokenless_production'),
          calls: gauges.map((gauge) => ({ target: gauge })),
          chain: chainString,
        }),
      gauges.length &&
        sdk.api.abi.multiCall({
          abi: gaugeABI.find((n) => n.name === 'is_killed'),
          calls: gauges.map((gauge) => ({ target: gauge })),
          chain: chainString,
        }),
      gauges.length &&
        sdk.api.abi.multiCall({
          abi: gaugeABI.find((n) => n.name === 'getCappedRelativeWeight'),
          calls: gauges.map((gauge) => ({
            target: gauge,
            params: [this_period_timestamp],
          })),
          chain: chainString,
        }),
      gauges.length &&
        sdk.api.abi.multiCall({
          abi: controllerABI.find((n) => n.name === 'gauge_exists'),
          target: controller[chainString],
          calls: gauges.map((gauge) => ({ params: [gauge] })),
          chain: chainString,
        }),
    ]);

    // fetch token prices
    const keys = tokens.map((token) => `${chainString}:${token}`).join(',');
    const prices = (
      await superagent.get(`https://coins.llama.fi/prices/current/${keys}`)
    ).body.coins;

    // calculate the price of oLIT
    let optionPrice = 0;
    if (lit[chainString]) {
      const litPrice = prices[`${chainString}:${lit[chainString]}`]
        ? prices[`${chainString}:${lit[chainString]}`].price
        : 0;
      optionPrice = litPrice * multiplier;
    }

    let poolData = dataNow.map((b) => {
      // reserve info
      const reserve = reserves.find(
        (r) =>
          r.input.params[0].pool == b.uniV3Pool &&
          r.input.params[0].tickLower == b.ticks[0] &&
          r.input.params[0].tickUpper == b.ticks[1]
      ).output;

      // share info
      const share = shares.find(
        (s) =>
          s.input.params[0].pool == b.uniV3Pool &&
          s.input.params[0].tickLower == b.ticks[0] &&
          s.input.params[0].tickUpper == b.ticks[1]
      ).output;

      // token0 info
      const token0Decimals = tokenDecimals.find(
        (d) => d.input.target == b.poolTokens[0]
      ).output;
      const token0Price = prices[`${chainString}:${b.poolTokens[0]}`]
        ? prices[`${chainString}:${b.poolTokens[0]}`].price
        : 0;
      const token0Redeem = share.amount0 / Math.pow(10, token0Decimals);
      const token0Reserve = reserve.reserve0 / Math.pow(10, token0Decimals);
      const token0Symbol = tokenSymbols.find(
        (s) => s.input.target == b.poolTokens[0]
      ).output;

      // token1 info
      const token1Decimals = tokenDecimals.find(
        (d) => d.input.target == b.poolTokens[1]
      ).output;
      const token1Price = prices[`${chainString}:${b.poolTokens[1]}`]
        ? prices[`${chainString}:${b.poolTokens[1]}`].price
        : 0;
      const token1Redeem = share.amount1 / Math.pow(10, token1Decimals);
      const token1Reserve = reserve.reserve1 / Math.pow(10, token1Decimals);
      const token1Symbol = tokenSymbols.find(
        (s) => s.input.target == b.poolTokens[1]
      ).output;


      // calculate swap fee apr
      let baseApr = 0;

      const tickLower = parseInt(b.ticks[0]);
      const tickUpper = parseInt(b.ticks[1]);
      const tick = parseInt(b.pool.tick);
      const totalSupply = poolTotalSupply.find(
        (t) => t.input.target == b.lptoken
      ).output;
      let tvl = totalSupply == 0 ? 0 : (token0Reserve * token0Price + token1Reserve * token1Price) * (b.totalSupply / totalSupply);

      if (
        parseInt(b.pool.liquidity) > 0
        && tickLower <= tick
        && tick <= tickUpper
      ) {
        const prior = dataPrior.find((d) => d.address.toLowerCase() === b.uniV3Pool.toLowerCase());

        if (prior) {
          const fee0 =
            ((b.pool.totalFeesToken0 - prior.totalFeesToken0) /
              Math.pow(10, token0Decimals)) *
            token0Price;
          const fee1 =
            ((b.pool.totalFeesToken1 - prior.totalFeesToken1) /
              Math.pow(10, token1Decimals)) *
            token1Price;
          const fee = Math.min(fee0, fee1) * 365;

          baseApr =
            ((fee * parseInt(b.liquidity)) / parseInt(b.pool.liquidity) / (token0Reserve * token0Price + token1Reserve * token1Price)) *
            (1 - protocolFee) *
            100;
        }
      }

      // calculate reward apr
      let rewardApr = null;
      let rewardTokens = null;

      if (b.gauge) {
        const exists = gaugesExists.find(
          (g) => g.input.params[0].toLowerCase() == b.gauge.toLowerCase()
        )?.output;
        const killed = gaugesIsKilled.find(
          (g) => g.input.target.toLowerCase() == b.gauge.toLowerCase()
        )?.output;

        // we only care about gauges that have been whitelisted and have not been killed
        if (exists && !killed) {
          const relativeWeight =
            gaugesRelativeWeight.find((g) => g.input.target.toLowerCase() == b.gauge.toLowerCase())
              .output / 1e18;
          const tokenlessProduction = gaugesTokenlessProduction.find(
            (g) => g.input.target.toLowerCase() == b.gauge.toLowerCase()
          )?.output;
          const workingSupply =
            gaugesWorkingSupply.find((g) => g.input.target.toLowerCase() == b.gauge.toLowerCase())
              ?.output / 1e18;
          const relativeInflation = inflationRate * relativeWeight;

          // we only care about gauges that receive rewards (ie those that receive votes)
          if (relativeInflation > 0) {
            /*
            const new_user_liquidity = this.user_liquidity.minus(this.gauge.userbalance);
            const new_user_veLIT = this.user_veLIT.minus(this.veTOKEN.userBalance);

            const L = (this.user_liquidity + new_user_liquidity) * this.user_veLIT / (this.total_veLIT + new_user_veLIT);

            const working_balance = min(tokenlessProduction * this.user_liquidity + (tokenlessProduction * L), this.user_liquidity)
            const wow = working_balance / this.user_liquidity * (1 / tokenlessProduction);
            */


            const bunniPrice =
              token0Redeem * token0Price + token1Redeem * token1Price;
            const annualRewardUSD =
              relativeInflation * optionPrice * 86400 * 365;

            // if nothing has been staked, calculate what rewardApr would be if 1 wei was staked
            const workingSupplyUSD =
              (workingSupply > 0 ? workingSupply : 1e-18) * bunniPrice;

            if (workingSupplyUSD > 0) {
              rewardApr =
                (annualRewardUSD * tokenlessProduction) / workingSupplyUSD;
              rewardTokens = [olit[chainString]];
            }
          }
        }
      }

      return {
        pool: b.token,
        chain: utils.formatChain(chainString),
        project: 'liquis',
        symbol: `${token0Symbol}-${token1Symbol}`,
        tvlUsd: tvl,
        apyBase: apy(baseApr, 365),
        ...(rewardApr && { apyReward: rewardApr }),
        ...(rewardTokens && { rewardTokens: rewardTokens }),
        underlyingTokens: [b.poolTokens[0], b.poolTokens[1]],
        poolMeta: `${parseInt(b.pool.fee) / 10000}%, tickLower: ${
          b.ticks[0]
        }, tickUpper: ${b.ticks[1]}`,
        url: `https://www.liquis.app/stake/${b.crvRewards}`,
      };
    });

    return poolData;
  } catch (e) {
    console.log(e);
    return [];
  }
};

const main = async (timestamp = null) => {
  const data = [];
  for (const [chain, url] of Object.entries(chains)) {
    data.push(await topLvl(chain, url, timestamp));
  }
  return data.flat().filter((p) => utils.keepFinite(p));
};

module.exports = {
  timetravel: false,
  apy: main,
  url: `https://www.liquis.app/stake`,
};
