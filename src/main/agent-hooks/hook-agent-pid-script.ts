/** Resolve inside the hook, never trust an inherited PID from a parent agent. */
export function buildPosixHookAgentPidLines(): string[] {
  return [
    'orca_agent_pid=',
    'orca_hook_ancestor=${PPID:-}',
    'orca_hook_depth=0',
    'while [ "$orca_hook_depth" -lt 16 ]; do',
    '  case "$orca_hook_ancestor" in ""|*[!0-9]*|0|1) break ;; esac',
    '  orca_hook_ps=$(command -p ps -o ppid=,comm= -p "$orca_hook_ancestor" 2>/dev/null) || break',
    // Trim ps padding with parameter expansion: hooks may run with an empty PATH (no `tr`).
    '  orca_hook_ps=${orca_hook_ps#"${orca_hook_ps%%[![:space:]]*}"}',
    '  orca_hook_ppid=${orca_hook_ps%%[[:space:]]*}',
    '  orca_hook_comm=${orca_hook_ps#"$orca_hook_ppid"}',
    '  orca_hook_comm=${orca_hook_comm#"${orca_hook_comm%%[![:space:]]*}"}',
    '  orca_hook_comm=${orca_hook_comm%"${orca_hook_comm##*[![:space:]]}"}',
    '  orca_hook_comm=${orca_hook_comm##*/}',
    '  case "$orca_hook_comm" in ""|sh|bash|zsh|dash|fish|ash|ksh|csh|tcsh|env|-sh|-bash|-zsh|-dash|-fish|-ksh|-csh|-tcsh) ;;',
    '    *) orca_agent_pid=$orca_hook_ancestor; break ;;',
    '  esac',
    '  orca_hook_ancestor=$orca_hook_ppid',
    '  orca_hook_depth=$((orca_hook_depth + 1))',
    'done',
    'orca_agent_pid_host=local',
    'if [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}${SSH_CONNECTION:-}${MSYSTEM:-}${CYGWIN:-}" ]; then orca_agent_pid_host=remote; fi'
  ]
}
