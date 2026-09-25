const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(code: number, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const c = {
  bold: (text: string) => wrap(1, text),
  dim: (text: string) => wrap(2, text),
  red: (text: string) => wrap(31, text),
  green: (text: string) => wrap(32, text),
  yellow: (text: string) => wrap(33, text),
  blue: (text: string) => wrap(34, text),
  magenta: (text: string) => wrap(35, text),
  cyan: (text: string) => wrap(36, text),
  grey: (text: string) => wrap(90, text),
};

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function heading(text: string): void {
  out(c.bold(text));
}

export function bullet(text: string): void {
  out(`  ${c.grey('•')} ${text}`);
}

export function keyValue(key: string, value: string | number): void {
  out(`  ${c.grey(key.padEnd(14))} ${value}`);
}

export function warn(message: string): void {
  out(c.yellow(`warning: ${message}`));
}

export function error(message: string): void {
  process.stderr.write(`${c.red(`error: ${message}`)}\n`);
}

export function ok(message: string): void {
  process.stdout.write(`${c.green('ok')} ${message}\n`);
}

export function kindBadge(kind: string): string {
  switch (kind) {
    case 'commit':
      return c.magenta('commit ');
    case 'decision':
      return c.cyan('decision');
    case 'cmd':
      return c.blue('cmd    ');
    case 'file':
      return c.grey('file   ');
    case 'chat':
      return c.yellow('chat   ');
    default:
      return kind.padEnd(8);
  }
}
