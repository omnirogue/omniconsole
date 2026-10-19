/**
 * Shell lines for hook-first answers in the managed POSIX hook scripts. A listener reply that
 * carries an answer starts with `omni-answer <item id> <nonce>`; the script prints only the JSON
 * after it and, once printed, acknowledges in the background (never delaying the agent). Only that
 * acknowledgement counts the answer as injected.
 */

import {
  HOOK_ANSWER_ACK_PATHNAME,
  HOOK_ANSWER_REPLY_PREFIX
} from '../../shared/agent-hook-answer-ack'

/** Defines the newline variable and the background acknowledgement. */
export function buildPosixHookAnswerAckFunctionLines(): string[] {
  return [
    "orca_hook_nl='",
    "'",
    'orca_hook_ack() {',
    `  curl -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}${HOOK_ANSWER_ACK_PATHNAME}" \\`,
    '    --connect-timeout 0.5 --max-time 1 --noproxy "127.0.0.1" \\',
    '    -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '    -H "X-Omni-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '    --data-urlencode "ack=$1"',
    '}'
  ]
}

/** Splits `orca_hook_response` into the answer's ack token (`orca_hook_answer`) and the JSON. */
export function buildPosixHookAnswerSplitLines(indent: string): string[] {
  return [
    'orca_hook_answer=',
    'case "$orca_hook_response" in',
    `  '${HOOK_ANSWER_REPLY_PREFIX}'*"$orca_hook_nl"*)`,
    '    orca_hook_answer=${orca_hook_response%%"$orca_hook_nl"*}',
    `    orca_hook_answer=\${orca_hook_answer#"${HOOK_ANSWER_REPLY_PREFIX}"}`,
    '    orca_hook_response=${orca_hook_response#*"$orca_hook_nl"}',
    '    ;;',
    'esac'
  ].map((line) => `${indent}${line}`)
}

/** Prints the JSON reply; once printed, acknowledges an answer it carried (in the background). */
export function posixHookPrintReplyCommand(): string {
  return `if printf '%s\\n' "$orca_hook_response" && [ -n "$orca_hook_answer" ]; then orca_hook_ack "$orca_hook_answer" </dev/null >/dev/null 2>&1 & fi`
}
