import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainHome } from '../util/paths.js';
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
 * A tiny launcher next to the database so the shell hook never depends on
 * `brain` being on PATH — and so spaces in paths stay safe.
 */
export function cliShimPath(): string {
  return path.join(brainHome(), 'brain');
}

export function writeCliShim(entry?: string): string | null {
  const cliEntry = entry ?? process.argv[1];
  if (!cliEntry) return null;
  const home = brainHome();
  fs.mkdirSync(home, { recursive: true });
  const shim = cliShimPath();
  const posixShim = `#!/bin/sh\n# Generated by Second Brain OS. Runs the CLI bundled with this install.\nexec "${process.execPath}" "${cliEntry}" "$@"\n`;
  fs.writeFileSync(shim, posixShim, 'utf8');
  try {
    fs.chmodSync(shim, 0o755);
  } catch {
    // Not meaningful on Windows.
  }
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(home, 'brain.cmd'),
      `@echo off\r\n"${process.execPath}" "${cliEntry}" %*\r\n`,
      'utf8',
    );
  }
  return shim;
}

export type SupportedShell = 'bash' | 'zsh';

export function rcPathFor(shell: SupportedShell): string {
  return path.join(os.homedir(), shell === 'zsh' ? '.zshrc' : '.bashrc');
}

/** Detect the invoking shell, defaulting to bash. */
export function detectShell(explicit?: string): SupportedShell {
  if (explicit === 'bash' || explicit === 'zsh') return explicit;
  const envShell = process.env.SHELL ?? '';
  if (envShell.includes('zsh')) return 'zsh';
  if (process.env.ZSH_VERSION) return 'zsh';
  return 'bash';
}

export interface ShellInstallResult {
  installed: boolean;
  rcFile: string;
  shell: SupportedShell;
  alreadyPresent: boolean;
  shim: string | null;
}

export function installShellHook(shell: SupportedShell = detectShell(), rcFileOverride?: string): ShellInstallResult {
  const rcFile = rcFileOverride ?? rcPathFor(shell);
  const shim = writeCliShim();
  const existing = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
  if (existing.includes(SHELL_MARKER_START)) {
    return { installed: false, rcFile, shell, alreadyPresent: true, shim };
  }
  const snippet = `${SHELL_HOOK_SNIPPET.trimEnd()}\n`;
  const content = existing.trim().length > 0 ? `${existing.replace(/\s*$/, '')}\n\n${snippet}` : snippet;
  fs.mkdirSync(path.dirname(rcFile), { recursive: true });
  fs.writeFileSync(rcFile, content, 'utf8');
  log.info(`installed shell hook in ${rcFile}`);
  return { installed: true, rcFile, shell, alreadyPresent: false, shim };
}

export function uninstallShellHook(
  shell: SupportedShell = detectShell(),
  rcFileOverride?: string,
): { removed: boolean; rcFile: string } {
  const rcFile = rcFileOverride ?? rcPathFor(shell);
  if (!fs.existsSync(rcFile)) return { removed: false, rcFile };
  const content = fs.readFileSync(rcFile, 'utf8');
  const start = content.indexOf(SHELL_MARKER_START);
  const end = content.indexOf(SHELL_MARKER_END);
  if (start === -1 || end === -1) return { removed: false, rcFile };
  const cleaned = `${content.slice(0, start)}${content.slice(end + SHELL_MARKER_END.length)}`.replace(
    /\n{3,}/g,
    '\n\n',
  );
  fs.writeFileSync(rcFile, cleaned.trim().length > 0 ? `${cleaned.trimEnd()}\n` : '', 'utf8');
  return { removed: true, rcFile };
}

export function shellHookInstalled(shell: SupportedShell = detectShell(), rcFileOverride?: string): boolean {
  const rcFile = rcFileOverride ?? rcPathFor(shell);
  if (!fs.existsSync(rcFile)) return false;
  return fs.readFileSync(rcFile, 'utf8').includes(SHELL_MARKER_START);
}

/** Splits an `SB1` line into its fields (used by `brain hook line`). */
export function splitLine(line: string): string[] {
  return line.replace(/[\r\n]+$/, '').split('\t');
}
