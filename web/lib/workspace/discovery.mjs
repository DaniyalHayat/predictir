import {batchBooks,bookMetrics,normalizeMarket,number,request,validateTicker} from '../live.mjs';
import {inferCategory} from './catalog.mjs';

const DAY_MS=24*60*60*1000;
const SAMPLE_SIZE=20;
const FRESH_MS=20000;
const MAX_BOOK_AGE_MS=30000;
const MIN_TRADED_CONTRACTS=250;
const MIN_DEPTH_CONTRACTS=20;
const MAX_SPREAD_CENTS=8;

export function quoteWithinDiscoveryWindow(closeTime,midpoint,now){
  const remaining=Date.parse(closeTime)-now;
  return remaining>0&&Number.isFinite(midpoint)&&(remaining>=2*DAY_MS||midpoint>=.03&&midpoint<=.97);
}

function currentBook(asOf,now){
  const age=now-Date.parse(asOf);
  return age>=0&&age<=MAX_BOOK_AGE_MS;
}

function batches(rows,size){
  return Array.from({length:Math.ceil(rows.length/size)},(_,index)=>rows.slice(index*size,(index+1)*size));
}

function liquidityScore(volume,bidSize,askSize,spread){
  const activity=1+Math.log1p(Math.max(0,volume));
  const depth=Math.log1p(Math.max(0,Math.min(bidSize,askSize)));
  return activity*depth/(1+Math.max(0,spread??100));
}

async function collectMarkets(getter,now){
  const failures=[];
  const read=async(tasks,required=true)=>{
    const results=await Promise.allSettled(tasks);
    for(const result of results)if(result.status==='rejected')failures.push(result.reason);
    const values=results.filter(result=>result.status==='fulfilled').map(result=>result.value);
    if(required&&!values.length&&tasks.length)throw failures.find(error=>error.upstream_status===429)||failures[0];
    return values;
  };
  const minute=Math.floor(now()/60000)*60;
  const tape=await read([0,2,8].map(hours=>getter('/markets/trades',{
    limit:'1000',is_block_trade:'false',...(hours?{max_ts:String(minute-hours*3600)}:{}),
  })));
  const amounts=new Map(),seenTrades=new Set();
  for(const observation of tape)for(const trade of observation.data.trades){
    const amount=number(trade.count_fp);
    if(!(amount>0)||!trade.trade_id||seenTrades.has(trade.trade_id))continue;
    try{validateTicker(trade.ticker);}catch{continue;}
    seenTrades.add(trade.trade_id);
    const tally=amounts.get(trade.ticker)||{amount:0,trades:0};
    tally.amount+=amount;
    tally.trades++;
    amounts.set(trade.ticker,tally);
  }
  const tapeRank=({amount,trades})=>Math.log1p(amount)*Math.sqrt(trades);
  const tickers=[...amounts].sort((a,b)=>tapeRank(b[1])-tapeRank(a[1])).slice(0,144).map(([ticker])=>ticker);
  const observed=new Map();
  await read(batches(tickers,48).map(async group=>{
    const expected=new Set(group);
    const response=await getter('/markets',{tickers:group.join(','),status:'open',limit:String(group.length)});
    for(const market of response.data.markets){
      if(!expected.has(market.ticker)||!['active','open'].includes(market.status)||!(Date.parse(market.close_time)>now()))continue;
      const series=(market.event_ticker||market.ticker).split('-')[0];
      const category=inferCategory(market);
      const row={...normalizeMarket(market,category,series,response.source_url),status:market.status,category,
        yes_sub_title:market.yes_sub_title||market.subtitle||'',volume_as_of:response.as_of,
        sampled_trade_contracts:amounts.get(market.ticker).amount};
      const volume=Math.max(row.volume_24h,row.sampled_trade_contracts);
      if(volume<MIN_TRADED_CONTRACTS)continue;
      observed.set(row.ticker,{row,score:liquidityScore(volume,number(market.yes_bid_size_fp),number(market.yes_ask_size_fp),row.spread_cents)});
    }
  }));
  const ranked=[...observed.values()].sort((a,b)=>b.score-a.score).map(entry=>entry.row);
  const markets=[];
  let booksChecked=0;
  for(const candidates of [ranked.slice(0,36),ranked.slice(36,60)]){
    const books=await read(batches(candidates,12).map(group=>batchBooks(group.map(row=>row.ticker),getter)),!markets.length);
    const byTicker=new Map(books.flatMap(book=>[...book]));
    for(const row of candidates){
      const book=byTicker.get(row.ticker);
      if(!book)continue;
      booksChecked++;
      if(!currentBook(book.as_of,now()))continue;
      let quote;
      try{quote=bookMetrics(book.raw);}catch{continue;}
      if(quote.book_state!=='two-sided'||!quoteWithinDiscoveryWindow(row.close_time,quote.book_midpoint,now()))continue;
      if(Math.min(quote.bid_depth_2c,quote.ask_depth_2c)<MIN_DEPTH_CONTRACTS||quote.book_spread_cents>MAX_SPREAD_CENTS)continue;
      markets.push({...row,yes_bid:quote.book_bid,yes_ask:quote.book_ask,
        no_ask:Number((1-quote.book_bid).toFixed(12)),midpoint:quote.book_midpoint,spread_cents:quote.book_spread_cents,
        book_state:quote.book_state,yes_bid_size:quote.book_bid_size,yes_ask_size:quote.book_ask_size,
        bid_depth_2c:quote.bid_depth_2c,ask_depth_2c:quote.ask_depth_2c,
        quote_as_of:book.as_of,quote_source_url:book.source_url});
    }
    if(markets.length>=SAMPLE_SIZE+10)break;
  }
  if(!markets.length&&failures.length)throw failures.find(error=>error.upstream_status===429)||failures[0];
  return {category:'discover',markets,as_of:new Date(now()).toISOString(),
    coverage:{trade_snapshots:tape.length,tickers_checked:tickers.length,books_checked:booksChecked},
    partial:failures.length>0,scope:'Sampled from recent trades with at least 250 contracts traded, 20 contracts within 2¢ on both sides, and at most an 8¢ spread.'};
}

function sampleMarkets(markets,random){
  const ranked=markets.map(row=>({row,key:-Math.log(1-random())/
    liquidityScore(Math.max(row.volume_24h,row.sampled_trade_contracts),row.bid_depth_2c,row.ask_depth_2c,row.spread_cents)})).sort((a,b)=>a.key-b.key);
  const events=new Set(),selected=[],remaining=[];
  for(const {row} of ranked){
    const event=row.event_ticker||row.ticker;
    if(events.has(event))remaining.push(row);
    else{events.add(event);selected.push(row);}
  }
  return selected.concat(remaining).slice(0,SAMPLE_SIZE);
}

export function createMarketDiscovery({getter=request,now=Date.now,random=Math.random}={}){
  let snapshot,pending;
  return async function discoverMarkets(){
    if(!snapshot||now()-Date.parse(snapshot.as_of)>=FRESH_MS){
      pending??=collectMarkets(getter,now).then(value=>{snapshot=value;}).finally(()=>{pending=null;});
      await pending;
    }
    const checkedAt=now();
    const markets=sampleMarkets(snapshot.markets.filter(row=>currentBook(row.quote_as_of,checkedAt)&&
      quoteWithinDiscoveryWindow(row.close_time,row.midpoint,checkedAt)),random);
    return {...snapshot,markets};
  };
}

export const discoverMarkets=createMarketDiscovery();
