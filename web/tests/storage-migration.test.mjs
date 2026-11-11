import assert from 'node:assert/strict';
import test from 'node:test';
import {migratePredictirStorage} from '../ui/storage-migration.mjs';
import {ACTIVE_ACCOUNT,GUEST_STORAGE,prepareGuestSession,purgeExpiredGuestData} from '../ui/guest-session.mjs';
import {PAPER_STORAGE} from '../ui/paper-state.mjs';

class MemoryStorage{
  values=new Map();
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(key)??null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}
const legacy='kalshi-market-lab:';
const marker='predictir:storage-migrated:v1';
const oldGuest={id:'guest-1',created_at:'2026-11-07T00:00:00Z',last_active_at:'2026-11-07T01:00:00Z',expires_at:'2026-11-07T06:00:00Z'};
const guestRecords={
  'guest-session:v1':JSON.stringify(oldGuest),
  'active-account:v1':'guest:guest-1',
  'paper-journal:v1':'guest-ledger',
  'paper-starting-balance:v1':'17000',
  'account-cache:v1:guest:guest-1':'cached-guest-ledger',
  'account-cache:v1:watchlist:guest:guest-1':'["KXEXAMPLE-YES"]'
};

test('branding migration preserves exact paper, owner-cache, watchlist and appearance records',()=>{
  const storage=new MemoryStorage();
  const records={
    'paper-journal:v1':JSON.stringify({starting_balance:17234.56,positions:[{id:'position-1',remaining_quantity:4}],trades:[{id:'entry-1'}]}),
    'active-account:v1':'owner:owner@example.org',
    'account-cache:v1:owner:owner@example.org':'private-ledger-snapshot',
    'account-cache:v1:watchlist:guest:guest-1':'["KXEXAMPLE-YES"]',
    'appearance:v1':'{"theme":"midnight","density":"compact"}',
    'analytics-consent:v1':'denied'
  };
  for(const [key,value]of Object.entries(records))storage.setItem(legacy+key,value);
  storage.setItem('unrelated-service:token','untouched');
  assert.equal(migratePredictirStorage(storage),true);
  for(const [key,value]of Object.entries(records)){
    assert.equal(storage.getItem('predictir:'+key),value);
    assert.equal(storage.getItem(legacy+key),value);
  }
  assert.equal(storage.getItem(marker),'complete');
  assert.equal(storage.getItem('unrelated-service:token'),'untouched');
});

test('newer Predictir records win while a previous analytics denial remains effective',()=>{
  const storage=new MemoryStorage();
  storage.setItem(legacy+'paper-journal:v1','older');
  storage.setItem(PAPER_STORAGE,'newer');
  storage.setItem(legacy+'analytics-consent:v1','denied');
  storage.setItem('predictir:analytics-consent:v1','allowed');
  migratePredictirStorage(storage);
  assert.equal(storage.getItem(PAPER_STORAGE),'newer');
  assert.equal(storage.getItem('predictir:analytics-consent:v1'),'denied');
});

test('an interrupted migration rolls back only copied records and leaves legacy data available',()=>{
  const storage=new MemoryStorage();
  storage.setItem(legacy+'paper-journal:v1','retained-ledger');
  storage.setItem(legacy+'appearance:v1','retained-theme');
  const set=storage.setItem.bind(storage);
  storage.setItem=(key,value)=>{if(key==='predictir:appearance:v1')throw new Error('Quota exceeded');set(key,value);};
  assert.throws(()=>migratePredictirStorage(storage),/Quota exceeded/);
  assert.equal(storage.getItem(marker),null);
  assert.equal(storage.getItem(PAPER_STORAGE),null);
  assert.equal(storage.getItem(legacy+'paper-journal:v1'),'retained-ledger');
  storage.setItem=set;
  assert.equal(migratePredictirStorage(storage),true);
  assert.equal(storage.getItem(PAPER_STORAGE),'retained-ledger');
});

test('completed migration cannot resurrect an expired guest ledger from its retained legacy copy',()=>{
  const storage=new MemoryStorage(),now=Date.parse('2026-11-07T12:00:00Z');
  for(const [key,value] of Object.entries(guestRecords))storage.setItem(legacy+key,value);
  migratePredictirStorage(storage);
  assert.equal(purgeExpiredGuestData(storage,now).removed,true);
  for(const key of Object.keys(guestRecords).filter(key=>key!=='active-account:v1')){
    assert.equal(storage.getItem('predictir:'+key),null,key);
    assert.equal(storage.getItem(legacy+key),null,key);
  }
  assert.equal(migratePredictirStorage(storage),false);
  assert.equal(storage.getItem(PAPER_STORAGE),null);
});

test('clears an expired legacy guest copy after the current browser has moved to a fresh guest',()=>{
  const storage=new MemoryStorage(),now=Date.parse('2026-11-07T06:30:00Z');
  for(const [key,value] of Object.entries(guestRecords))storage.setItem(legacy+key,value);
  migratePredictirStorage(storage);
  storage.setItem(GUEST_STORAGE,JSON.stringify({...oldGuest,id:'guest-2',created_at:'2026-11-07T06:00:00Z',
    last_active_at:'2026-11-07T06:15:00Z',expires_at:'2026-11-07T12:00:00Z'}));
  storage.setItem(ACTIVE_ACCOUNT,'guest:guest-2');
  storage.setItem(PAPER_STORAGE,'current-guest-ledger');
  assert.deepEqual(purgeExpiredGuestData(storage,now),{removed:false,activeReset:false});
  assert.equal(storage.getItem(legacy+'paper-journal:v1'),null);
  assert.equal(storage.getItem(legacy+'account-cache:v1:watchlist:guest:guest-1'),null);
  assert.equal(storage.getItem(PAPER_STORAGE),'current-guest-ledger');
  assert.equal(storage.getItem(ACTIVE_ACCOUNT),'guest:guest-2');
});

test('valid guest aliases are retained until guest rotation and owner records stay available',()=>{
  const storage=new MemoryStorage(),now=Date.parse('2026-11-07T02:00:00Z');
  for(const [key,value] of Object.entries(guestRecords))storage.setItem(legacy+key,value);
  storage.setItem(legacy+'active-account:v1','owner:example');
  storage.setItem(legacy+'paper-journal:v1','owner-ledger');
  storage.setItem(legacy+'account-cache:v1:owner:example','owner-cache');
  storage.setItem(legacy+'account-cache:v1:watchlist:guest:another','another-guest-watchlist');
  assert.deepEqual(purgeExpiredGuestData(storage,now),{removed:false,activeReset:false});
  assert.equal(storage.getItem(legacy+'account-cache:v1:guest:guest-1'),'cached-guest-ledger');
  prepareGuestSession(storage,{...oldGuest,id:'guest-2'},now);
  for(const prefix of [legacy,'predictir:']){
    assert.equal(storage.getItem(prefix+'account-cache:v1:guest:guest-1'),null);
    assert.equal(storage.getItem(prefix+'account-cache:v1:watchlist:guest:guest-1'),null);
    assert.equal(storage.getItem(prefix+'paper-journal:v1'),'owner-ledger');
    assert.equal(storage.getItem(prefix+'account-cache:v1:owner:example'),'owner-cache');
    assert.equal(storage.getItem(prefix+'account-cache:v1:watchlist:guest:another'),'another-guest-watchlist');
  }
});

