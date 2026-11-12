import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 30000;
const QUOTE_MAX_SECONDS = 90;
const MAX_MARKET_ATTEMPTS = 3;
const TICKER_PATTERN = /^[A-Za-z0-9_.-]{1,140}$/;
const PAPER_QUANTITY = 2;
const VIEWPORT = { width: 1600, height: 1000 };
const ASSISTANT_MODES = new Set(['deterministic-contract-brief', 'azure-deterministic', 'azure-foundry']);
const ASSISTANT_TRANSPORTS = new Set(['MCP Streamable HTTP', 'MCP In-Process']);
const DEGRADED_ANSWER = /research did not load|did not return usable depth or outcome data|assistant (?:is temporarily unavailable|returned no explanation)|research connection was interrupted|could not reach its research service/i;
const NONEXECUTABLE_QUOTE = new Set(['contract closed', 'no executable YES ask', 'no executable NO ask', 'quote crossed']);
const MEASURES = {
  entry_ms: 'Navigation to private gate',
  workspace_entry_ms: 'Private link or session to workspace',
  catalog_ms: 'Navigation to first catalog rows',
  contract_ms: 'Select contract to matching detail',
  quote_ms: 'Select contract to usable quote',
  quote_age_s: 'Quote age reported by the app (seconds)',
  ask_first_ms: 'Ask Why to first answer text',
  ask_complete_ms: 'Ask Why to complete answer',
  paper_tab_ms: 'Open paper-position view',
  paper_entry_ms: 'Record browser-local paper contracts',
  paper_book_age_s: 'Executable entry book age (seconds)',
  portfolio_ms: 'Open My Trades to ledger read',
  journey_ms: 'Full browser journey'
};

class CheckFailure extends Error {
  constructor(stage) {
    super(stage);
  }
}

class NonexecutableMarket extends CheckFailure {}

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
  const host = process.env.PREDICTIR_CANARY_HOST || 'canonical';
  assert.ok(['canonical', 'azure'].includes(host));
  const requireDedicatedCanary = process.env.PREDICTIR_REQUIRE_DEDICATED_CANARY === '1';
  if (requireDedicatedCanary) {
    const matched = host === 'azure' ? publicUrl.hostname.endsWith('.azurecontainerapps.io') && !publicUrl.port
      : publicUrl.origin === 'https://predictir.dev';
    if (!matched) throw new CheckFailure('configured host does not match the monitored deployment');
  }
  return { publicUrl, privateUrl, pairs, host, demo: process.env.PREDICTIR_DEMO_DIR, requestForm: process.env.PREDICTIR_CANARY_REQUEST_FORM === '1',
    requireDedicatedCanary };
}

const elapsed = started => Math.round(performance.now() - started);
const normalize = text => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function chooseMarket(rows, initiallySelected, attempted = new Set()) {
  return rows.find(({ ticker, yes, no }) => {
    if (!TICKER_PATTERN.test(ticker || '') || attempted.has(ticker) || rows.length > 1 && ticker === initiallySelected) return false;
    const prices = [yes, no].map(text => Number(text?.match(/^(\d+(?:\.\d+)?)¢$/)?.[1]));
    return prices.every(price => price > 0 && price < 100) && prices[0] + prices[1] >= 99.99;
  })?.ticker;
}

export function readQuote({ ticker, maximum, diagnose = false }, root = document) {
  const fail = reason => diagnose ? reason : false;
  if (root.querySelector('[data-testid="selected-ticker"]')?.textContent !== ticker) {
    return fail('selected contract changed');
  }
  const indicator = root.querySelector('.quote-strip .stream-state');
  if (!indicator) return fail('quote controls absent');
  if (indicator.textContent?.startsWith('Closed')) return fail('contract closed');
  if (indicator.getAttribute('aria-pressed') === 'true') return fail('quote paused');
  const seconds = indicator.querySelector('small')?.textContent?.match(/^(\d+)s since observation$/)?.[1];
  if (seconds === undefined) return fail('no current observation');
  const age = Number(seconds);
  if (age >= maximum) return fail('observation exceeded freshness limit');
  const price = selector => Number(root.querySelector(selector)?.textContent?.match(/^(\d+(?:\.\d+)?)¢$/)?.[1]);
  const yes = price('.quote-strip .yes-price'), no = price('.quote-strip .no-price');
  if (!(yes > 0 && yes < 100)) return fail('no executable YES ask');
  if (!(no > 0 && no < 100)) return fail('no executable NO ask');
  if (yes + no < 99.99) return fail('quote crossed');
  if (!indicator.querySelector('.status-dot:not(.delayed)')) return fail('quote marked delayed');
  return { age };
}

async function selectAndObserveQuote(page, rows, selected, settings, mark, metrics) {
  const [initiallySelected, candidates] = await check('catalog contract selection', () => Promise.all([
    selected.textContent(),
    rows.evaluateAll(items => items.map(row => ({
      ticker: row.getAttribute('data-market-ticker'),
      yes: row.querySelector('.row-prices strong')?.textContent,
      no: row.querySelector('.row-prices > span')?.textContent
    })))
  ]));
  const attempted = new Set();
  let unavailable;
  while (attempted.size < MAX_MARKET_ATTEMPTS) {
    const ticker = chooseMarket(candidates, initiallySelected, attempted);
    if (!ticker) break;
    attempted.add(ticker);
    try {
      return await observeContractQuote(page, rows, ticker, settings, mark, metrics);
    } catch (error) {
      if (!(error instanceof NonexecutableMarket)) throw error;
      unavailable = error;
    }
  }
  throw unavailable || new CheckFailure('catalog has no eligible two-sided contract to select');
}

async function observeContractQuote(page, rows, ticker, settings, mark, metrics) {
  const row = rows.and(page.locator(`[data-market-ticker="${ticker}"]`));
  const status = new Map();
  const quoteEndpoint = request => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.origin === settings.publicUrl.origin &&
      url.searchParams.get('ticker') === ticker && ['/api/book', '/api/stream'].includes(url.pathname)
      ? url.pathname : null;
  };
  const onResponse = response => {
    const path = quoteEndpoint(response.request());
    if (path) status.set(path, `HTTP ${response.status()}`);
  };
  const onFailure = request => {
    const path = quoteEndpoint(request);
    if (path && !status.has(path)) status.set(path, 'no HTTP response');
  };
  page.on('response', onResponse);
  page.on('requestfailed', onFailure);
  try {
    const selectedAt = performance.now();
    const title = await check('matching contract details', async () => {
      const expected = await row.getByRole('heading').innerText({ timeout: TIMEOUT });
      await row.getByRole('button', { name: /^Open / }).click({ timeout: TIMEOUT });
      await page.waitForFunction(
        expectedTicker => document.querySelector('[data-testid="selected-ticker"]')?.textContent === expectedTicker,
        ticker, { timeout: TIMEOUT }
      );
      assert.equal(await page.getByTestId('selected-title').innerText({ timeout: TIMEOUT }), expected);
      mark('contract_ms', selectedAt);
      return expected;
    });
    const options = { ticker, maximum: QUOTE_MAX_SECONDS };
    try {
      const quote = await page.waitForFunction(readQuote, options, { timeout: TIMEOUT });
      metrics.quote_age_s = (await quote.jsonValue()).age;
      await quote.dispose();
    } catch {
      const latest = await page.evaluate(readQuote, { ...options, diagnose: true }).catch(() => null);
      const reason = typeof latest === 'string' ? latest : latest ? 'became usable after timeout' : 'browser state unavailable';
      const book = status.get('/api/book') || 'not observed';
      const stream = status.get('/api/stream') || 'not observed';
      const message = `usable quote timed out (${reason}; book ${book}; stream ${stream})`;
      if (book === 'HTTP 200' && NONEXECUTABLE_QUOTE.has(reason)) throw new NonexecutableMarket(message);
      throw new CheckFailure(message);
    }
    mark('quote_ms', selectedAt);
    return { ticker, title };
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onFailure);
  }
}

export function verifyAnswer(text, { ticker, title }) {
  const heading = normalize(text.split('\n').find(line => line.trim()) || '');
  const baseTitle = normalize(title.split(' · ')[0]);
  if (!text.includes(ticker) && heading !== baseTitle && heading !== normalize(title)) {
    throw new CheckFailure('Ask Why answer did not identify the selected contract');
  }
  if (DEGRADED_ANSWER.test(text)) throw new CheckFailure('Ask Why answer reported unavailable research');
  const pricedEvidence = /\b\d+(?:[.,]\d+)?\s*(?:%|¢|contracts?\b)/i.test(text) &&
    /\b(?:ask|bid|probabilit\w*|chance|fees?|midpoint|payout|settlement)\b/i.test(text);
  const ruleEvidence = /\b(?:settlement rule|resolves to yes|pays (?:if|when))\b[^\n]{20,}/i.test(text);
  if (!pricedEvidence && !ruleEvidence) throw new CheckFailure('Ask Why answer lacked priced evidence or a settlement condition');
}

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

async function openPrivatePage(page, { publicUrl, privateUrl, requireDedicatedCanary }, isCold) {
  const target = isCold ? privateUrl : publicUrl;
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForURL(publicUrl.href, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  const cookies = await page.context().cookies(publicUrl.href);
  const dedicated = cookies.find(item => item.name === '__Host-predictir-canary');
  const share = cookies.find(item => item.name === '__Host-predictir-share');
  if (requireDedicatedCanary && (!dedicated || share)) throw new CheckFailure('dedicated hosted canary credential required');
  const cookie = dedicated || share;
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

async function recordPaperPosition(page, settings, ticker, metrics) {
  await check('paper guest ledger readiness', async () => {
    const guest = await page.waitForFunction(() => localStorage.getItem('predictir:active-account:v1')?.startsWith('guest:'),
      undefined, { timeout: TIMEOUT });
    await guest.dispose();
  });
  const panel = page.locator('.paper-panel');
  await check('paper quantity input', () => panel.getByLabel('Paper contracts', { exact: true }).fill(String(PAPER_QUANTITY)));
  const enteredAt = performance.now();
  const [bookReceivedAt] = await Promise.all([
    check('paper entry book request', async () => {
      const response = await page.waitForResponse(value => {
        const url = new URL(value.url());
        return url.origin === settings.publicUrl.origin && url.pathname === '/api/book' &&
          url.searchParams.get('ticker') === ticker && url.searchParams.get('contracts') === String(PAPER_QUANTITY) && value.request().method() === 'GET';
      }, { timeout: TIMEOUT });
      if (!response.ok()) throw new CheckFailure(`paper entry book HTTP ${response.status()}`);
      if (!/application\/json/i.test(response.headers()['content-type'] || '')) throw new CheckFailure('paper entry book content type');
      return Date.now();
    }),
    check('paper record control', () => panel.getByRole('button', { name: 'Record paper buy', exact: true }).click()),
    check('paper entry UI confirmation', async () => {
      const recorded = panel.getByText(/^Recorded [\d,.]+ paper contract/);
      const refusal = panel.locator('.notice.error[role="alert"]').first();
      await recorded.or(refusal).first().waitFor({ timeout: TIMEOUT });
      if (await refusal.isVisible()) {
        const reason = await refusal.innerText();
        if (/live book|depth|quote|Crossed public book/i.test(reason)) throw new CheckFailure('paper entry refused by quote or depth validation');
        if (/cannot be saved|could not be saved|account could not|guest session/i.test(reason)) throw new CheckFailure('paper entry refused by guest ledger');
        if (/confirmed open|trading close/i.test(reason)) throw new CheckFailure('paper entry refused for a closed contract');
        throw new CheckFailure('paper entry refused by the app');
      }
    })
  ]);
  metrics.paper_entry_ms = elapsed(enteredAt);
  const position = await check('paper entry retained in guest ledger', async () => {
    const record = await page.evaluate(expected => {
      const ledger = JSON.parse(localStorage.getItem('predictir:paper-journal:v1') || 'null');
      const position = ledger?.positions.find(row => row.ticker === expected && row.side === 'yes');
      const fill = ledger?.trades.find(row => row.position_id === position?.id && row.ticker === expected && row.side === 'yes' && row.action === 'buy');
      if (!position || !fill || !Number.isFinite(position.remaining_basis) || position.remaining_basis <= 0) return null;
      const levels = Array.isArray(fill.fills) && fill.fills.length > 0 && fill.fills.every(level =>
        Number.isFinite(level?.quantity) && level.quantity > 0 && Number.isFinite(level.price) && level.price >= 0 && level.price <= 1)
        ? fill.fills.reduce((sum, level) => sum + level.quantity, 0) : null;
      const key = 'predictir.position-reviews.v1';
      const reviews = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...reviews, [position.id]: { paused: true } }));
      return { id: position.id, ticker: position.ticker, remaining: position.remaining_quantity,
        filled: fill.filled, requested: fill.requested, levels, positionAsOf: position.quote_as_of, fillAsOf: fill.quote_as_of };
    }, ticker);
    assert.match(record?.id || '', /^[\w-]{1,100}$/);
    return record;
  });
  if (position.requested !== PAPER_QUANTITY || ![position.filled, position.remaining, position.levels].every(value =>
    Number.isFinite(value) && Math.abs(value - PAPER_QUANTITY) <= 1e-8)) {
    throw new CheckFailure('paper entry did not fill the requested quantity');
  }
  await check('paper entry retained a matching fresh book timestamp', () => {
    assert.equal(position.positionAsOf, position.fillAsOf);
    const age = (bookReceivedAt - Date.parse(position.fillAsOf)) / 1000;
    assert.ok(Number.isFinite(age) && age >= -5 && age < QUOTE_MAX_SECONDS);
    metrics.paper_book_age_s = Math.max(0, Math.floor(age));
  });
  return position.id;
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
    mark('workspace_entry_ms');
    const marketList = page.getByRole('region', { name: 'Market list', exact: true });
    const rows = marketList.locator('[data-market-ticker]');
    const selected = page.getByTestId('selected-ticker');
    await check('market catalog', async () => {
      await rows.first().waitFor({ timeout: TIMEOUT });
      await selected.waitFor({ timeout: TIMEOUT });
      mark('catalog_ms');
    });
    await clip('1 / 4 · Live market catalog');

    const selection = await selectAndObserveQuote(page, rows, selected, settings, mark, metrics);
    const { ticker } = selection;
    await clip('2 / 4 · Selected contract and current bid/ask depth');

    await check('Ask Why answer', async () => {
      const askedAt = performance.now();
      const answerResponse = page.waitForResponse(response => {
        const request = response.request();
        const url = new URL(response.url());
        if (url.origin !== settings.publicUrl.origin || url.pathname !== '/api/assistant' || request.method() !== 'POST') return false;
        try {
          const input = request.postDataJSON();
          return input?.ticker === ticker && input?.panel === 'analysis' && input?.detail === 'full' && input?.messages?.length === 1;
        } catch {
          return false;
        }
      }, { timeout: 65000 });
      const answerVisible = page.locator('.assistant-transcript .answer').first();
      const [, , response] = await Promise.all([
        check('Ask Why control', () => page.getByRole('button', { name: 'Ask why about this contract', exact: true }).click()),
        check('Ask Why rendered answer', () => answerVisible.waitFor({ timeout: 65000 }).then(() => mark('ask_first_ms', askedAt))),
        check('Ask Why selected-contract request', async () => {
          const response = await answerResponse;
          const headers = response.headers();
          if (!response.ok()) {
            const edge = headers['cf-mitigated'] === 'challenge' ? ' (Cloudflare challenge)' :
              headers['x-vercel-mitigated'] ? ' (Vercel mitigation)' :
              /application\/json/i.test(headers['content-type'] || '') ? ' (JSON response)' : '';
            throw new CheckFailure(`Ask Why HTTP ${response.status()}${edge}`);
          }
          if (!/text\/plain/i.test(headers['content-type'] || '')) throw new CheckFailure('Ask Why stream content type');
          const mode = headers['x-research-model'], transport = headers['x-research-transport'];
          if (!ASSISTANT_MODES.has(mode) || !ASSISTANT_TRANSPORTS.has(transport)) throw new CheckFailure('Ask Why response provenance');
          if (settings.requireDedicatedCanary) {
            const expected = settings.host === 'azure' ? 'azure-deterministic' : 'deterministic-contract-brief';
            if (mode !== expected || settings.host === 'canonical' && transport !== 'MCP In-Process')
              throw new CheckFailure('Ask Why response does not match the monitored deployment');
          }
          metrics.assistant_mode = mode;
          metrics.assistant_transport = transport;
          return response;
        })
      ]);
      await check('Ask Why completed stream', () => page.getByText('Answer ready', { exact: true }).waitFor({ timeout: 65000 }));
      mark('ask_complete_ms', askedAt);
      assert.equal(await page.locator('.assistant-identity code').textContent(), ticker);
      assert.ok((await answerVisible.locator('.answer-lead').innerText()).trim().length >= 40);
      await check('Ask Why contract and substantive evidence', async () => verifyAnswer(await response.text(), selection));
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
      positionId = await recordPaperPosition(page, settings, ticker, metrics);
    }
    await clip('4 / 4 · Simulated contracts from current depth, saved in this guest browser');
    await check('My Trades ledger read', async () => {
      const openedAt = performance.now();
      await page.getByRole('button', { name: 'My Trades', exact: true }).click();
      await page.getByRole('heading', { name: 'Portfolio', exact: true }).waitFor({ timeout: TIMEOUT });
      const position = page.locator(`[data-position-id="${positionId}"]`);
      await position.getByText(positionTicker, { exact: true }).waitFor({ timeout: TIMEOUT });
      assert.match(await position.locator('.position-side').innerText(), new RegExp(`\\b${PAPER_QUANTITY} contracts?$`));
      const marked = await position.locator('.position-values > div').filter({ hasText: 'Net exit value' }).locator('strong');
      await marked.waitFor({ timeout: TIMEOUT });
      await page.waitForFunction(id => [...(document.querySelector(`[data-position-id="${id}"]`)?.querySelectorAll('.position-values > div') || [])]
        .some(value => value.querySelector('span')?.textContent === 'Net exit value' && /\d/.test(value.querySelector('strong')?.textContent || '')),
        positionId, { timeout: TIMEOUT });
      const exit = position.getByRole('button', { name: 'Close at bids', exact: true });
      await exit.waitFor({ timeout: TIMEOUT });
      assert.ok(await exit.isEnabled());
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

async function report(results, { host, privateUrl }, stages) {
  const authenticated = Boolean(privateUrl);
  const lines = [
    '# Predictir preview check',
    '',
    `Authenticated coverage: ${authenticated ? 'enabled' : 'skipped (no configured link)'}`,
    'Cold means a new browser context and link redemption. Warm reuses the same browser session and cookies. Azure scale-to-zero is not inferred from browser state.',
    'The check switches to a two-sided contract when the catalog has multiple rows, then verifies an open quote younger than 90 seconds. The paper entry checks the exact book request and the fill levels and quote timestamp retained by the app.',
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
    for (const researchMode of new Set(results[mode].map(row => row.assistant_mode))) {
      const matched = results[mode].filter(row => row.assistant_mode === researchMode);
      lines.push(`${mode} Ask Why (${researchMode}, ${[...new Set(matched.map(row => row.assistant_transport))].join(' / ')}): ${matched.length}`);
    }
  }
  if (stages.length) lines.push('', ...stages.map(stage => `Failed check: ${stage}`));
  const summary = lines.join('\n') + '\n';
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.PREDICTIR_CANARY_RESULTS_FILE) {
    await writeFile(process.env.PREDICTIR_CANARY_RESULTS_FILE, JSON.stringify({ schema: 1, measured_at: new Date().toISOString(), host, authenticated, results, failed_count: stages.length }));
  }
}

async function main() {
  const settings = await check('canary configuration', configuration);
  const playwright = await check('browser dependencies', () => process.env.PREDICTIR_PLAYWRIGHT_DIR
    ? createRequire(join(process.env.PREDICTIR_PLAYWRIGHT_DIR, 'package.json'))('playwright')
    : import('playwright'));
  const channel = process.env.PREDICTIR_CANARY_BROWSER === 'chrome' ? 'chrome' : undefined;
  const browser = await check('Chromium launch', () => playwright.chromium.launch({channel}));
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
    if (settings.requireDedicatedCanary && !settings.privateUrl) stages.push('private · dedicated hosted canary credential is missing');
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
  await report(results, settings, stages);
  if (stages.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Predictir preview check failed: ${error instanceof CheckFailure ? error.message : 'unexpected failure'}.`);
    process.exitCode = 1;
  });
}
