import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../../shared/child-process/run-process'
import { workflowFleetSshArgs } from './local-workflow-fleet-hosts'
import { workflowFleetRemoteCommand, workflowFleetShellQuote } from './workflow-fleet-remote-shell'

/** What contact tells about a seat's process on the host: the SSH boundary vocabulary. */
export type WorkflowFleetSeatVerdict = 'live' | 'exited' | 'unverifiable' | 'not-started'

/** Reads the seat's pid on the host; a live one is asked to stop when `stop`. */
export async function workflowFleetSeatVerdict(
  alias: string,
  directory: string,
  stop: boolean,
  deps: { run?: (spec: ProcessSpec) => Promise<ProcessResult> } = {}
): Promise<WorkflowFleetSeatVerdict> {
  const quoted = workflowFleetShellQuote(directory)
  const pid = `${quoted}/pid`
  const script = [
    `p=$(cat ${pid} 2>/dev/null) || { ${stop ? `mkdir -p ${quoted}; mkdir ${quoted}/launch-guard 2>/dev/null || { printf unverifiable; exit 0; }; touch ${quoted}/stopped || { printf unverifiable; exit 0; }; rmdir ${quoted}/launch-guard; ` : ''}printf not-started; exit 0; }`,
    'case "$p" in ""|*[!0-9]*|0|1) printf unverifiable; exit 0 ;; esac',
    'alive() { kill -0 "$p" 2>/dev/null || return 1; case "$(ps -p "$p" -o stat= 2>/dev/null)" in *Z*) return 1 ;; esac; }',
    `started=$(cat ${quoted}/started 2>/dev/null)`,
    'identity() { if alive; then current=$(ps -p "$p" -o lstart= 2>/dev/null); if [ -z "$started" ] || [ -z "$current" ]; then printf unverifiable; exit 0; fi; if [ "$current" != "$started" ]; then printf exited; exit 0; fi; fi; }',
    'identity',
    ...(stop
      ? [
          'if alive; then kill -TERM "$p" 2>/dev/null; fi',
          'n=0; while alive && [ "$n" -lt 5 ]; do sleep 1; identity; n=$((n + 1)); done',
          'if alive; then kill -KILL "$p" 2>/dev/null; fi',
          'n=0; while alive && [ "$n" -lt 2 ]; do sleep 1; identity; n=$((n + 1)); done'
        ]
      : []),
    'if alive; then printf live; else printf exited; fi'
  ].join('\n')
  try {
    const result = await (deps.run ?? runProcess)({
      program: 'ssh',
      args: workflowFleetSshArgs(alias, workflowFleetRemoteCommand(script)),
      timeoutMs: 10_000,
      maxOutputBytes: 1024
    })
    const said = result.code === 0 && !result.timedOut ? result.stdout.trim() : ''
    return said === 'live' || said === 'exited' || said === 'not-started' ? said : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}
