import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainHome, cliEntryPath, shellHookCacheFile } from '../util/paths.js';
import { log } from '../util/logger.js';

export const SHELL_MARKER_START = '# >>> secondbrain >>>';
export const SHELL_MARKER_END = '# <<< secondbrain <<<';

/**
 * Shell integration installed by `brain init` / `brain shell install`.
 *
 * Design notes:
 * - bash: a DEBUG trap records the command line, PROMPT_COMMAND flushes it.
 *   Helpers are prefixed so the trap ignores its own bookkeeping.
 * - zsh: native preexec/precmd hooks.
 * - Delivery: the event is written straight to the daemon socket as one
 *   tab-delimited line built with `printf` (no JSON escaping, no process spawn).
 *   When the socket is unavailable it falls back to the CLI shim.
 * - The exit code is taken from the trap/`$?`, and no command is ever dropped
 *   just because the daemon is down.
 */
export const SHELL_HOOK_SNIPPET = `${SHELL_MARKER_START}
# Second Brain OS shell integration. Remove with: brain shell uninstall
if [ -n "\${BASH_VERSION:-}\${ZSH_VERSION:-}" ]; then
  : "\${SECOND_BRAIN_HOME:=$HOME/.secondbrain}"
  export SECOND_BRAIN_HOME
  __BRAIN_ENV_FILE="$SECOND_BRAIN_HOME/daemon.env"
  __BRAIN_SESSION="\${__BRAIN_SESSION:-$(date +%s)-$$}"
  __BRAIN_LAST_DIR=""

  __brain_load_env() {
    if [ -f "$__BRAIN_ENV_FILE" ]; then
      # shellcheck disable=SC1090
      . "$__BRAIN_ENV_FILE" 2>/dev/null
    fi
  }

  __brain_now_ms() {
    __brain_ms="$(date +%s%3N 2>/dev/null)"
    case "$__brain_ms" in
      ''|*[!0-9]*) printf '%s000' "$(date +%s)";;
      *) printf '%s' "$__brain_ms";;
    esac
  }

  # Run the CLI: prefer the shim next to the database (spaces in paths are safe),
  # then whatever "brain" is on PATH.
  __brain_run() {
    if [ -f "$SECOND_BRAIN_HOME/brain" ]; then
      sh "$SECOND_BRAIN_HOME/brain" "$@"
    elif command -v brain >/dev/null 2>&1; then
      brain "$@"
    else
      return 127
    fi
  }

  # Send one tab-delimited line to the daemon; fall back to the CLI shim.
  __brain_write() {
    __brain_load_env
    if [ -n "\${SECOND_BRAIN_PORT:-}" ] && [ -n "\${SECOND_BRAIN_TOKEN:-}" ]; then
      if [ -n "\${BASH_VERSION:-}" ]; then
        if { exec 3<>"/dev/tcp/127.0.0.1/$SECOND_BRAIN_PORT"; } 2>/dev/null; then
          printf '%s\\n' "$1" >&3 2>/dev/null
          exec 3>&- 2>/dev/null
          return 0
        fi
      elif [ -n "\${ZSH_VERSION:-}" ]; then
        if zmodload zsh/net/tcp 2>/dev/null && ztcp 127.0.0.1 "$SECOND_BRAIN_PORT" 2>/dev/null; then
          printf '%s\\n' "$1" >&"$REPLY" 2>/dev/null
          eval "exec $REPLY>&-" 2>/dev/null
          return 0
        fi
      fi
    fi
    __brain_run hook line "$1" >/dev/null 2>&1
    return $?
  }

  __brain_write_cmd() {
    # $1 = command, $2 = exit code, $3 = cwd
    __brain_load_env
    __brain_write "$(printf 'SB1\\t%s\\tcmd\\t%s\\t%s\\t%s\\t%s\\t%s' \\
      "\${SECOND_BRAIN_TOKEN:-}" "$__BRAIN_SESSION" "$2" "$(__brain_now_ms)" "$3" "$1")"
  }

  __brain_cd_check() {
    [ "$PWD" = "\${__BRAIN_LAST_DIR:-}" ] && return
    __BRAIN_LAST_DIR="$PWD"
    __brain_run brief --auto --cwd "$PWD" 2>/dev/null
  }

  if [ -n "\${ZSH_VERSION:-}" ]; then
    autoload -Uz add-zsh-hook 2>/dev/null
    __brain_preexec() { __BRAIN_CMD="$1"; }
    __brain_precmd() {
      local code=$?
      if [ -n "\${__BRAIN_CMD:-}" ]; then
        __brain_write_cmd "$__BRAIN_CMD" "$code" "$PWD"
        __BRAIN_CMD=""
      fi
      __brain_cd_check
    }
    add-zsh-hook preexec __brain_preexec
    add-zsh-hook precmd __brain_precmd
  else
    __BRAIN_CMD=""
    __BRAIN_CODE=0
    __BRAIN_BUSY=""
    __brain_debug() {
      __BRAIN_CODE=$?
      [ -n "\${__BRAIN_BUSY:-}" ] && return
      case "$BASH_COMMAND" in
        __brain_*|__BRAIN_*|trap\\ *|PROMPT_COMMAND=*|local\\ *|return\\ *|unset\\ *|\\[*|:\\ *) return ;;
      esac
      __BRAIN_CMD="$BASH_COMMAND"
    }
    trap '__brain_debug' DEBUG
    __brain_precmd() {
      __BRAIN_BUSY=1
      __BRAIN_PENDING_CMD="\${__BRAIN_CMD:-}"
      __BRAIN_PENDING_CODE="\${__BRAIN_CODE:-0}"
      __BRAIN_CMD=""
      if [ -n "$__BRAIN_PENDING_CMD" ]; then
        __brain_write_cmd "$__BRAIN_PENDING_CMD" "$__BRAIN_PENDING_CODE" "$PWD"
      fi
      __brain_cd_check
      __BRAIN_BUSY=""
    }
    case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
      "declare -a"*) PROMPT_COMMAND=(__brain_precmd "\${PROMPT_COMMAND[@]}") ;;
      *) if [ -n "\${PROMPT_COMMAND:-}" ]; then PROMPT_COMMAND="__brain_precmd;\${PROMPT_COMMAND}"; else PROMPT_COMMAND="__brain_precmd"; fi ;;
    esac
  fi
fi
${SHELL_MARKER_END}
`;

/**
 * PowerShell integration.
 *
 * Why this exists: on Windows the default shell is PowerShell, so a bash-only
 * hook captures nothing there — the timeline stays empty and the brief looks
 * like the tool is broken. `brain init` now detects the invoking shell and
 * installs into `$PROFILE` when that shell is PowerShell.
 *
 * Design notes:
 * - PSReadLine's AddToHistoryHandler sees the exact command line before it runs;
 *   the prompt function is wrapped to flush it together with the exit status
 *   and the current directory (and to brief on directory changes).
 * - The payload is built by joining fields with [char]9 (a tab) — never with a
 *   backtick escape — and written straight to the daemon socket.
 * - Everything is wrapped in try/catch: a broken hook must never break the
 *   user's prompt.
 */
export const POWERSHELL_HOOK_SNIPPET = `${SHELL_MARKER_START}
# Second Brain OS PowerShell integration. Remove with: brain shell uninstall
if (-not $env:SECOND_BRAIN_HOME) { $env:SECOND_BRAIN_HOME = Join-Path $HOME '.secondbrain' }
$global:__BrainSession = if ($global:__BrainSession) { $global:__BrainSession } else { '{0}-{1}' -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()), $PID }
$global:__BrainPending = ''
$global:__BrainLastDir = ''
$global:__BrainLastHistoryId = 0

function global:__Brain-LoadEnv {
  $file = Join-Path $env:SECOND_BRAIN_HOME 'daemon.env'
  if (-not (Test-Path -LiteralPath $file)) { return }
  foreach ($line in (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
    if ($line -match '^([A-Z_]+)=(.*)$') {
      Set-Item -Path ('env:' + $matches[1]) -Value $matches[2] -ErrorAction SilentlyContinue
    }
  }
}

function global:__Brain-Send {
  param([string] $Line)
  __Brain-LoadEnv
  if ($Line -notlike "SB1*") { return }
  if ($env:SECOND_BRAIN_PORT -and $env:SECOND_BRAIN_TOKEN) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect('127.0.0.1', [int]$env:SECOND_BRAIN_PORT)
      $stream = $client.GetStream()
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($Line + ([string][char]10))
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
      $client.Close()
      return
    } catch {
      # Fall through to the CLI shim below.
    }
  }
  $shim = Join-Path $env:SECOND_BRAIN_HOME 'brain.cmd'
  try {
    if (Test-Path -LiteralPath $shim) { & $shim hook line $Line | Out-Null }
    elseif (Get-Command brain -ErrorAction SilentlyContinue) { & brain hook line $Line | Out-Null }
  } catch {
    # Never surface hook failures in the user's prompt.
  }
}

function global:__Brain-Record {
  param([string] $Command, [int] $Code, [string] $Cwd)
  if (-not $Command) { return }
  $clean = $Command -replace '[\t\r\n]+', ' '
  if ($clean -eq 'brain' -or $clean -like 'brain *') { return }
  # The credentials must be loaded before the line is built: the token is one of
  # its fields, and an empty one makes the daemon reject the capture silently.
  __Brain-LoadEnv
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $line = @('SB1', $env:SECOND_BRAIN_TOKEN, 'cmd', $global:__BrainSession, "$Code", "$ts", $Cwd, $clean) -join ([string][char]9)
  __Brain-Send -Line $line
}

function global:__Brain-AutoBrief {
  param([string] $Cwd)
  try {
    $shim = Join-Path $env:SECOND_BRAIN_HOME 'brain.cmd'
    if (Test-Path -LiteralPath $shim) { & $shim brief --auto --cwd $Cwd | Out-Host }
    elseif (Get-Command brain -ErrorAction SilentlyContinue) { & brain brief --auto --cwd $Cwd | Out-Host }
  } catch {
    # A missing brief must never interrupt cd.
  }
}

if (Get-Module -ListAvailable -Name PSReadLine -ErrorAction SilentlyContinue) {
  Import-Module PSReadLine -ErrorAction SilentlyContinue
  try {
    Set-PSReadLineOption -AddToHistoryHandler {
      param([string] $line)
      if ($line) { $global:__BrainPending = $line }
      return $true
    }
  } catch {
    # Older PSReadLine builds: the prompt wrapper still records history entries.
  }
}

$global:__BrainBasePrompt = $function:prompt
function global:prompt {
  try {
    $succeeded = $?
    $code = 0
    if ($succeeded -eq $false) { $code = 1 }
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $code = [int]$LASTEXITCODE }
    $global:LASTEXITCODE = 0
    # PSReadLine tells us the command line directly. When it is unavailable
    # (no module), fall back to the newest PowerShell history entry — tracked
    # by id so a re-rendered prompt cannot record the same command twice.
    $history = Get-History -Count 1 -ErrorAction SilentlyContinue
    $historyId = if ($history) { $history.Id } else { 0 }
    $pending = $global:__BrainPending
    $global:__BrainPending = ''
    if (-not $pending -and $history -and $historyId -ne $global:__BrainLastHistoryId) {
      $pending = $history.CommandLine
    }
    $global:__BrainLastHistoryId = $historyId
    if ($pending) { __Brain-Record -Command $pending -Code $code -Cwd $PWD.Path }
    if ($global:__BrainLastDir -ne $PWD.Path) {
      $global:__BrainLastDir = $PWD.Path
      __Brain-AutoBrief -Cwd $PWD.Path
    }
  } catch {
    # Ignore hook errors and fall through to the user's prompt.
  }
  if ($global:__BrainBasePrompt) { & $global:__BrainBasePrompt } else { 'PS ' + $PWD.Path + '> ' }
}
${SHELL_MARKER_END}
`;

/** The snippet for each supported shell, keyed for `brain shell print --shell x`. */
export const HOOK_SNIPPETS: Record<SupportedShell, string> = {
  bash: SHELL_HOOK_SNIPPET,
  zsh: SHELL_HOOK_SNIPPET,
  powershell: POWERSHELL_HOOK_SNIPPET,
};

/**
 * A tiny launcher next to the database so the shell hook never depends on
 * `brain` being on PATH — and so spaces in paths stay safe.
 */
export function cliShimPath(): string {
  return path.join(brainHome(), 'brain');
}

export function writeCliShim(entry?: string): string | null {
  const cliEntry = entry ?? cliEntryPath();
  if (!cliEntry) return null;
  // Never let the shim point at a test file: that turns a stray `brain` call
  // into a running test suite (and it really happened).
  if (/\.test\.[cm]?[jt]s$/.test(cliEntry) || /[\\/]test[\\/]/.test(cliEntry)) return null;
  const home = brainHome();
  fs.mkdirSync(home, { recursive: true });
  const shim = cliShimPath();
  const posixShim = `#!/bin/sh\n# Generated by Second Brain OS. Runs the CLI bundled with this install.\nexec "${process.execPath}" "${cliEntry}" "$@"\n`;
  writeIfChanged(shim, posixShim);
  try {
    fs.chmodSync(shim, 0o755);
  } catch {
    // Not meaningful on Windows.
  }
  if (process.platform === 'win32') {
    writeIfChanged(path.join(home, 'brain.cmd'), `@echo off\r\n"${process.execPath}" "${cliEntry}" %*\r\n`);
  }
  return shim;
}

/** Write a generated file only when the content actually differs. */
function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // Unreadable: fall through and rewrite.
  }
  fs.writeFileSync(file, content, 'utf8');
}

export type SupportedShell = 'bash' | 'zsh' | 'powershell';

export const SUPPORTED_SHELLS: SupportedShell[] = ['bash', 'zsh', 'powershell'];

/**
 * Every file that could hold the hook for a shell. PowerShell has one profile
 * per installed edition (`powershell.exe` and `pwsh.exe`), and both may be in
 * use, so we resolve the real paths at install time and fall back to the
 * conventional ones.
 */
export function rcCandidatesFor(shell: SupportedShell): string[] {
  const home = os.homedir();
  if (shell === 'powershell') {
    const documents = path.join(home, 'Documents');
    return [...new Set([
      path.join(documents, 'PowerShell', 'profile.ps1'),
      path.join(documents, 'WindowsPowerShell', 'profile.ps1'),
      path.join(home, '.config', 'powershell', 'profile.ps1'),
    ])];
  }
  return [path.join(home, shell === 'zsh' ? '.zshrc' : '.bashrc')];
}

/** Primary hook file for a shell (used for display and single-file installs). */
export function rcPathFor(shell: SupportedShell): string {
  return rcCandidatesFor(shell)[0] ?? path.join(os.homedir(), '.bashrc');
}

/**
 * Ask each PowerShell edition where its `$PROFILE` actually lives (Documents can
 * be redirected to OneDrive) and fall back to the conventional paths.
 */
export async function resolveRcPaths(shell: SupportedShell): Promise<string[]> {
  if (shell !== 'powershell') return rcCandidatesFor(shell);
  const resolved: string[] = [];
  for (const exe of ['powershell', 'pwsh']) {
    const out = await runCapture(exe, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$PROFILE.CurrentUserAllHosts',
    ]);
    const line = out?.trim();
    if (line && line.length > 0) resolved.push(line);
  }
  if (resolved.length > 0) return [...new Set(resolved)];
  return rcCandidatesFor(shell);
}

/** Detect the invoking shell from the environment, defaulting to bash. */
export function detectShell(explicit?: string): SupportedShell {
  if (explicit === 'bash' || explicit === 'zsh' || explicit === 'powershell') return explicit;
  if (explicit === 'pwsh' || explicit === 'powershell_ise') return 'powershell';
  const envShell = process.env.SHELL ?? '';
  if (envShell.includes('zsh')) return 'zsh';
  if (process.env.ZSH_VERSION) return 'zsh';
  return 'bash';
}

/**
 * Which shell actually launched this process. Environment variables are
 * unreliable on Windows (`PSModulePath` is set machine-wide even for Git Bash),
 * so the real answer comes from the process ancestry.
 */
export async function detectInvokingShell(): Promise<SupportedShell | null> {
  const forced = process.env.SECOND_BRAIN_SHELL?.toLowerCase();
  if (forced === 'bash' || forced === 'zsh' || forced === 'powershell') return forced;
  for (const name of await ancestorProcessNames()) {
    const base = name.toLowerCase().replace(/\.exe$/, '');
    if (base === 'pwsh' || base === 'powershell' || base === 'powershell_ise') return 'powershell';
    if (base === 'zsh') return 'zsh';
    if (base === 'bash' || base === 'sh' || base === 'dash') return 'bash';
  }
  if (process.env.ZSH_VERSION) return 'zsh';
  const envShell = process.env.SHELL ?? '';
  if (envShell.includes('zsh')) return 'zsh';
  if (envShell.includes('bash')) return 'bash';
  return null;
}

/**
 * Shells to install hooks for: whatever invoked us, plus the platform defaults.
 * On Windows that means PowerShell *and* Git Bash, because most developers use
 * both and a missing hook silently means an empty timeline.
 */
export async function defaultShells(): Promise<SupportedShell[]> {
  const invoking = await detectInvokingShell();
  const fallback: SupportedShell = process.platform === 'win32' ? 'powershell' : 'bash';
  const shells = process.platform === 'win32' ? ['powershell', 'bash'] : [invoking ?? fallback];
  if (invoking && !shells.includes(invoking)) shells.push(invoking);
  return [...new Set(shells)] as SupportedShell[];
}

const SHELL_ANCESTOR_DEPTH = 4;

/** Names of the parent processes above this one, nearest first. */
async function ancestorProcessNames(): Promise<string[]> {
  try {
    if (process.platform === 'win32') {
      const script =
        `$p = ${process.ppid}; $names = @(); ` +
        `for ($i = 0; $i -lt ${SHELL_ANCESTOR_DEPTH} -and $p -gt 0; $i++) { ` +
        '$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; ' +
        'if (-not $proc) { break }; $names += $proc.Name; $p = [int]$proc.ParentProcessId }; ' +
        '$names -join ","';
      const out = await runCapture('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      if (out) return out.split(',').map((name) => name.trim()).filter(Boolean);
      return [];
    }
    const names: string[] = [];
    let pid = process.ppid;
    for (let i = 0; i < SHELL_ANCESTOR_DEPTH && pid > 1; i++) {
      const out = await runCapture('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
      const line = out?.trim();
      if (!line) break;
      const [parent, command, ...rest] = line.split(/\s+/);
      const name = [command, ...rest].join(' ');
      if (name) names.push(path.basename(name));
      pid = Number(parent ?? 0);
    }
    return names;
  } catch {
    return [];
  }
}

/** Run a helper process, returning stdout or null. Never throws, never blocks long. */
function runCapture(command: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

export interface ShellInstallResult {
  installed: boolean;
  rcFile: string;
  shell: SupportedShell;
  alreadyPresent: boolean;
  shim: string | null;
}

/** Write the snippet into one file. Returns whether anything changed. */
function writeHookInto(rcFile: string, shell: SupportedShell, snippet: string): { installed: boolean; alreadyPresent: boolean } {
  const existing = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
  if (existing.includes(SHELL_MARKER_START)) return { installed: false, alreadyPresent: true };
  const body = `${snippet.trimEnd()}\n`;
  const content = existing.trim().length > 0 ? `${existing.replace(/\s*$/, '')}\n\n${body}` : body;
  fs.mkdirSync(path.dirname(rcFile), { recursive: true });
  fs.writeFileSync(rcFile, content, 'utf8');
  log.info(`installed ${shell} shell hook in ${rcFile}`);
  return { installed: true, alreadyPresent: false };
}

/** Install into the primary file for one shell (sync, override-friendly). */
export function installShellHook(shell: SupportedShell = detectShell(), rcFileOverride?: string): ShellInstallResult {
  const rcFile = rcFileOverride ?? rcPathFor(shell);
  const shim = writeCliShim();
  const result = writeHookInto(rcFile, shell, HOOK_SNIPPETS[shell]);
  return { ...result, rcFile, shell, shim };
}

/**
 * Install the hook for each shell, writing every profile that applies
 * (PowerShell 5.1 and 7 keep separate files on Windows).
 */
export async function installShellHooks(
  shells: SupportedShell[],
  rcFileOverride?: string,
): Promise<ShellInstallResult[]> {
  const shim = writeCliShim();
  const results: ShellInstallResult[] = [];
  for (const shell of shells) {
    const files = rcFileOverride ? [rcFileOverride] : await resolveRcPaths(shell);
    for (const rcFile of files) {
      const result = writeHookInto(rcFile, shell, HOOK_SNIPPETS[shell]);
      results.push({ ...result, rcFile, shell, shim });
    }
    if (!rcFileOverride) writeShellHookCache(shell, [...(readShellHookCache()[shell] ?? []), ...files]);
  }
  return results;
}

/** Remember which profile files we installed into, per shell. */
function writeShellHookCache(shell: SupportedShell, files: string[]): void {
  try {
    const current = readShellHookCache();
    current[shell] = [...new Set(files)];
    fs.mkdirSync(brainHome(), { recursive: true });
    fs.writeFileSync(
      shellHookCacheFile(),
      `${JSON.stringify({ ...current, updatedAt: Date.now() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Cache is an optimisation only — status falls back to the candidates.
  }
}

function readShellHookCache(): Partial<Record<SupportedShell, string[]>> {
  try {
    const file = shellHookCacheFile();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const result: Partial<Record<SupportedShell, string[]>> = {};
    for (const shell of SUPPORTED_SHELLS) {
      const value = parsed[shell];
      if (Array.isArray(value)) {
        result[shell] = value.filter((entry): entry is string => typeof entry === 'string');
      }
    }
    return result;
  } catch {
    return {};
  }
}

function stripHookFrom(content: string): string | null {
  const start = content.indexOf(SHELL_MARKER_START);
  const end = content.indexOf(SHELL_MARKER_END);
  if (start === -1 || end === -1) return null;
  return `${content.slice(0, start)}${content.slice(end + SHELL_MARKER_END.length)}`.replace(/\n{3,}/g, '\n\n');
}

export function uninstallShellHook(
  shell: SupportedShell = detectShell(),
  rcFileOverride?: string,
): { removed: boolean; rcFile: string } {
  const rcFile = rcFileOverride ?? rcPathFor(shell);
  if (!fs.existsSync(rcFile)) return { removed: false, rcFile };
  const cleaned = stripHookFrom(fs.readFileSync(rcFile, 'utf8'));
  if (cleaned === null) return { removed: false, rcFile };
  fs.writeFileSync(rcFile, cleaned.trim().length > 0 ? `${cleaned.trimEnd()}\n` : '', 'utf8');
  return { removed: true, rcFile };
}

/** Remove the hook from every profile of every (or the given) shell. */
export async function uninstallShellHooks(
  shells: SupportedShell[],
): Promise<Array<{ removed: boolean; rcFile: string; shell: SupportedShell }>> {
  const results: Array<{ removed: boolean; rcFile: string; shell: SupportedShell }> = [];
  for (const shell of shells) {
    for (const rcFile of await resolveRcPaths(shell)) {
      results.push({ ...uninstallShellHook(shell, rcFile), shell });
    }
  }
  return results;
}

export function shellHookInstalled(shell: SupportedShell = detectShell(), rcFileOverride?: string): boolean {
  return shellHookFiles(shell, rcFileOverride).length > 0;
}

/**
 * Hook files for a shell that are actually installed right now.
 *
 * Checks the conventional locations *and* whatever the installer recorded, so a
 * redirected Documents folder (OneDrive) cannot make an installed hook look
 * missing to `brain status`, `brain doctor` or the UI.
 */
export function shellHookFiles(shell: SupportedShell, rcFileOverride?: string): string[] {
  const files = rcFileOverride
    ? [rcFileOverride]
    : [...new Set([...rcCandidatesFor(shell), ...(readShellHookCache()[shell] ?? [])])];
  const installed: string[] = [];
  for (const file of files) {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(SHELL_MARKER_START)) {
        installed.push(file);
      }
    } catch {
      // Unreadable file: treat as not installed rather than failing the report.
    }
  }
  return installed;
}

/** Splits an `SB1` line into its fields (used by `brain hook line`). */
export function splitLine(line: string): string[] {
  return line.replace(/[\r\n]+$/, '').split('\t');
}
