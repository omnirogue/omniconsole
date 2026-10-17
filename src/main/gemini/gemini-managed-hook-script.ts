import { buildPosixAgentHookPostWithReplyLines } from '../agent-hooks/hook-post-command'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines
} from '../agent-hooks/hook-stdin-contract'
import { AGENT_HOOK_PROMPT_REPLY_MAX_BYTES } from '../../shared/agent-hook-prompt-reply-limit'
import { buildWindowsGeminiHookScript } from '../agent-hooks/windows-hook-post-reply'

// Gemini runs on Node; if its interpreter is unavailable, the shell emits the neutral object.
const REPLY_VALIDATOR = `node -e '${[
  'let reply = {};',
  'try {',
  'const text = require("node:fs").readFileSync(0, "utf8");',
  `if (Buffer.byteLength(text, "utf8") > ${AGENT_HOOK_PROMPT_REPLY_MAX_BYTES}) throw new Error();`,
  'const output = JSON.parse(text)?.hookSpecificOutput;',
  'if (output?.hookEventName === "BeforeAgent" && typeof output.additionalContext === "string") {',
  'reply = {hookSpecificOutput: {hookEventName: "BeforeAgent", additionalContext: output.additionalContext}};',
  '}',
  '} catch {}',
  'process.stdout.write(JSON.stringify(reply));'
].join(' ')}'`

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return buildWindowsGeminiHookScript()
  }
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture('empty-object'),
    // The listener verifies the event and launch claim; this gate also accepts pretty-printed input.
    'if printf \'%s\' "$payload" | command -p grep -Eq \'"hook_event_name"[[:space:]]*:[[:space:]]*"BeforeAgent"\'; then',
    '  orca_hook_reply=1',
    'else',
    '  printf "{}\\n"',
    'fi',
    ...buildPosixHookSpoolLines('gemini'),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  unset ORCA_AGENT_HOOK_TRANSPORT',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" >/dev/null 2>&1 || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  if [ -n "${orca_hook_reply:-}" ]; then printf "{}\\n"; fi',
    '  exit 0',
    'fi',
    ...buildPosixAgentHookPostWithReplyLines('gemini', {
      onFailure: 'spool_hook_event',
      curlCommand: `curl --fail --max-filesize ${AGENT_HOOK_PROMPT_REPLY_MAX_BYTES}`,
      replyValidatorCommand: REPLY_VALIDATOR
    }),
    'exit 0',
    ''
  ].join('\n')
}
