export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const suffix = diff >= 0 ? 'ago' : 'from now';
  const pick = (value: number, unit: string): string =>
    `${value} ${unit}${value === 1 ? '' : 's'} ${suffix}`;
  if (abs < minute) return 'just now';
  if (abs < hour) return pick(Math.round(abs / minute), 'minute');
  if (abs < day) return pick(Math.round(abs / hour), 'hour');
  if (abs < week) return pick(Math.round(abs / day), 'day');
  if (abs < month) return pick(Math.round(abs / week), 'week');
  if (abs < year) return pick(Math.round(abs / month), 'month');
  return pick(Math.round(abs / year), 'year');
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDay(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 1))}…`;
}

export function shortPath(path: string, max = 60): string {
  if (path.length <= max) return path;
  const tail = path.slice(-(max - 3));
  return `…${tail}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
