export function createAdmission(totalLimit, identityLimit) {
  const counts = new Map();
  let activeWindow, total = 0;
  return (identity, window) => {
    if (window !== activeWindow) {
      counts.clear();
      activeWindow = window;
      total = 0;
    }
    const used = counts.get(identity) ?? 0;
    if (used >= identityLimit || total >= totalLimit) return false;
    counts.set(identity, used + 1);
    total += 1;
    return true;
  };
}
