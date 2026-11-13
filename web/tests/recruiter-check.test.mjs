import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseMarket, readQuote, verifyAnswer } from '../tools/recruiter-check.mjs';

const row = (ticker, yes = '48.50¢', no = '52¢') => ({ ticker, yes, no });

test('picks a different contract with two valid sides and a noncrossed quote', () => {
  const candidates = [
    row('CURRENT'),
    row('ONE-SIDED', '—', '52¢'),
    row('CROSSED', '40¢', '45¢'),
    row('INVALID"SELECTOR'),
    row('NEXT'),
    row('ALTERNATE')
  ];
  assert.equal(chooseMarket(candidates, 'CURRENT'), 'NEXT');
  assert.equal(chooseMarket(candidates, 'CURRENT', new Set(['NEXT'])), 'ALTERNATE');
  assert.equal(chooseMarket(candidates.slice(0, 4), 'CURRENT'), undefined);
  assert.equal(chooseMarket([candidates[0]], 'CURRENT'), 'CURRENT');
});

test('keeps the selected-contract evidence check strict and reports safe failure reasons', () => {
  const selection = { ticker: 'NEXT', title: 'Selected market' };
  const rule = 'Primary settlement rule: The named player wins the specified match in regulation.';
  assert.doesNotThrow(() => verifyAnswer('Selected market (NEXT)\n'+rule, selection));
  assert.throws(() => verifyAnswer('Unrelated market\n'+rule, selection), /did not identify/);
  assert.throws(() => verifyAnswer('Selected market (NEXT)\nThe research did not load.', selection), /unavailable research/);
  assert.throws(() => verifyAnswer('Selected market (NEXT)\nPlease review the market carefully.', selection), /lacked priced evidence/);
});

function quotePage({ ticker = 'NEXT', yes = '48.50¢', no = '52¢', age = '3s since observation',
  status = 'Live stream', live = true, paused = false, controls = true } = {}) {
  const nodes = {
    '[data-testid="selected-ticker"]': { textContent: ticker },
    '.quote-strip .yes-price': { textContent: yes },
    '.quote-strip .no-price': { textContent: no },
    '.quote-strip .stream-state': controls && {
      textContent: status + age,
      getAttribute: () => String(paused),
      querySelector: selector => selector === 'small' ? { textContent: age } : live ? {} : null
    }
  };
  return { querySelector: selector => nodes[selector] || null };
}

test('observes a fresh selected-contract quote from the live feed or REST fallback', () => {
  const options = { ticker: 'NEXT', maximum: 90 };
  assert.deepEqual(readQuote(options, quotePage()), { age: 3 });
  assert.deepEqual(readQuote(options, quotePage({ status: 'REST snapshot', age: '89s since observation' })), { age: 89 });
});

test('returns bounded diagnostic reasons without contract text', () => {
  const options = { ticker: 'NEXT', maximum: 90 };
  const cases = [
    [{ ticker: 'ANOTHER-CONTRACT' }, 'selected contract changed'],
    [{ controls: false }, 'quote controls absent'],
    [{ status: 'Closed' }, 'contract closed'],
    [{ paused: true }, 'quote paused'],
    [{ age: 'Waiting for quote' }, 'no current observation'],
    [{ age: '90s since observation' }, 'observation exceeded freshness limit'],
    [{ yes: '—' }, 'no executable YES ask'],
    [{ no: '—' }, 'no executable NO ask'],
    [{ no: '41¢' }, 'quote crossed'],
    [{ live: false }, 'quote marked delayed']
  ];
  for (const [state, reason] of cases) {
    assert.equal(readQuote(options, quotePage(state)), false, reason);
    assert.equal(readQuote({ ...options, diagnose: true }, quotePage(state)), reason);
  }
});
