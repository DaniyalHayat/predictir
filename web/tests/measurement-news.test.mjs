import test from 'node:test';
import assert from 'node:assert/strict';
import {measurementEvidenceMatch,rankEvidence} from '../lib/workspace/source-ranking.mjs';
import {newsQuery,filterContractHeadlines} from '../lib/intelligence/brief.mjs';
import {contractEvidence} from '../lib/workspace/evidence.mjs';
import {publicEvidenceChunks,createEvidenceRepository} from '../lib/workspace/semantic.mjs';

const NOW=Date.parse('2026-11-07T20:00:00Z'),as_of=new Date(NOW-60000).toISOString();
const rain={ticker:'KXRAIN-26NOV07-NYC',title:'Will it rain in New York City?',yes_sub_title:'New York City',rules_primary:'Precipitation recorded in Central Park on November 7, 2026.'};
const article=(title,id)=>({title,url:'https://example.org/'+id,publisher:'Fixture publisher',as_of,published_at:as_of});
const irrelevant=[article('Brooklyn Democrats launch Facebook campaign in New York City','politics'),article('New York City police investigate massage-parlor homicide','crime'),article('Rockefeller Center Christmas tree arrives in New York City','tree')];
const relevant=article('NWS forecasts rain and precipitation for Central Park in New York','rain');

test('measurement matching requires the selected subject and quantity across supported news families',()=>{
  const cases=[
    [rain,relevant.title,true],
    [rain,'NYC Democratic committee elects a new chair',false],
    [rain,'Seattle rainfall forecast for this weekend',false],
    [{ticker:'KXHIGHCHI-26NOV08-B65.5'},'Chicago record high temperature and heat forecast',true],
    [{ticker:'KXHIGHCHI-26NOV08-B65.5'},'Chicago rain showers expected Saturday',false],
    [{ticker:'KXLOWNY-26NOV08-T40'},'New York forecast low drops to 35 degrees',true],
    [{ticker:'KXTSAW-26NOV08-A2.35'},'TSA screens 2.4 million passengers at airport checkpoints',true],
    [{ticker:'KXTSAW-26NOV08-A2.35'},'TSA expects record passenger traffic over holiday weekend',true],
    [{ticker:'KXTSAW-26NOV08-A2.35'},'TSA employee arrested after passenger luggage theft',false],
    [{ticker:'KXTSAW-26NOV08-A2.35'},'TSA announces new security screening policy at airport checkpoints',false],
    [{ticker:'KXTSAW-26NOV08-A2.35'},'TSA announces new security screening policy for passengers',false],
    [{ticker:'KXCPI-26NOV-T0.2'},'US CPI inflation release shows consumer prices rose in October',true],
    [{ticker:'KXCPI-26NOV-T0.2'},'India CPI inflation unexpectedly rises',false],
    [{ticker:'KXCPI-26NOV-T0.2'},'Japan CPI inflation release surprises economists',false],
    [{ticker:'KXCPI-26NOV-T0.2'},'Canadian CPI inflation falls in October',false],
    [{ticker:'KXU3-26NOV-T4.2'},'US jobs report shows unemployment rate at 4.2%',true],
    [{ticker:'KXFED-26DEC-T4.00'},'Federal Reserve holds interest rates steady',true],
    [{ticker:'KXFED-26DEC-T4.00'},'Blowout October Jobs Number Complicates Fed December Rate Decision',true],
    [{ticker:'KXFED-26DEC-T4.00'},'FedEx delivery rates change for holiday packages',false],
    [{ticker:'KXBTC15M-26NOV072230-30'},'Bitcoin price rises as BTC ETF inflows accelerate',true],
    [{ticker:'KXBTC15M-26NOV072230-30'},'Ethereum price rises after ETH ETF inflows',false],
    [{ticker:'KXETH-26NOV0722-T2200'},'ETH Zurich researcher wins robotics award',false],
    [{ticker:'KXLLM1-26NOV07'},'LMArena model benchmark rankings change after new release',true],
  ];
  for(const [market,title,expected] of cases)assert.equal(measurementEvidenceMatch(market,title).accepted,expected,title);
  assert.equal(measurementEvidenceMatch({ticker:'KXCPI-26NOV-T0.2'},'CPI inflation release','', 'https://www.bls.gov/news.release/cpi.htm').accepted,true);
});

test('retrieval queries include both location/subject and measurement instead of city-only searches',()=>{
  const query=newsQuery(rain);
  assert.match(query,/New York/);assert.match(query,/rainfall/);assert.ok(query.length<350);
  const tsa=newsQuery({ticker:'KXTSAW-26NOV08-A2.35'});
  assert.match(tsa,/TSA/);assert.match(tsa,/passenger/);assert.match(tsa,/volume/);assert.ok(tsa.length<350);
  assert.match(newsQuery({ticker:'KXBTC15M-26NOV072230-30'}),/Bitcoin/);
  const cpi=newsQuery({ticker:'KXCPI-26NOV-T0.2'});assert.match(cpi,/United States/);assert.ok(cpi.length<350);
});

test('RSS previews, ranked evidence, summary and long read exclude city-only stories',async()=>{
  const news={status:'live',provider:'Fixture RSS',articles:[...irrelevant,relevant],retrieved_at:as_of};
  assert.deepEqual(filterContractHeadlines(news,rain).articles.map(row=>row.url),[relevant.url]);
  assert.deepEqual(rankEvidence(news.articles,rain,{now:NOW}).map(row=>row.url),[relevant.url]);
  const result=await contractEvidence(rain,{enabled:true,selectedTicker:rain.ticker,news},{now:()=>NOW,sportsNews:async()=>({status:'not_applicable',articles:[]})});
  assert.match(result.news_summary,/NWS forecasts rain/);
  assert.match(result.news_long_read,/precipitation/);
  assert.doesNotMatch(JSON.stringify(result),/Facebook|homicide|Christmas tree/);
  assert.equal(result.experimental_sensitivity.probability_adjustment,null);
  const crypto=rankEvidence([article('Bitcoin ETF inflows accelerate as BTC price rises','btc')],{ticker:'KXBTC15M-26NOV072230-30'},{now:NOW});
  assert.equal(crypto[0].match_scope,'related');assert.equal(crypto[0].claim_type,'asset_market_context');
});

test('retention rejects irrelevant measurement records and search revalidates previously stored records',async()=>{
  const evidence={ticker:rain.ticker,as_of,items:[...irrelevant,relevant]};
  const chunks=publicEvidenceChunks(rain,evidence,{now:NOW});
  assert.ok(chunks.some(row=>row.source_url===relevant.url));
  assert.ok(chunks.every(row=>!irrelevant.some(item=>item.url===row.source_url)));
  const rows=[...irrelevant,relevant].map((row,i)=>({id:String(i),ticker:rain.ticker,title:row.title,content:row.title,source_url:row.url,source_kind:'reported',retrieved_at:as_of,expires_at:new Date(NOW+3600000).toISOString()}));
  const db={query:async sql=>({rows:sql.startsWith('SELECT count')?[{n:rows.length,embedded:false}]:rows})};
  const repository=createEvidenceRepository({storage:{kind:'postgres',db},now:()=>NOW,embed:async()=>{throw new Error('Not needed');}});
  const result=await repository.search(rain.ticker,'New York');
  assert.deepEqual(result.citations.map(row=>row.url),[relevant.url]);
});
