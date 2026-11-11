import assert from 'node:assert/strict';
import { appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const TIMEOUT = 30000;
const QUOTE_MAX_SECONDS = 90;
const VIEWPORT = { width: 1600, height: 1000 };
const MEASURES = {
  entry_ms: 'Navigation to private gate',
  catalog_ms: 'Navigation to first catalog rows',
  contract_ms: 'Select contract to matching detail',
  quote_ms: 'Select contract to usable quote',
  quote_age_s: 'Quote age reported by the app (seconds)',
  ask_first_ms: 'Ask Why to first answer text',
  ask_complete_ms: 'Ask Why to complete answer',
  paper_tab_ms: 'Open paper-position view',
  paper_entry_ms: 'Record one browser-local paper contract',
  portfolio_ms: 'Open My Trades to ledger read',
  journey_ms: 'Full browser journey'
};

class CheckFailure extends Error {
  constructor(stage) {
    super(stage);
  }
}

async function check(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure(stage);
  }
}

function configuration() {
  const publicUrl = new URL(process.env.PREDICTIR_CANARY_PUBLIC_URL || 'https://predictir.dev');
  assert.equal(publicUrl.href, publicUrl.origin + '/');
  assert.equal(publicUrl.protocol, 'https:');
  const privateUrl = process.env.PREDICTIR_CANARY_URL ? new URL(process.env.PREDICTIR_CANARY_URL) : null;
  if (privateUrl) {
    assert.equal(privateUrl.origin, publicUrl.origin);
    assert.equal(privateUrl.pathname, '/access');
    assert.equal(privateUrl.search, '');
    assert.equal(privateUrl.username + privateUrl.password, '');
    assert.match(privateUrl.hash, /^#[A-Za-z0-9_-]{43,128}$/);
  }
  const pairs = Number(process.env.PREDICTIR_CANARY_PAIRS || 1);
  assert.ok(Number.isInteger(pairs) && pairs >= 1 && pairs <= 3);
  return { publicUrl, privateUrl, pairs, demo: process.env.PREDICTIR_DEMO_DIR, requestForm: process.env.PREDICTIR_CANARY_REQUEST_FORM === '1' };
}

const elapsed = started => Math.round(performance.now() - started);

async function verifyPublicGate(browser, { publicUrl, requestForm }) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    return await check('public entry and private API gate', async () => {
      const started = performance.now();
      const navigation = await page.goto(publicUrl.href, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Predictir', exact: true }).waitFor({ timeout: TIMEOUT });
      assert.equal(page.url(), new URL('/access', publicUrl).href);
      assert.ok(navigation?.ok());
      assert.match(navigation.headers()['x-robots-tag'] || '', /\bnoindex\b/i);
      const entryMs = elapsed(started);
      if (requestForm) {
        await check('visible Request access control', () => page.getByRole('button', { name: 'Request access', exact: true }).waitFor({ timeout: TIMEOUT }));
      }
      const response = await context.request.get(new URL('/api/workspace/markets?category=sports', publicUrl).href, {
        maxRedirects: 0,
        timeout: TIMEOUT
      });
      assert.equal(response.status(), 401);
      assert.match(response.headers()['content-type'] || '', /application\/json/i);
      return { entry_ms: entryMs };
    });
  } finally {
    await context.close();
  }
}

async function openPrivatePage(page, { publicUrl, privateUrl }, isCold) {
  const target = isCold ? privateUrl : publicUrl;
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForURL(publicUrl.href, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  const cookies = await page.context().cookies(publicUrl.href);
  const cookie = cookies.find(item => ['__Host-predictir-canary', '__Host-predictir-share'].includes(item.name));
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.path === '/');
}

async function caption(page, text) {
  await page.evaluate(label => {
    let badge = document.querySelector('#predictir-demo-caption');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'predictir-demo-caption';
      badge.setAttribute('aria-hidden', 'true');
      badge.style.cssText = 'position:fixed;z-index:2147483647;bottom:18px;right:20px;max-width:80vw;background:#111;color:#fff;border:1px solid #666;border-radius:8px;padding:10px 14px;font:600 16px system-ui;pointer-events:none';
      document.body.append(badge);
    }
    badge.textContent = label;
  }, text);
  await page.waitForTimeout(900);
}

async function journey(page, settings, { cold = false, demo = false, priorPosition = null } = {}) {
  const metrics = {};
  const started = performance.now();
  const mark = (key, from = started) => { metrics[key] = elapsed(from); };
  const clip = title => demo ? caption(page, title) : Promise.resolve();
  const errors = [];
  const onError = () => errors.push('browser runtime');
  page.on('pageerror', onError);
  try {
    await check(cold ? 'private link redemption' : 'warm authenticated navigation',
      () => openPrivatePage(page, settings, cold));
    const marketList = page.getByRole('region', { name: 'Market list', exact: true });
    const rows = marketList.locator('[data-market-ticker]');
    const selected = page.getByTestId('selected-ticker');
    await check('market catalog', async () => {
      await rows.first().waitFor({ timeout: TIMEOUT });
      await selected.waitFor({ timeout: TIMEOUT });
      mark('catalog_ms');
    });
    await clip('1 / 4 · Live market catalog');

    const ticker = await check('matching contract details and quote', async () => {
      const initiallySelected = await selected.textContent();
      const other = rows.filter({ has: page.locator('button.market-select:not([aria-current])') });
      const row = (await other.count()) ? other.first() : rows.first();
      const chosen = await row.getAttribute('data-market-ticker');
      assert.match(chosen || '', /^[A-Za-z0-9_.-]{1,140}$/);
      const title = await row.getByRole('heading').innerText();
      const selectedAt = performance.now();
      await row.getByRole('button', { name: /^Open / }).click();
      await page.waitForFunction(expected => document.querySelector('[data-testid="selected-ticker"]')?.textContent === expected, chosen, { timeout: TIMEOUT });
      assert.equal(await page.getByTestId('selected-title').innerText(), title);
      if ((await rows.count()) > 1) assert.notEqual(chosen, initiallySelected);
      mark('contract_ms', selectedAt);
      const age = await page.waitForFunction(maximum => {
        const state = document.querySelector('.quote-strip .stream-state small')?.textContent || '';
        const ask = document.querySelector('.quote-strip .yes-price')?.textContent || '';
        const no = document.querySelector('.quote-strip .no-price')?.textContent || '';
        const seconds = state.match(/^(\d+)s since observation$/)?.[1];
        const age = seconds === undefined ? NaN : Number(seconds);
        return Number.isFinite(age) && age <= maximum && /\d/.test(ask) && /\d/.test(no) ? { age } : false;
      }, QUOTE_MAX_SECONDS, { timeout: TIMEOUT });
      metrics.quote_age_s = (await age.jsonValue()).age;
      await age.dispose();
      mark('quote_ms', selectedAt);
      return chosen;
    });
    await clip('2 / 4 · Selected contract and current bid/ask depth');

    await check('Ask Why answer', async () => {
      const askedAt = performance.now();
      const answerResponse = page.waitForResponse(response => {
        const request = response.request();
        const url = new URL(response.url());
        if (url.origin !== settings.publicUrl.origin || url.pathname !== '/api/assistant' || request.method() !== 'POST') return false;
        try {
          return request.postDataJSON()?.ticker === ticker;
        } catch {
          return false;
        }
      }, { timeout: 65000 });
      const answerVisible = page.locator('.assistant-transcript .answer').first();
      await Promise.all([
        check('Ask Why control', () => page.getByRole('button', { name: 'Ask why about this contract', exact: true }).click()),
        check('Ask Why rendered answer', () => answerVisible.waitFor({ timeout: 65000 }).then(() => mark('ask_first_ms', askedAt))),
        check('Ask Why selected-contract request', async () => {
          const response = await answerResponse;
          if (!response.ok()) throw new CheckFailure(`Ask Why HTTP ${response.status()}`);
          if (!/text\/plain/i.test(response.headers()['content-type'] || '')) throw new CheckFailure('Ask Why stream content type');
        })
      ]);
      await check('Ask Why completed stream', () => page.getByText('Answer ready', { exact: true }).waitFor({ timeout: 65000 }));
      assert.equal(await page.locator('.assistant-identity code').textContent(), ticker);
      assert.ok((await answerVisible.innerText()).trim().length >= 40);
      mark('ask_complete_ms', askedAt);
    });
    await clip('3 / 4 · Ask Why: actual response for the selected contract');
    if (demo) {
      await page.locator('.assistant-transcript .answer').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(2200);
    }
    await page.getByRole('button', { name: 'Close assistant', exact: true }).click();

    await check('paper position view', async () => {
      const openedAt = performance.now();
      await page.getByRole('tab', { name: 'Paper position', exact: true }).click();
      await page.getByRole('heading', { name: 'Paper position', exact: true }).waitFor({ timeout: TIMEOUT });
      mark('paper_tab_ms', openedAt);
    });
    let positionId = priorPosition?.id;
    const positionTicker = priorPosition?.ticker || ticker;
    if (!positionId) {
      positionId = await check('browser-local paper entry', async () => {
        const guest = await page.waitForFunction(() => localStorage.getItem('predictir:active-account:v1')?.startsWith('guest:'),
          undefined, { timeout: TIMEOUT });
        await guest.dispose();
        await page.getByLabel('Paper contracts', { exact: true }).fill('1');
        const enteredAt = performance.now();
        await page.getByRole('button', { name: 'Record paper buy', exact: true }).click();
        await page.getByText(/^Recorded 1 paper contract/).waitFor({ timeout: TIMEOUT });
        const id = await page.evaluate(expected => {
          const ledger = JSON.parse(localStorage.getItem('predictir:paper-journal:v1') || 'null');
          const position = ledger?.positions.find(row => row.ticker === expected && row.remaining_quantity === 1);
          if (!position || !Number.isFinite(position.remaining_basis) || position.remaining_basis <= 0) return null;
          const key = 'predictir.position-reviews.v1';
          const reviews = JSON.parse(localStorage.getItem(key) || '{}');
          localStorage.setItem(key, JSON.stringify({ ...reviews, [position.id]: { paused: true } }));
          return position.id;
        }, ticker);
        assert.match(id || '', /^[\w-]{1,100}$/);
        mark('paper_entry_ms', enteredAt);
        return id;
      });
    }
    await clip('4 / 4 · One simulated contract from current depth, saved in this guest browser');
    await check('My Trades ledger read', async () => {
      const openedAt = performance.now();
      await page.getByRole('button', { name: 'My Trades', exact: true }).click();
      await page.getByRole('heading', { name: 'Portfolio', exact: true }).waitFor({ timeout: TIMEOUT });
      const position = page.locator(`[data-position-id="${positionId}"]`);
      await position.getByText(positionTicker, { exact: true }).waitFor({ timeout: TIMEOUT });
      assert.match(await position.locator('.position-side').innerText(), /\b1 contracts?$/);
      const marked = await position.locator('.position-values > div').filter({ hasText: 'Net exit value' }).locator('strong');
      await marked.waitFor({ timeout: TIMEOUT });
      await page.waitForFunction(id => [...(document.querySelector(`[data-position-id="${id}"]`)?.querySelectorAll('.position-values > div') || [])]
        .some(value => value.querySelector('span')?.textContent === 'Net exit value' && /\d/.test(value.querySelector('strong')?.textContent || '')),
        positionId, { timeout: TIMEOUT });
      metrics.ledger = 'position read';
      mark('portfolio_ms', openedAt);
    });
    await clip('My Trades · Paper position and live bid-side exit mark');
    await check('browser runtime', () => assert.equal(errors.length, 0));
    mark('journey_ms');
    return { metrics, position: { id: positionId, ticker: positionTicker } };
  } finally {
    page.off('pageerror', onError);
  }
}

async function recordDemo(browser, settings) {
  const staging = await browser.newContext({ viewport: VIEWPORT });
  let state;
  try {
    const page = await staging.newPage();
    await check('demo private link redemption', () => openPrivatePage(page, settings, true));
    state = await staging.storageState();
  } finally {
    await staging.close();
  }
  await mkdir(settings.demo, { recursive: true });
  const recording = await browser.newContext({
    viewport: VIEWPORT,
    storageState: state,
    recordVideo: { dir: settings.demo, size: VIEWPORT }
  });
  const page = await recording.newPage();
  const video = page.video();
  let passed = false;
  try {
    await journey(page, settings, { demo: true });
    passed = true;
  } finally {
    await recording.close();
    if (passed) await video.saveAs(join(settings.demo, 'Predictir_Hosted_Desktop_Demo.webm'));
    await video.delete();
  }
}

function sampleCell(values, percentile, minimum) {
  if (values.length < minimum) return 'insufficient';
  return values[Math.ceil(percentile * values.length) - 1];
}

async function report(results, authenticated, stages) {
  const lines = [
    '# Predictir recruiter check',
    '',
    `Authenticated coverage: ${authenticated ? 'enabled' : 'skipped (no configured link)'}`,
    'Cold means a new browser context and link redemption. Warm reuses the same browser session and cookies. Azure scale-to-zero is not inferred from browser state.',
    'Quote age is read from the UI and the check requires two displayed asks with age ≤90 seconds.',
    'Tail percentiles use nearest rank and require at least 20 p95 samples or 100 p99 samples. Samples below those counts are shown as insufficient.',
    '',
    '| Mode | Measure | n | Min | Max | p95 | p99 |',
    '|---|---|---:|---:|---:|---:|---:|'
  ];
  for (const [mode, rows] of Object.entries(results)) {
    if (!rows.length) continue;
    for (const [metric, name] of Object.entries(MEASURES)) {
      const values = rows.map(row => row[metric]).filter(Number.isFinite).sort((a, b) => a - b);
      if (values.length) lines.push(`| ${mode} | ${name}${metric.endsWith('_ms') ? ' (ms)' : ''} | ${values.length} | ${values[0]} | ${values.at(-1)} | ${sampleCell(values, .95, 20)} | ${sampleCell(values, .99, 100)} |`);
    }
  }
  for (const mode of ['cold', 'warm']) {
    const count = results[mode].filter(row => row.ledger === 'position read').length;
    if (count) lines.push('', `${mode} paper position reads with a current exit mark: ${count}`);
  }
  if (stages.length) lines.push('', ...stages.map(stage => `Failed check: ${stage}`));
  const summary = lines.join('\n') + '\n';
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

async function main() {
  const settings = await check('canary configuration', configuration);
  const playwright = await check('browser dependencies', () => process.env.PREDICTIR_PLAYWRIGHT_DIR
    ? createRequire(join(process.env.PREDICTIR_PLAYWRIGHT_DIR, 'package.json'))('playwright')
    : import('playwright'));
  const browser = await check('Chromium launch', () => playwright.chromium.launch());
  const results = { public: [], cold: [], warm: [] };
  const stages = [];
  const capture = async (mode, run) => {
    try {
      const result = await run();
      results[mode].push(result.metrics || result);
      return result;
    } catch (error) {
      stages.push(`${mode} · ${error instanceof CheckFailure ? error.message : 'unexpected browser failure'}`);
      return null;
    }
  };
  try {
    if (settings.demo) {
      if (!settings.privateUrl) throw new CheckFailure('demo requires an authenticated link');
      await check('record hosted demo', () => recordDemo(browser, settings));
      console.log('Recorded hosted desktop demo.');
      return;
    }
    await capture('public', () => verifyPublicGate(browser, settings));
    if (settings.privateUrl) {
      for (let i = 0; i < settings.pairs; i++) {
        const context = await browser.newContext({ viewport: VIEWPORT });
        try {
          const page = await context.newPage();
          const cold = await capture('cold', () => journey(page, settings, { cold: true }));
          if (cold) {
            await capture('warm', () => journey(page, settings, { priorPosition: cold.position }));
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  await report(results, Boolean(settings.privateUrl), stages);
  if (stages.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Predictir recruiter check failed: ${error instanceof CheckFailure ? error.message : 'unexpected failure'}.`);
  process.exitCode = 1;
});
