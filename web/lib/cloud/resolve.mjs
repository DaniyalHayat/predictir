import {validateTicker,marketDetails,request} from '../live.mjs';
export function parseMarketInput(value) {
  if(typeof value!=='string'||value.length>500)throw new RangeError('Paste a Kalshi market URL or exact ticker');
  let text=value.trim();
  if(/^https?:/i.test(text)) {
    const url=new URL(text);
    if(url.protocol!=='https:'||!['kalshi.com','www.kalshi.com'].includes(url.hostname)||!url.pathname.startsWith('/markets/'))throw new RangeError('Use an official Kalshi market URL');
    text=url.pathname.split('/').filter(Boolean).at(-1);
  }
  return validateTicker(text.toUpperCase());
}
export async function resolveContracts(value) {
  const ticker=parseMarketInput(value);
  let markets=[];
  try{markets=[(await marketDetails(ticker)).market];}
  catch(error){if(error.upstream_status!==404)throw error;
    markets=(await request('/markets',{event_ticker:ticker,limit:'200'})).data.markets||[];}
  return {contracts:markets.map(m=>({ticker:m.ticker,event_ticker:m.event_ticker,title:m.title,
    subtitle:m.yes_sub_title||m.subtitle||m.ticker,status:m.status,close_time:m.close_time})),partial:markets.length>=200};
}
export async function marketFees(ticker,{readMarket=marketDetails,get=request,now=Date.now}={}) {
  const {market}=await readMarket(validateTicker(ticker));
  const eventTicker=validateTicker(market.event_ticker);
  const event=await get('/events/'+eventTicker);
  const details=event.data.event;
  if(details?.event_ticker!==eventTicker)throw new Error('Fee metadata did not match the selected event');
  const series=details.series_ticker;
  if(!series)throw new Error('The exact series for this event is unavailable');
  const result=await get('/series/'+validateTicker(series)),metadata=result.data.series;
  if(metadata?.ticker!==series)throw new Error('Fee metadata did not match the selected series');
  const override=details.fee_type_override!=null||details.fee_multiplier_override!=null;
  const feeType=details.fee_type_override??metadata.fee_type;
  const multiplier=details.fee_multiplier_override??metadata.fee_multiplier;
  const quadratic=['quadratic','quadratic_with_maker_fees'].includes(feeType);
  const waiver=market.fee_waiver_expiration_time;
  const hasUnresolvedWaiver=Boolean(waiver)&&(!Number.isFinite(Date.parse(waiver))||Date.parse(waiver)>now());
  return {series,fee_type:feeType??null,multiplier:Number.isFinite(multiplier)?multiplier:null,
    coefficient:!hasUnresolvedWaiver&&quadratic&&Number.isFinite(multiplier)&&multiplier>=0&&.07*multiplier<=1 ? .07*multiplier : null,
    basis:override?'event_override':'series',as_of:override?event.as_of:result.as_of,source_url:override?event.source_url:result.source_url,
    scope:hasUnresolvedWaiver?'A market fee waiver needs verification before using a quoted coefficient.':'Uses the reported taker-fee rules. Paper fills retain a modeled rounding assumption.'};
}
