import { buildWindowsPromptHookScript } from '../agent-hooks/windows-hook-post-reply'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildPosixHookAnswerAckFunctionLines,
  buildPosixHookAnswerSplitLines,
  posixHookPrintReplyCommand
} from '../agent-hooks/hook-answer-ack-script'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines
} from '../agent-hooks/hook-stdin-contract'

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return buildWindowsPromptHookScript('codex')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('codex'),
    // Why: sourcing refreshes PORT/TOKEN/ENV/VERSION from the current OmniConsole so a surviving PTY keeps reporting after a restart (see claude/hook-service.ts).
    'load_hook_endpoint() {',
    '  endpoint_path="$1"',
    '  unset ORCA_AGENT_HOOK_TRANSPORT',
    '  case "$endpoint_path" in',
    '    *.cmd)',
    // Why: Windows passes endpoint.cmd into WSL via WSLENV; parse only OmniConsole's known assignments since cmd.exe `set` lines aren't shell syntax.
    '      endpoint_cr=$(printf "\\r")',
    '      while IFS= read -r endpoint_line || [ -n "$endpoint_line" ]; do',
    '        endpoint_line=${endpoint_line%"$endpoint_cr"}',
    '        case "$endpoint_line" in',
    '          "set ORCA_AGENT_HOOK_PORT="*) ORCA_AGENT_HOOK_PORT=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_TOKEN="*) ORCA_AGENT_HOOK_TOKEN=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_ENV="*) ORCA_AGENT_HOOK_ENV=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_VERSION="*) ORCA_AGENT_HOOK_VERSION=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_TRANSPORT="*) ORCA_AGENT_HOOK_TRANSPORT=${endpoint_line#*=} ;;',
    '        esac',
    '      done < "$endpoint_path"',
    '      ;;',
    '    *)',
    '      . "$endpoint_path" 2>/dev/null || :',
    '      ;;',
    '  esac',
    '}',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  load_hook_endpoint "$ORCA_AGENT_HOOK_ENDPOINT"',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    'post_codex_hook() {',
    '  curl_bin="$1"',
    '  connect_timeout="${2:-0.5}"',
    '  max_time="${3:-1.5}"',
    '  orca_hook_late="${4:-0}"',
    // Why: keep full hook JSON off the command line and avoid URL-encoding paths/commands into IDS-friendly traversal signatures.
    ...buildPosixAgentHookPostCommand('codex', {
      curlCommand: '"$curl_bin"',
      indent: '    ',
      lateVar: 'orca_hook_late'
    }).map((line) => `  ${line}`),
    '}',
    // Why: these events relay the listener's reply (an OmniOS answer or the next-step pointer).
    'codex_reply=',
    'case "$payload" in',
    `  *'"hook_event_name":"PostToolUse"'*|*'"hook_event_name":"Stop"'*|*'"hook_event_name":"SessionStart"'*|*UserPromptSubmit*) codex_reply=1 ;;`,
    'esac',
    ...buildPosixHookAnswerAckFunctionLines(),
    'send_codex_hook() {',
    '  orca_hook_response=$(post_codex_hook "$@" 2>/dev/null) || return 1',
    '  if [ -n "$codex_reply" ]; then',
    ...buildPosixHookAnswerSplitLines('    '),
    `    case "$orca_hook_response" in '{'*) ${posixHookPrintReplyCommand()} ;; esac`,
    '  fi',
    '}',
    'is_wsl_runtime() {',
    '  [ -n "$WSL_DISTRO_NAME" ] && return 0',
    '  grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease /proc/version 2>/dev/null',
    '}',
    'if send_codex_hook curl; then',
    '  exit 0',
    'fi',
    'if is_wsl_runtime; then',
    '  windows_curl=$(command -v curl.exe 2>/dev/null || true)',
    '  if [ -n "$windows_curl" ] && [ -x "$windows_curl" ]; then',
    // Why late: the retry runs past the hook's 1.5 s deadline, so its reply may carry no OmniOS answer.
    '    if send_codex_hook "$windows_curl" 3 5 1; then',
    '      exit 0',
    '    fi',
    '    # post_codex_hook "$windows_curl" 3 5 >/dev/null 2>&1 || true',
    '  fi',
    'fi',
    'spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}
