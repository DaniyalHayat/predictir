import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createMarketServer} from '../cloud/server.mjs';
import {assistantResponse} from '../lib/workspace/assistant.mjs';
import {boundPacket,localResearchReadback} from '../lib/workspace/mcp.mjs';
import {assistantContext,assistantPayload} from '../lib/workspace/assistant-context.mjs';

test('automatic full analysis compares current model, reporting and exchange inputs across categories',async t=>{
  const saved={MARKET_BACKEND_URL:process.env.MARKET_BACKEND_URL,ASSISTANT_SERVICE_SECRET:process.env.ASSISTANT_SERVICE_SECRET};
  process.env.MARKET_BACKEND_URL='http://127.0.0.1:9876';
  process.env.ASSISTANT_SERVICE_SECRET='fixture-assistant-secret-'.repeat(3);
  t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const as_of=new Date().toISOString();
  for(const ticker of ['KXNBAGAME-26NOV08LALDEN-LAL','KXEPLGAME-26NOV07LEETOT-TOT','KXTSAW-26NOV08-A2.35','KXHIGHNY-26NOV07-B67.5','KXBTC15M-26NOV072230-30']){
    const calls=[],source='https://www.example.com/'+ticker,launch=assistantContext('analysis',ticker,{detail:'full'});
    const body=assistantPayload(ticker,'validated',[{role:'user',content:launch.question}],launch);
    const request=new Request('https://predictir.dev/api/assistant',{method:'POST',
      headers:{Origin:'https://predictir.dev','Content-Type':'application/json'},body:JSON.stringify(body)});
    const response=await assistantResponse(request,{
      createClient:async()=>({close:async()=>{},callTool:async({name,arguments:args})=>{
        calls.push(name);assert.equal(args.ticker,ticker);
        const value=name==='get_contract'?{ticker,book:{as_of},quotes:{yes_ask_usd:.42,no_ask_usd:.60}}:
          {ticker,title:'Selected outcome '+ticker,as_of,opinion:{side:'PASS',reason:'Release validation remains incomplete.'},
            forecast:{probability:.6,interval:[.5,.7],source_as_of:as_of,model_name:'Research model'},
            evidence:[{title:'Dated source '+ticker,url:source,excerpt:'Fresh public observation',published_at:as_of,why_relevant:'Matches this settlement window.'}]};
        return {content:[{type:'text',text:JSON.stringify(value)}]};
      }}),
      generate:()=>{throw new Error('The automatic report uses verified tool output');},
      fetcher:()=>{throw new Error('The automatic report does not require a paid text call');},
    });
    const answer=await response.text();
    assert.equal(response.status,200);
    assert.match(answer,/current YES midpoint is 41.0%/);
    assert.match(answer,/independent model estimates 60.0% YES, 19.0 percentage points above/);
    assert.ok(answer.includes('Dated source '+ticker));
    assert.match(answer,/Matches this settlement window/);
    assert.deepEqual(calls,['get_research','get_contract']);
  }
});

import {azureResearchAnswer,azureResearchPacket,azureToolArguments} from '../lib/workspace/azure-research.mjs';

test('canonical Ask Why batches authenticated contract reads and preserves a real quota response',async t=>{
  const ticker='KXTEST-ALPHA',edge='fixture-market-edge-'.repeat(3),secret='fixture-assistant-secret-'.repeat(3);
  const calls=[],quota=[];
  let allowed=true;
  const server=createMarketServer({production:true,shareAccess:false,edgeSecret:edge,serviceSecret:secret,logger:()=>{},
    storageEnabled:()=>true,storage:()=>({consume:async (...args)=>{quota.push(args);return allowed;}}),
    mcp:()=>assert.fail('Ask Why should not open a remote MCP connection'),
    researchReadback:async scope=>{
      assert.equal(scope.ticker,ticker);
      assert.equal(scope.panel,'analysis');
      assert.equal(scope.detail,'full');
      const as_of=new Date().toISOString();
      return [
        ['get_contract',{ticker,book:{as_of},quotes:{yes_ask_usd:.42,no_ask_usd:.60}}],
        ['get_research',{ticker,title:'Fixture outcome',as_of,forecast:{probability:.6,interval:[.5,.7],source_as_of:as_of}}],
      ].map(([name,packet])=>({name,duration_ms:10,result:{content:[{type:'text',text:JSON.stringify(packet)}]}}));
    }});
  server.on('request',request=>calls.push(request.url));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const backend='http://127.0.0.1:'+server.address().port;
  const env={VERCEL:'1',MARKET_BACKEND_URL:backend,MARKET_EDGE_SECRET:edge,ASSISTANT_SERVICE_SECRET:secret};
  const launch=assistantContext('analysis',ticker,{detail:'full'});
  const payload=assistantPayload(ticker,'validated',[{role:'user',content:launch.question}],launch);
  const request=()=>new Request('https://predictir.dev/api/assistant',{method:'POST',body:JSON.stringify(payload),
    headers:{Origin:'https://predictir.dev','Content-Type':'application/json','X-Vercel-IP-Country':'US','X-Vercel-Forwarded-For':'192.0.2.12'}});
  const response=await assistantResponse(request(),{env,generate:()=>assert.fail('This answer should not use the paid model')});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('X-Research-Transport'),'MCP In-Process');
  assert.match(response.headers.get('Server-Timing'),/get_contract;dur=10/);
  assert.match(await response.text(),/independent model estimates 60.0% YES/);
  assert.deepEqual(calls,['/internal/assistant/read']);
  assert.deepEqual(quota.map(args=>args.slice(1)),[[6000,8]]);
  allowed=false;
  const throttled=await assistantResponse(request(),{env});
  assert.equal(throttled.status,429);
  assert.match(throttled.headers.get('Retry-After'),/^[1-9]\d*$/);
  assert.equal(calls.length,2);
  const wrongEdge=await assistantResponse(request(),{env:{...env,MARKET_EDGE_SECRET:'wrong-'.repeat(8)}});
  assert.equal(wrongEdge.status,403);
});

test('automatic analysis includes current reporting and compares model and exchange figures across categories',async()=>{
  const now=Date.now(),as_of=new Date(now).toISOString();
  for(const ticker of ['KXNBAGAME-26NOV08LALDEN-LAL','KXEPLGAME-26NOV07LEETOT-TOT','KXTSAW-26NOV08-A2.35','KXHIGHNY-26NOV07-B67.5','KXBTC15M-26NOV072230-30']){
    assert.deepEqual(azureToolArguments('get_research',ticker,'Explain the research view','analysis'),{ticker,include_reporting:true});
    const packets=new Map([
      ['get_contract',{ticker,market:{ticker},book:{as_of},quotes:{yes_ask_usd:.42,no_ask_usd:.60}}],
      ['get_research',{ticker,title:'Selected outcome',as_of,forecast:{probability:.6,interval:[.5,.7],source_as_of:as_of},
        opinion:{side:'PASS',reason:'The estimated range has not cleared the release check.'},evidence:[{
          title:'Dated source for '+ticker,url:'https://www.example.com/'+ticker,excerpt:'Current source observation '+ticker,
          published_at:as_of,match_scope:'matched',why_relevant:'Matches the selected observation window.'}]}],
    ]);
    const {answer}=await azureResearchAnswer({question:'Explain the research view',ticker,panel:'analysis',detail:'full',
      tools:['get_contract','get_research'],packets,explain:{math:()=>''},now});
    assert.match(answer,/observed YES midpoint is 41.0%/);
    assert.match(answer,/independent model estimates 60.0% YES, 19.0 percentage points above/);
    assert.ok(answer.includes('Dated source for '+ticker));
    assert.ok(answer.includes('Current source observation '+ticker));
    assert.match(answer,/Matches the selected observation window/);
    assert.match(answer,/Research screen: PASS/);
  }
});

test('fresh quotes never present an expired source estimate as a current model comparison',async()=>{
  const now=Date.now(),as_of=new Date(now).toISOString(),ticker='KXBTC15M-26NOV072230-30';
  const packets=new Map([
    ['get_contract',{ticker,market:{ticker},book:{as_of},quotes:{yes_ask_usd:.42,no_ask_usd:.60}}],
    ['get_research',{ticker,as_of,forecast:{probability:.6,interval:[.5,.7],max_source_age_seconds:125,
      source_as_of:new Date(now-86400000).toISOString()},opinion:{side:'PASS',reason:'Source expired'}}],
  ]);
  const {answer}=await azureResearchAnswer({question:'Explain the probability range',ticker,panel:'analysis',detail:'full',
    tools:['get_contract','get_research'],packets,explain:{math:()=>''},now});
  assert.match(answer,/observed YES midpoint is 41.0%/);
  assert.match(answer,/outside the model’s freshness window/);
  assert.doesNotMatch(answer,/independent model estimates 60.0%/);
});

test('automatic Ask Why returns the selected settlement rule when depth and live reporting exceed their deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const ticker='KXTEST-ALPHA',now=Date.now(),as_of=new Date(now).toISOString();
  const rule='The named player wins the specified match in regulation.';
  const market={ticker,title:'Selected outcome',rules_primary:rule};
  const marketRead=Promise.withResolvers(),reportingRead=Promise.withResolvers();
  const pending=new Promise(()=>{});
  const panel='analysis',detail='full',question=assistantContext(panel,ticker,{detail}).question;
  const batch=localResearchReadback({ticker,panel,detail,question,signal:new AbortController().signal,dependencies:{
    marketDetails:async()=>({market,as_of,source_url:'https://example.com/contract'}),
    book:()=>{marketRead.resolve();return pending;},
    workspaceResearch:async()=>({ticker,market,as_of,rules:{primary:rule},forecast:{probability:.6,source_as_of:as_of}}),
    contractEvidence:()=>{reportingRead.resolve();return pending;},
    searchRetainedEvidence:async()=>({ticker,status:'empty',citations:[]}),
  }});
  await Promise.all([marketRead.promise,reportingRead.promise]);
  t.mock.timers.tick(12001);
  const results=await batch;
  const packets=new Map(results.map(({name,result})=>[name,azureResearchPacket(name,result,ticker)]));
  assert.equal(packets.get('get_contract').book.status,'unavailable');
  assert.equal(packets.get('get_research').reporting_status,'unavailable');
  assert.equal(packets.get('get_research').forecast.probability,.6);
  const {answer}=await azureResearchAnswer({question,ticker,panel,detail,packets,tools:[...packets.keys()],explain:{math:()=>''},now});
  assert.ok(answer.includes('Selected outcome ('+ticker+')'));
  assert.ok(answer.includes('Primary settlement rule: '+rule));
  assert.match(answer,/The live reporting check did not finish/);
  assert.doesNotMatch(answer,/current source and retained-evidence checks returned no matched report/);
});

test('large diagnostics preserve current probability and dated reporting inside MCP bounds',()=>{
  const ticker='KXTEST-ALPHA',as_of=new Date().toISOString();
  const value=boundPacket({ticker,title:'Selected contract',as_of,summary:'Research result',
    forecast:{probability:.61,interval:[.5,.72],source_as_of:as_of,model_name:'Research model',inputs:{diagnostics:'x'.repeat(40000)}},
    rules:{primary:'The named outcome must occur before the cutoff.'},reporting_status:'unavailable',
    evidence:[{title:'Matched source',url:'https://example.com/source',published_at:as_of,excerpt:'Observed fact'}],
    sources:[{label:'Matched source',url:'https://example.com/source'}]});
  assert.ok(Buffer.byteLength(JSON.stringify(value))<=14000);
  assert.equal(value.forecast.probability,.61);
  assert.equal(value.rules.primary,'The named outcome must occur before the cutoff.');
  assert.equal(value.reporting_status,'unavailable');
  assert.equal(value.evidence[0].title,'Matched source');
  assert.equal(value.forecast.inputs,undefined);
});
