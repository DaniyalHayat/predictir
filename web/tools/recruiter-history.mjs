import {execFile} from 'node:child_process';
import {appendFile, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const windowMs = 30 * 24 * 60 * 60 * 1000;
const maxRuns = 400;
const maxBytes = 1024 * 1024;
const artifactFile = 'recruiter-history.json';
const hosts = ['canonical', 'azure'];
const modes = ['public', 'cold', 'warm'];
const measures = {
  entry_ms: 'Open private gate (ms)',
  workspace_entry_ms: 'Open authenticated workspace (ms)',
  workspace_entry_ms: 'Open workspace (ms)',
  catalog_ms: 'First market rows (ms)',
  contract_ms: 'Select contract (ms)',
  quote_ms: 'Usable quote (ms)',
  quote_age_s: 'Quote age (s)',
  ask_first_ms: 'First Ask Why text (ms)',
  ask_complete_ms: 'Completed Ask Why (ms)',
  paper_tab_ms: 'Open Paper position (ms)',
  paper_entry_ms: 'Place guest paper position (ms)',
  paper_book_age_s: 'Paper book age (s)',
  portfolio_ms: 'Open My Trades (ms)',
  journey_ms: 'Full browser journey (ms)',
};

function samples(value) {
  return Object.fromEntries(modes.map(mode => [mode, (Array.isArray(value?.[mode]) ? value[mode] : [])
    .slice(0, mode === 'public' ? 1 : 3).map(row => Object.fromEntries(
      Object.entries(measures).filter(([key]) => Number.isSafeInteger(row?.[key]) &&
        row[key] >= 0 && row[key] <= (key.endsWith('_s') ? 3600 : 720_000))
        .map(([key]) => [key, row[key]]),
    )).filter(row => Object.keys(row).length)]));
}

export function currentBrowserRecord({id, attempt, host, outcome, result, now}) {
  const valid = result?.schema === 1 && result.host === host && typeof result.authenticated === 'boolean' &&
    Number.isSafeInteger(result.failed_count) && result.failed_count >= 0 && result.failed_count <= 7;
  const results = samples(valid ? result.results : null);
  let status = 'missing';
  if (outcome === 'failure') status = 'failed';
  else if (valid && outcome === 'success') {
    if (result.failed_count) status = 'failed';
    else if (results.public.length && !result.authenticated) status = 'public-only';
    else if (results.public.length && results.cold.length && results.warm.length === results.cold.length) status = 'passed';
  }
  return {id, attempt, at: new Date(now).toISOString(), status, results};
}

export function historyRecords(rows, current, now) {
  const records = new Map();
  for (const row of [...(Array.isArray(rows) ? rows.slice(0, maxRuns) : []), current]) {
    const time = Date.parse(row?.at);
    if (!Number.isSafeInteger(row?.id) || row.id < 1 || !Number.isSafeInteger(row.attempt) || row.attempt < 1 ||
      !['passed', 'failed', 'public-only', 'missing'].includes(row.status) || time < now - windowMs || time > now || !Number.isFinite(time)) continue;
    if ((records.get(row.id)?.attempt || 0) <= row.attempt)
      records.set(row.id, {id: row.id, attempt: row.attempt, at: new Date(time).toISOString(), status: row.status, results: samples(row.results)});
  }
  return [...records.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, maxRuns);
}

export function expectedHost(run, host) {
  const title = /^Recruiter browser check \((canonical|azure|both)\)$/.exec(run.display_title || '')?.[1];
  if (title) return title === 'both' || title === host;
  return run.event === 'schedule' && host === 'canonical';
}

export function historySummary({host, rows, runs = [], current, incomplete = false}) {
  const tracked = new Map(rows.map(row => [row.id, row]));
  for (const run of runs) {
    if ((tracked.get(run.id)?.attempt || 0) < (run.run_attempt || 1))
      tracked.set(run.id, {status: run.conclusion === 'cancelled' ? 'cancelled' : 'missing'});
  }
  const entries = [...tracked.values()], counts = Object.fromEntries(
    ['passed', 'failed', 'public-only', 'cancelled', 'missing'].map(status => [status, entries.filter(row => row.status === status).length]),
  );
  const evaluated = counts.passed + counts.failed;
  const publicChecks = entries.filter(row => row.results?.public?.length).length;
  const lines = [
    `## Hosted browser checks over the last 30 days · ${host}`,
    '',
    `Authenticated passes: ${counts.passed} of ${evaluated} evaluated runs. Failed checks or setup: ${counts.failed}. Public-only: ${counts['public-only']}. Cancelled: ${counts.cancelled}. Missing results: ${counts.missing}.`,
    `Public gate verified: ${publicChecks} runs.`,
    `Current check: ${current.status}.`,
    '',
    'Cold opens a fresh browser and redeems a link. Warm reuses the same browser. Neither measures whether a cloud replica started from zero.',
    'Latencies describe completed journeys. Failed or missing checks remain in the counts above. Nearest-rank p95 requires 20 samples, and p99 requires 100.',
  ];
  if (incomplete) lines.push('GitHub history was unavailable or exceeded the scan limit. The displayed counts are partial.');
  lines.push('', '| Mode | Action | Samples | p95 | p99 |', '|---|---|---:|---:|---:|');
  const percentile = (values, fraction, minimum) => values.length < minimum ? 'insufficient' : values[Math.ceil(fraction * values.length) - 1];
  for (const mode of modes) {
    const data = entries.flatMap(row => row.results?.[mode] || []);
    for (const [key, label] of Object.entries(measures)) {
      if (mode === 'public' && key !== 'entry_ms' || mode !== 'public' && key === 'entry_ms') continue;
      const values = data.map(row => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
      lines.push(`| ${mode} | ${label} | ${values.length} | ${percentile(values, .95, 20)} | ${percentile(values, .99, 100)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

async function gh(args) {
  return (await execute('gh', args, {encoding: 'utf8', timeout: 12_000, maxBuffer: 4 * maxBytes, windowsHide: true})).stdout;
}

async function readBoundedJSON(path) {
  if ((await stat(path)).size > maxBytes) throw new Error('History file too large');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function completedRuns(repository, host, now, currentId) {
  const created = 'created=' + encodeURIComponent('>=' + new Date(now - windowMs).toISOString());
  const base = `repos/${repository}/actions/workflows/recruiter-check.yml/runs?branch=main&status=completed&per_page=100&${created}`;
  const runs = [];
  for (let page = 1; page <= maxRuns / 100; page++) {
    const response = JSON.parse(await gh(['api', base + '&page=' + page]));
    const rows = response.workflow_runs;
    runs.push(...rows.filter(run => run.id !== currentId && expectedHost(run, host)));
    if (rows.length < 100 || response.total_count <= page * 100) return {runs, incomplete: false};
  }
  return {runs, incomplete: true};
}

async function previousHistory(repository, host, runs, temp) {
  if (!runs.length) return [];
  const artifactName = 'predictir-recruiter-history-v1-' + host;
  const response = JSON.parse(await gh(['api', `repos/${repository}/actions/artifacts?per_page=100&name=${artifactName}`]));
  const runIds = new Set(runs.map(run => run.id));
  const candidates = response.artifacts.filter(artifact => artifact.name === artifactName && !artifact.expired &&
    artifact.size_in_bytes > 0 && artifact.size_in_bytes <= maxBytes && runIds.has(artifact.workflow_run?.id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
    .slice(0, 2);
  for (const candidate of candidates) {
    try {
      const directory = await mkdtemp(join(temp, 'predictir-history-'));
      await gh(['run', 'download', String(candidate.workflow_run.id), '--repo', repository, '--name', artifactName, '--dir', directory]);
      const history = await readBoundedJSON(join(directory, artifactFile));
      if (history.schema === 1 && history.host === host && Array.isArray(history.runs)) return history.runs;
    } catch {}
  }
  if (candidates.length) throw new Error('No readable checkpoint');
  return [];
}

async function main(env = process.env) {
  const {GITHUB_REPOSITORY: repository, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary,
    PREDICTIR_CANARY_HOST: host, PREDICTIR_CANARY_RESULTS_FILE: input, PREDICTIR_CANARY_OUTCOME: outcome} = env;
  const id = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT), now = Date.now();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !temp || !summary || !input ||
    !hosts.includes(host) || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid workflow configuration');
  const result = await readBoundedJSON(input).catch(() => null);
  const current = currentBrowserRecord({id, attempt, host, outcome, result, now});
  let runs = [], previous = [], incomplete = false, retrieved = false;
  try {
    ({runs, incomplete} = await completedRuns(repository, host, now, id));
    previous = await previousHistory(repository, host, runs, temp);
    retrieved = true;
  } catch {
    incomplete = true;
    console.warn('::warning::Prior recruiter check history could not be retrieved.');
  }
  const rows = historyRecords(previous, current, now);
  await appendFile(summary, historySummary({host, rows, runs, current, incomplete}));
  if (retrieved) await writeFile(join(temp, artifactFile), JSON.stringify({schema: 1, host, runs: rows}) + '\n');
  if (outcome === 'success' && current.status !== 'passed') {
    console.error('The hosted check did not produce a complete authenticated result.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('The recruiter check history could not be written.');
    process.exitCode = 1;
  });
}
