export function createDatabaseReadiness({query, report, now = Date.now, cacheMs = 15_000, timeoutMs = 1_500}) {
  let cached, pending, checking;
  return async function check() {
    if (cached && now() - cached.at < cacheMs) return cached.status;
    if (pending) return pending;
    if (checking) return 503;
    const started = performance.now();
    const work = Promise.resolve().then(query);
    checking = work;
    const clear = () => { checking = undefined; };
    work.then(clear, clear);
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve('deadline'), timeoutMs);
    });
    pending = Promise.race([work.then(() => 'ok', () => 'unavailable'), deadline]).then(result => {
      const status = result === 'ok' ? 200 : 503;
      cached = {status, at: now()};
      report({status, duration_ms: Math.round(performance.now() - started), result});
      return status;
    }).finally(() => {
      clearTimeout(timer);
      pending = undefined;
    });
    return pending;
  };
}
