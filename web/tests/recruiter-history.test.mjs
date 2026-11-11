import assert from 'node:assert/strict';
import test from 'node:test';
import {currentBrowserRecord, expectedHost, historyRecords, historySummary} from '../tools/recruiter-history.mjs';

const now = Date.parse('2026-11-11T16:00:00Z');
const day = 24 * 60 * 60 * 1000;
const host = 'canonical';

function record(id, result, outcome = 'success', attempt = 1, observed = now) {
  return currentBrowserRecord({id, attempt, host, outcome, now: observed,
    result: {schema: 1, host, authenticated: true, failed_count: 0, ...result}});
}

test('history strips arbitrary strings, keeps only known metrics and caps per-run samples', () => {
  const sensitive = 'must-not-appear';
  const current = record(1, {results: {public: [{entry_ms: 100}], cold: Array(7).fill({
    catalog_ms: 0, quote_age_s: -1, ask_first_ms: 800_000, ask_complete_ms: '400', ledger: sensitive,
    assistant_transport: sensitive, unknown_ms: 10,
  }), warm: [{catalog_ms: 10}, {catalog_ms: 5}, {catalog_ms: 5}]}});
  const [sanitized] = historyRecords([{...current, privateLink: sensitive}], current, now);
  assert.equal(sanitized.status, 'passed');
  assert.deepEqual(sanitized.results.cold, [{catalog_ms: 0}, {catalog_ms: 0}, {catalog_ms: 0}]);
  assert.ok(!JSON.stringify(sanitized).includes(sensitive));
  assert.equal(record(2, {host: 'azure', results: current.results}).status, 'missing');
});

test('rolling history excludes stale and future rows and replaces rerun attempts', () => {
  const results = {public: [{entry_ms: 100}], cold: [{catalog_ms: 300}], warm: [{catalog_ms: 100}]};
  const older = record(1, {results}, 'success', 1, now - day);
  const current = record(1, {}, 'failure', 2);
  const stale = record(2, {results}, 'success', 1, now - 30 * day - 1);
  const future = record(3, {results}, 'success', 1, now + 1);
  const boundary = record(4, {results}, 'success', 1, now - 30 * day);
  assert.deepEqual(historyRecords([older, stale, future, boundary], current, now), [current, boundary]);
});

test('p95 and p99 require enough separate cold and warm samples', () => {
  const rows = Array.from({length: 100}, (_, offset) => {
    const n = offset + 1;
    return record(n, {results: {
      public: [{entry_ms: n}],
      cold: [{catalog_ms: n, ...(n <= 19 ? {quote_ms: n} : {})}],
      warm: [{catalog_ms: n * 2, ...(n <= 20 ? {quote_ms: n * 3} : {})}],
    }});
  });
  const summary = historySummary({host, rows, current: rows.at(-1)});
  assert.match(summary, /\| cold \| First market rows \(ms\) \| 100 \| 95 \| 99 \|/);
  assert.match(summary, /\| warm \| First market rows \(ms\) \| 100 \| 190 \| 198 \|/);
  assert.match(summary, /\| cold \| Usable quote \(ms\) \| 19 \| insufficient \| insufficient \|/);
  assert.match(summary, /\| warm \| Usable quote \(ms\) \| 20 \| 57 \| insufficient \|/);
});

test('run metadata accounts for cancelled, public-only, failed and missing results', () => {
  const result = {results: {public: [{entry_ms: 50}], cold: [{catalog_ms: 60}], warm: [{catalog_ms: 20}]}};
  const success = record(1, result);
  const missingLatest = record(2, result);
  const current = record(3, {}, 'failure');
  const publicOnly = record(4, {authenticated: false, results: {public: [{entry_ms: 30}]}});
  const summary = historySummary({host, rows: [success, missingLatest, current, publicOnly], current, incomplete: true, runs: [
    {id: 2, run_attempt: 2, conclusion: 'failure'}, {id: 5, run_attempt: 1, conclusion: 'cancelled'}, {id: 6, run_attempt: 1, conclusion: 'success'},
  ]});
  assert.match(summary, /Authenticated passes: 1 of 2 evaluated runs. Failed checks or setup: 1. Public-only: 1. Cancelled: 1. Missing results: 2./);
  assert.match(summary, /displayed counts are partial/);
  assert.match(summary, /\| cold \| First market rows \(ms\) \| 1 \| insufficient \| insufficient \|/);
  assert.ok(expectedHost({display_title: 'Recruiter browser check (both)'}, 'azure'));
  assert.ok(expectedHost({display_title: 'Recruiter browser check (both)'}, 'canonical'));
  assert.ok(expectedHost({display_title: 'Recruiter browser check (azure)'}, 'azure'));
  assert.ok(!expectedHost({display_title: 'Recruiter browser check (azure)'}, 'canonical'));
  assert.ok(expectedHost({display_title: 'Old schedule title', event: 'schedule'}, 'canonical'));
  assert.ok(!expectedHost({display_title: 'Old schedule title', event: 'schedule'}, 'azure'));
});
