export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.SECOND_BRAIN_LOG ?? 'info').toLowerCase() as LogLevel;
  return order[raw] ?? order.info;
}

function emit(level: LogLevel, msg: string, extra?: unknown): void {
  if (order[level] < threshold()) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase()} ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line, extra ?? '');
  else console.error(line, extra ?? '');
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
