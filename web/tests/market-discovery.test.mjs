import assert from 'node:assert/strict';
import test from 'node:test';
import {createMarketDiscovery, quoteWithinDiscoveryWindow} from '../lib/workspace/discovery.mjs';
import {workspaceGET} from '../lib/workspace/router.mjs';

const now = Date.parse('2026-11-17T12:00:00Z');
const as_of = new Date(now).toISOString();
const hour = 60 * 60 * 1000;
const close = hours => new Date(now + hours * hour).toISOString();

test('near-certain YES and NO are suppressed only above 97% and inside 48 hours', () => {
  for (const [midpoint, hours, expected] of [
    [.9701, 47, false], [.0299, 47, false], [.97, 47, true], [.03, 47, true],
    [.99, 48, true], [.01, 48, true], [.99, 49, true], [.40, 1, true], [.40, 0, false],
  ]) assert.equal(quoteWithinDiscoveryWindow(close(hours), midpoint, now), expected, `${midpoint}, ${hours} hours`);
});

test('the workspace exposes a randomized 20-contract sample with exact book prices and shared reads', async () => {
  const metadata = Array.from({length: 38}, (_, i) => ({
    ticker: `KXTEST-EVENT${i}-YES`, event_ticker: `KXTEST-EVENT${i}`, title: `Event ${i}?`,
    yes_sub_title: `Threshold ${i}`, status: 'active', close_time: close(24),
    yes_bid_dollars: '.37', yes_ask_dollars: '.41', yes_bid_size_fp: '100', yes_ask_size_fp: '100',
    volume_24h_fp: '4000', market_type: 'binary',
  }));
  const ticker = i => metadata[i].ticker;
  metadata[0].status = 'paused';
  metadata[1].close_time = close(-1);
  metadata[2].close_time = close(48);
  metadata[5].volume_24h_fp = '30';
  const calls = [];
  let random = 49;
  const getter = async (path, params) => {
    calls.push(path);
    const data = path === '/markets/trades' ? {trades: metadata.map((row, i) => ({ticker: row.ticker, trade_id: `trade-${i}`, count_fp: '100'}))}
      : path === '/markets' ? {markets: metadata.filter(row => params.tickers.split(',').includes(row.ticker)).concat({...metadata[5],ticker:'UNREQUESTED'})}
      : {orderbooks: params.getAll('tickers').map(t => ({ticker:t, orderbook_fp: {
        yes_dollars: t === ticker(4) ? [] : [[t === ticker(2) || t === ticker(3) ? '.9790' : '.4010', '90.50']],
        no_dollars: [[t === ticker(2) || t === ticker(3) ? '.0200' : t === ticker(7) ? '.4800' : '.5900', t === ticker(6) ? '10' : '71.25']],
      }}))};
    return {as_of, data, source_url: `https://external-api.kalshi.com/trade-api/v2${path}`};
  };
  const discoverMarkets = createMarketDiscovery({getter, now: () => now, random: () => (random = (random * 48271) % 2147483647) / 2147483647});
  const params = new URLSearchParams({category: 'discover'});
  const open = () => workspaceGET('workspace/markets', params, {discoverMarkets});
  const [first] = await Promise.all([open(),open()]);
  const firstCallCount = calls.length;
  const second = await open();
  assert.equal(calls.length, firstCallCount);
  assert.equal(calls.includes('/markets/orderbooks'), true);
  assert.equal(first.markets.length, 20);
  assert.equal(second.markets.length, 20);
  assert.notDeepEqual(first.markets.map(row => row.ticker).sort(), second.markets.map(row => row.ticker).sort());
  for (const row of first.markets.concat(second.markets)) {
    assert.ok(metadata.slice(2).some(market => market.ticker === row.ticker && market.yes_sub_title === row.yes_sub_title));
    assert.ok(![ticker(3), ticker(4),ticker(5),ticker(6),ticker(7)].includes(row.ticker));
    assert.equal(row.yes_bid, row.ticker === ticker(2) ? .979 : .401);
    assert.equal(row.yes_ask, row.ticker === ticker(2) ? .98 : .41);
    assert.equal(row.no_ask, row.ticker === ticker(2) ? .021 : .599);
    assert.equal(row.bid_depth_2c, 90.50);
    assert.equal(row.ask_depth_2c, 71.25);
    assert.equal(row.quote_as_of, as_of);
  }
});
