import { buildWindowsAgentHookCurlPostCommand } from '../agent-hooks/installer-utils'
import {
  buildPosixAgentHookPostWithReplyLines,
  buildPosixHookReplyGateLines,
  POSIX_HOOK_EARLY_EXIT
} from '../agent-hooks/hook-post-command'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue,
  WINDOWS_HOOK_STDIN_DRAIN_LABEL
} from '../agent-hooks/hook-stdin-contract'
import { buildPosixWorktreeMemoryLinkLines } from './worktree-memory-link-script'

/** The managed hook body installed for Claude-compatible CLIs (Claude Code, OpenClaude; Devin imports it). */
export function getManagedScript(
  target: 'local' | 'posix' = 'local',
  options: { skipWhenDevinImportsClaude?: boolean } = {}
): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: Claude-compatible permission hooks fail closed on empty stdout (#14818).
      // The Windows script relays no listener reply yet (prompt, answer or Stop); see the POSIX body below.
      'echo {}',
      // Why: refresh endpoint coordinates for PTYs surviving an OmniConsole restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      // Why (#11549): the env guards must outrank the Devin skip — the Devin skip parks in more.com,
      // and outside an OmniConsole pane the caller can abandon stdin, so more.com never returns.
      ...buildWindowsHookEnvironmentGuardLines(),
      // Grok imports Claude hooks too; its own managed hook owns these events.
      `if defined GROK_HOOK_EVENT if defined GROK_SESSION_ID goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`,
      // Why: a backgrounded session runs in a daemon worker that inherited the dispatching
      // pane's env, so ORCA_PANE_KEY names a pane this session does not run in (#9236).
      // Why exit, not the drain label: the drain parks in more.com and a worker is outside
      // an OmniConsole pane — the abandoned-stdin hang #11549 guards against.
      'if not "%CLAUDE_JOB_DIR%"=="" exit /b 0',
      ...(options.skipWhenDevinImportsClaude
        ? [
            // Why: Devin imports .claude hooks by default; skip OmniConsole's managed hook there so status posts stay attributed to Devin.
            `if not "%DEVIN_PROJECT_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`
          ]
        : []),
      // Why: use curl.exe to avoid an extra PowerShell startup per hook.
      buildWindowsAgentHookCurlPostCommand('claude'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    // Why: Claude parses stdout as hook output. Permission hooks fail closed on an empty one (#14818),
    // so the neutral object goes out as soon as the event is known; UserPromptSubmit, SessionStart,
    // PostToolUse and Stop instead relay the listener's JSON reply and fall back to `{}`.
    ...buildPosixHookReplyGateLines(),
    // Grok imports Claude hooks too; do not overwrite its identity or link Claude memory.
    'if [ -n "$GROK_HOOK_EVENT" ] && [ -n "$GROK_SESSION_ID" ]; then',
    `  ${POSIX_HOOK_EARLY_EXIT}`,
    'fi',
    // Why: worktree agents must carry the repo's Claude memory; runs before any early exit.
    ...buildPosixWorktreeMemoryLinkLines(),
    ...buildPosixHookSpoolLines('claude'),
    ...(options.skipWhenDevinImportsClaude
      ? [
          // Why: Devin imports .claude hooks by default; skip OmniConsole's managed hook there so status posts stay attributed to Devin.
          'if [ -n "$DEVIN_PROJECT_DIR" ]; then',
          `  ${POSIX_HOOK_EARLY_EXIT}`,
          'fi'
        ]
      : []),
    // Why: a backgrounded session runs in a daemon worker that inherited the dispatching
    // pane's env, so ORCA_PANE_KEY names a pane this session does not run in (#9236).
    'if [ -n "$CLAUDE_JOB_DIR" ]; then',
    `  ${POSIX_HOOK_EARLY_EXIT}`,
    'fi',
    // Why: refresh endpoint coordinates for PTYs surviving an OmniConsole restart.
    // Why: suppress parse errors so they neither leak nor trip outer set -e.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  unset ORCA_AGENT_HOOK_TRANSPORT ORCA_AGENT_HOOK_LIFECYCLE_QUEUE',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    `  ${POSIX_HOOK_EARLY_EXIT}`,
    'fi',
    'if [ "${ORCA_AGENT_HOOK_LIFECYCLE_QUEUE:-}" = "1" ] && [ -r "${ORCA_AGENT_HOOK_ENDPOINT:-}" ]; then',
    `  case "$payload" in *'"hook_event_name":"SubagentStart"'*|*'"hook_event_name": "SubagentStart"'*)`,
    '    orca_hook_queue_token=$ORCA_AGENT_HOOK_TOKEN',
    '    if spool_hook_event; then exit 0; fi',
    '    unset orca_hook_queue_token',
    '  ;; esac',
    'fi',
    // Why: keep full hook JSON off the command line and avoid IDS-friendly URL-encoded paths.
    ...buildPosixAgentHookPostWithReplyLines('claude', {
      onFailure: 'spool_hook_event',
      answerAck: true
    }),
    'exit 0',
    ''
  ].join('\n')
}
