const scale=10000;

function priceUnits(value){
  if(typeof value!=='string'||!/^\d(?:\.\d{1,4})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.');
  const units=Number(whole)*scale+Number(fraction.padEnd(4,'0'));
  return units<=scale?units:null;
}

export function snapInventoryQuotes(ranges,side,bid,ask){
  if(!Array.isArray(ranges)||!ranges.length)return null;
  const bidLimit=(side==='no'?1-ask:bid)*scale;
  const askLimit=(side==='no'?1-bid:ask)*scale;
  let lower=null,upper=null;
  for(const band of ranges){
    const start=priceUnits(band?.start),end=priceUnits(band?.end),step=priceUnits(band?.step);
    if(start===null||end===null||!step||start>=end)return null;
    const floor=start+Math.floor((Math.min(end,bidLimit)-start+1e-8)/step)*step;
    const ceil=start+Math.ceil((Math.max(start,askLimit)-start-1e-8)/step)*step;
    if(floor>=start&&(lower===null||floor>lower))lower=floor;
    if(ceil<=end&&(upper===null||ceil<upper))upper=ceil;
  }
  if(lower===null||upper===null)return null;
  return side==='no'?{bid:(scale-upper)/scale,ask:(scale-lower)/scale}:{bid:lower/scale,ask:upper/scale};
}
