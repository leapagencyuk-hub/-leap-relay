// Small visual pieces for Discord cards.
//
// Discord embeds have no charts, so these are built from block characters. A
// trend a coach can see in half a second does more than the same numbers in a
// sentence, and it costs nothing to render.

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * A sparkline scaled from zero, not from the minimum.
 *
 * Scaling from the minimum exaggerates: four flat months would draw as a
 * dramatic staircase. From zero, a flat line looks flat and a collapse looks
 * like a collapse.
 */
export function sparkline(values) {
  const nums = values.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  if (nums.length < 2) return null;
  const max = Math.max(...nums);
  if (max <= 0) return BLOCKS[0].repeat(nums.length);
  return nums.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1)))]).join('');
}

/** A progress bar towards a target, capped so an overshoot still reads as done. */
export function progressBar(value, target, width = 16) {
  const ratio = target > 0 ? Math.max(0, Math.min(1, value / target)) : 0;
  const filled = Math.round(ratio * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}  ${Math.round(ratio * 100)}%`;
}

/**
 * The last `count` complete calendar months, oldest first.
 *
 * The current month is always excluded. Drawing a month-to-date bar beside
 * finished months makes every creator look like they are collapsing on the
 * 20th — the bar is short because the month is short, not because they are
 * down. Months we barely watched are dropped for the same reason.
 *
 * Returns null until there are at least three complete months, because two
 * bars is not a trend, it is a comparison the card already makes in words.
 */
export function monthlyTrend(metrics, count = 6, { minMonths = 3 } = {}) {
  const monthly = metrics.monthlyDiamonds ?? {};
  const coverage = metrics.monthlyCoverage ?? {};
  const currentMonth = (metrics.endDate ?? '').slice(0, 7);
  const keys = Object.keys(monthly)
    .filter((k) => k < currentMonth)
    .filter((k) => (coverage[k] ?? 0) >= daysIn(k) * 0.8)
    .sort()
    .slice(-count);
  if (keys.length < minMonths) return null;
  const values = keys.map((k) => monthly[k]);
  return {
    keys,
    values,
    spark: sparkline(values),
    label: `${keys[0]} to ${keys[keys.length - 1]}`,
  };
}

function daysIn(key) {
  return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
}
