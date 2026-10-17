import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { ORCA_HOOK_RAW_JSON_TRANSPORT } from '../../shared/agent-hook-types'

export function buildPosixAgentHookPostCommand(
  source: AgentHookSource,
  options: { curlCommand?: string; indent?: string } = {}
): string[] {
  const curlCommand = options.curlCommand ?? 'curl'
  const indent = options.indent ?? '  '
  return [
    `if [ "\${ORCA_AGENT_HOOK_TRANSPORT:-}" = "${ORCA_HOOK_RAW_JSON_TRANSPORT}" ] && command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1; then`,
    // Old raw-JSON receivers require exactly six fields; their endpoint advertises v1.
    '  if [ "${ORCA_AGENT_HOOK_VERSION:-1}" = "1" ]; then',
    `  orca_hook_metadata=$(printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s' "$ORCA_PANE_KEY" "$ORCA_TAB_ID" "$ORCA_AGENT_LAUNCH_TOKEN" "$ORCA_WORKTREE_ID" "$ORCA_AGENT_HOOK_ENV" "$ORCA_AGENT_HOOK_VERSION" | base64 | tr -d '\\n')`,
    '  else',
    `  orca_hook_metadata=$(printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s' "$ORCA_PANE_KEY" "$ORCA_TAB_ID" "$ORCA_AGENT_LAUNCH_TOKEN" "$ORCA_WORKTREE_ID" "$ORCA_AGENT_HOOK_ENV" "$ORCA_AGENT_HOOK_VERSION" "$orca_agent_pid" "$orca_agent_pid_host" | base64 | tr -d '\\n')`,
    '  fi',
    `  [ -n "$orca_hook_metadata" ] && \\`,
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/json" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-Omni-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta-Encoding: base64" \\`,
    `  ${indent}-H "X-Omni-Agent-Hook-Meta-Encoding: base64" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta: \${orca_hook_metadata}" \\`,
    `  ${indent}-H "X-Omni-Agent-Hook-Meta: \${orca_hook_metadata}" \\`,
    `  ${indent}--data-binary @-`,
    'else',
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/x-www-form-urlencoded" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-Omni-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}--data-urlencode "paneKey=\${ORCA_PANE_KEY}" \\`,
    `  ${indent}--data-urlencode "tabId=\${ORCA_TAB_ID}" \\`,
    `  ${indent}--data-urlencode "launchToken=\${ORCA_AGENT_LAUNCH_TOKEN}" \\`,
    `  ${indent}--data-urlencode "worktreeId=\${ORCA_WORKTREE_ID}" \\`,
    `  ${indent}--data-urlencode "env=\${ORCA_AGENT_HOOK_ENV}" \\`,
    `  ${indent}--data-urlencode "version=\${ORCA_AGENT_HOOK_VERSION}" \\`,
    `  ${indent}--data-urlencode "agentPid=\${orca_agent_pid}" \\`,
    `  ${indent}--data-urlencode "agentPidHost=\${orca_agent_pid_host}" \\`,
    `  ${indent}--data-urlencode "payload@-"`,
    'fi'
  ]
}

/** Shell flag the reply-aware post reads; set only for a UserPromptSubmit payload. */
const POSIX_HOOK_REPLY_FLAG = 'orca_hook_reply'

/**
 * Claude-compatible hooks parse stdout as hook output, so the neutral `{}` (#14818) goes out as
 * soon as the event is known, while a UserPromptSubmit holds its stdout for the listener's reply.
 */
export function buildPosixUserPromptSubmitReplyGateLines(): string[] {
  return [
    `case "$payload" in *'"hook_event_name":"UserPromptSubmit"'*) ${POSIX_HOOK_REPLY_FLAG}=1 ;; *) printf "{}\\n" ;; esac`
  ]
}

/**
 * Post the event. With the reply flag set, a JSON body from the listener is relayed to stdout
 * after optional validation; empty or failed replies print the neutral object. Without the flag,
 * the post is silent as before. `onFailure` runs when curl fails either way.
 */
export function buildPosixAgentHookPostWithReplyLines(
  source: AgentHookSource,
  options: { onFailure: string; curlCommand?: string; replyValidatorCommand?: string }
): string[] {
  return [
    'orca_hook_post() {',
    ...buildPosixAgentHookPostCommand(source, {
      curlCommand: options.curlCommand,
      indent: '    '
    }).map((line) => `  ${line}`),
    '}',
    `if [ -n "\${${POSIX_HOOK_REPLY_FLAG}:-}" ]; then`,
    `  orca_hook_response=$(orca_hook_post 2>/dev/null) || { ${options.onFailure}; orca_hook_response=; }`,
    ...(options.replyValidatorCommand
      ? [
          `  orca_hook_response=$(printf '%s' "$orca_hook_response" | ${options.replyValidatorCommand} 2>/dev/null) || orca_hook_response=`
        ]
      : []),
    `  case "$orca_hook_response" in '{'*) printf '%s\\n' "$orca_hook_response" ;; *) printf "{}\\n" ;; esac`,
    'else',
    `  orca_hook_post >/dev/null 2>&1 || ${options.onFailure}`,
    'fi'
  ]
}
