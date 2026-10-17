import { z } from 'zod'
import type { ProcessResult } from '../../../shared/child-process/run-process'
import { runProcess } from '../../../shared/child-process/run-process'
import {
  evolveLedgerStatusSchema,
  type EvolveLedgerStatus,
  type EvolveStartRequest
} from '../../../shared/evolve-workflow'
import {
  parseWorkflowFleetProbe,
  workflowFleetProbeScript,
  workflowFleetRouteProblem
} from '../workflow-script/workflow-fleet-host-probe'
import {
  workflowFleetShellQuote as quote,
  workflowFleetSsh,
  WORKFLOW_FLEET_UNSET_API_KEYS,
  type WorkflowFleetRun
} from '../workflow-script/workflow-fleet-remote-shell'

/** Where the jev-lab CLI runs: a fleet host over the placement's SSH alias, or this computer. */
export type EvolveHostTarget =
  | { kind: 'ssh'; alias: string; name: string }
  | { kind: 'local'; name: string }
  | { kind: 'hosted'; name: string }

export type EvolveHostDeps = { run?: WorkflowFleetRun }

/** One POSIX `sh` script on the target; a spawn failure or lost SSH is no result, never a guess. */
export async function runEvolveHostScript(
  deps: EvolveHostDeps,
  target: EvolveHostTarget,
  script: string,
  timeoutMs: number
): Promise<ProcessResult | undefined> {
  if (target.kind === 'ssh') {
    return await workflowFleetSsh(deps, target.alias, script, timeoutMs)
  }
  if (target.kind === 'hosted') {
    // Never substitute this computer's shell for a cloud run.
    throw new Error(`${target.name} runs in Omnisi Cloud; there is no shell there to run this.`)
  }
  try {
    return await (deps.run ?? runProcess)({
      program: '/bin/sh',
      args: ['-c', script],
      timeoutMs,
      maxOutputBytes: 256 * 1024
    })
  } catch {
    return undefined
  }
}

/**
 * Why a step got no answer from the host, with SSH's last word. Exit 255 is SSH's own failure:
 * the host said nothing, which never shows what its processes are doing.
 */
export function evolveNoAnswer(
  host: string,
  what: string,
  result: ProcessResult | undefined
): string | undefined {
  const last = result?.stderr
    .split('\n')
    .map((line) => line.trim())
    .findLast(Boolean)
    ?.slice(0, 200)
  if (!result) {
    return upperFirst(`${host} could not be reached to ${what}.`)
  }
  if (result.timedOut) {
    return upperFirst(`${host} did not answer in time to ${what}.`)
  }
  return result.code === 255
    ? `Lost contact with ${host} trying to ${what}${last ? ` (${last})` : ''}.`
    : undefined
}

/** Host names start sentences as written, except "this computer". */
export function upperFirst(text: string): string {
  return text.startsWith('this computer') ? `T${text.slice(1)}` : text
}

/** `~/…` expands on the host; anything else is quoted as given. */
export function evolveCheckoutShell(checkout: string): string {
  return checkout.startsWith('~/') ? `"$HOME"/${quote(checkout.slice(2))}` : quote(checkout)
}

function workerDirectory(runId: string): string {
  return `"$HOME"/.omni-fleet/evolve-runs/${quote(runId)}`
}

const PYTHON = '.venv/bin/python -m jevlab evolve'

/** Claude's login (the drafter is `claude -p` on the host), the checkout, its venv and the spec. */
export function evolveReadinessScript(checkout: string, spec: string): string {
  return [
    workflowFleetProbeScript(['claude']),
    `if cd -- ${evolveCheckoutShell(checkout)} 2>/dev/null; then printf 'evolve.checkout=ok\\n'; else printf 'evolve.checkout=missing\\n'; exit 0; fi`,
    `if [ -x .venv/bin/python ]; then printf 'evolve.venv=ok\\n'; else printf 'evolve.venv=missing\\n'; fi`,
    `if [ -f ${quote(spec)} ]; then printf 'evolve.spec=ok\\n'; else printf 'evolve.spec=missing\\n'; fi`
  ].join('\n')
}

function marker(stdout: string, key: string): string | undefined {
  return new RegExp(`^${key.replaceAll('.', '\\.')}=(.*)$`, 'm').exec(stdout)?.[1]?.trim()
}

/** Why the host cannot run this spec, by name; undefined when it can. */
export function evolveReadinessProblem(
  host: string,
  checkout: string,
  spec: string,
  stdout: string
): string | undefined {
  // Claude first: a checkout can be installed; a missing login blocks the host whatever is there.
  const facts = parseWorkflowFleetProbe(stdout)
  const claude = facts
    ? workflowFleetRouteProblem(host, 'claude', facts)
    : `${host} did not report its Claude login.`
  if (claude) {
    return upperFirst(`${claude} Evolve drafts with claude -p there, so it cannot run on ${host}.`)
  }
  const guide = 'see docs/evolve-hosts.md in jev-lab'
  if (marker(stdout, 'evolve.checkout') !== 'ok') {
    return upperFirst(
      `${host} has no jev-lab checkout at ${checkout} (${guide}). Install one there or choose another host.`
    )
  }
  if (marker(stdout, 'evolve.venv') !== 'ok') {
    return `The jev-lab checkout at ${checkout} on ${host} has no .venv (${guide}).`
  }
  return marker(stdout, 'evolve.spec') === 'ok'
    ? undefined
    : `${spec} is not in the jev-lab checkout at ${checkout} on ${host}.`
}

export function evolveSubmitScript(
  input: Pick<
    EvolveStartRequest,
    'iterations' | 'patience' | 'seedFrom' | 'rubricFrom' | 'usdCap'
  > & {
    checkout: string
    spec: string
    submittedBy: string
  }
): string {
  const args = [
    'submit',
    quote(input.spec),
    '--submitted-by',
    quote(input.submittedBy),
    '--json',
    ...(input.iterations ? ['--iterations', quote(String(input.iterations))] : []),
    ...(input.patience ? ['--patience', quote(String(input.patience))] : []),
    ...(input.seedFrom ? ['--seed-from', quote(input.seedFrom)] : []),
    ...(input.rubricFrom ? ['--rubric-from', quote(input.rubricFrom)] : []),
    ...(input.usdCap ? ['--usd-cap', quote(String(input.usdCap))] : [])
  ]
  return [
    WORKFLOW_FLEET_UNSET_API_KEYS,
    `cd -- ${evolveCheckoutShell(input.checkout)} || exit 3`,
    `exec ${PYTHON} ${args.join(' ')}`
  ].join('\n')
}

const submitResultSchema = z.object({
  run_id: z.string().uuid(),
  status: z.literal('queued'),
  spec_sha: z.string().min(1),
  target: z.string().min(1),
  iterations: z.number().int(),
  usd_cap: z.number(),
  seed_from: z.string().nullable().optional(),
  rubric_from: z.string().nullable().optional()
})
export type EvolveSubmitResult = z.infer<typeof submitResultSchema>

function jsonLines(stdout: string): unknown[] {
  return stdout.split('\n').flatMap((line) => {
    const text = line.trim()
    if (!text.startsWith('{')) {
      return []
    }
    try {
      return [JSON.parse(text) as unknown]
    } catch {
      return []
    }
  })
}

export function parseEvolveSubmit(stdout: string): EvolveSubmitResult | undefined {
  return jsonLines(stdout)
    .map((line) => submitResultSchema.safeParse(line))
    .findLast((parsed) => parsed.success)?.data
}

/** One detached worker (it outlives this SSH call and this app); its pid and log stay on the host. */
export function evolveWorkerScript(input: {
  checkout: string
  runId: string
  host: string
  ledgerRunId: string
}): string {
  return [
    WORKFLOW_FLEET_UNSET_API_KEYS,
    `d=${workerDirectory(input.runId)}`,
    'mkdir -p "$d" && chmod 700 "$d" || exit 3',
    `cd -- ${evolveCheckoutShell(input.checkout)} || exit 4`,
    `nohup ${PYTHON} worker --host ${quote(input.host)} --run-id ${quote(input.ledgerRunId)} >"$d/worker.log" 2>&1 </dev/null &`,
    'p=$!',
    `printf '%s\\n' "$p" >"$d/worker.pid"`,
    `printf 'evolve.worker=%s %s\\n' "$p" "$d"`
  ].join('\n')
}

export function parseEvolveWorker(stdout: string): { pid: number; directory: string } | undefined {
  const match = /^(\d+) (\/.+)$/.exec(marker(stdout, 'evolve.worker') ?? '')
  return match ? { pid: Number(match[1]), directory: match[2]! } : undefined
}

/** The worker's liveness first, then the ledger: a dead worker's run is already settled or never will be. */
export function evolvePollScript(input: { checkout: string; runId: string; ledgerRunId: string }) {
  return [
    WORKFLOW_FLEET_UNSET_API_KEYS,
    `d=${workerDirectory(input.runId)}`,
    'p=$(cat "$d/worker.pid" 2>/dev/null)',
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then printf 'evolve.worker=live\\n'; else printf 'evolve.worker=exited\\n'; fi`,
    `cd -- ${evolveCheckoutShell(input.checkout)} || { printf 'evolve.checkout=missing\\n'; exit 0; }`,
    `${PYTHON} status ${quote(input.ledgerRunId)} --json 2>/dev/null`,
    `printf '\\nevolve.status.exit=%s\\n' "$?"`,
    `tail -n 3 "$d/worker.log" 2>/dev/null | cut -c1-240 | sed 's/^/evolve.log=/'`
  ].join('\n')
}

export type EvolvePoll = {
  worker: 'live' | 'exited'
  status?: EvolveLedgerStatus
  /** Why no status was read: the checkout is gone, the ledger has no such run, or it did not parse. */
  statusProblem?: 'checkout' | 'not-found' | 'unreadable'
  log: string[]
}

export function parseEvolvePoll(stdout: string): EvolvePoll | undefined {
  const worker = marker(stdout, 'evolve.worker')
  if (worker !== 'live' && worker !== 'exited') {
    return undefined
  }
  const log = [...stdout.matchAll(/^evolve\.log=(.*)$/gm)].map((match) => match[1]!.trim())
  if (marker(stdout, 'evolve.checkout') === 'missing') {
    return { worker, statusProblem: 'checkout', log }
  }
  const documents = jsonLines(stdout)
  if (documents.some((line) => (line as { found?: unknown }).found === false)) {
    return { worker, statusProblem: 'not-found', log }
  }
  const status = documents
    .map((line) => evolveLedgerStatusSchema.safeParse(line))
    .findLast((parsed) => parsed.success)?.data
  return status ? { worker, status, log } : { worker, statusProblem: 'unreadable', log }
}

/** SIGTERM: the worker settles its ledger run as failed before exiting (jev-lab cli.py). */
export function evolveStopScript(runId: string): string {
  return [
    `d=${workerDirectory(runId)}`,
    'p=$(cat "$d/worker.pid" 2>/dev/null)',
    `if [ -n "$p" ] && kill -TERM "$p" 2>/dev/null; then printf 'evolve.stop=sent\\n'; else printf 'evolve.stop=none\\n'; fi`
  ].join('\n')
}

export function parseEvolveStop(stdout: string): 'sent' | 'none' | undefined {
  const value = marker(stdout, 'evolve.stop')
  return value === 'sent' || value === 'none' ? value : undefined
}
