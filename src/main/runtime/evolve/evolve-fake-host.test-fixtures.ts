import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessSpec } from '../../../shared/child-process/run-process'
import { runProcess } from '../../../shared/child-process/run-process'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'

export const FAKE_LEDGER_RUN_ID = '11111111-1111-4111-8111-111111111111'

/**
 * A fleet host in a temp folder: its own HOME with a jev-lab checkout whose `.venv/bin/python`
 * answers submit/worker/status like jev-lab, a `claude` on PATH, and `ssh` that runs the remote
 * command in a local `/bin/sh` (the command string is exactly what SSH would get).
 */
export function createFakeEvolveHost(
  options: { claudeLoggedIn?: boolean; workerSeconds?: number } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'evolve-host-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const state = join(root, 'state')
  const checkout = join(home, 'Repos', 'jev-lab-evolve')
  for (const dir of [
    bin,
    state,
    join(checkout, '.venv', 'bin'),
    join(checkout, 'jevlab/evolve/email')
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(checkout, 'jevlab/evolve/email/smoke.yaml'), 'target: email-replies-smoke\n')
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  script(
    join(bin, 'claude'),
    `case "$1" in --version) echo '2.1.300 (Claude Code)' ;; auth) echo '{"loggedIn": ${options.claudeLoggedIn === false ? 'false' : 'true'}, "authMethod": "claude.ai"}' ;; esac`
  )
  const status = (value: string, extra = '') =>
    `{"run_id": "${FAKE_LEDGER_RUN_ID}", "found": true, "target": "email-replies-smoke", "status": "${value}", "spec_sha": "s1", "failure_class": ${value === 'failed' ? '"KeyboardInterrupt"' : 'null'}, "iterations": {"requested": 3, "evaluated_mutations": ${value === 'done' ? 2 : 0}}, "seed_from": "email-replies-smoke", "seeded": [{"candidate_id": "c2", "source_run_id": "r1", "source_candidate_id": "c1", "program_sha": "p", "prior_combined_score": 0.75, "prior_promoted": false, "status": "evaluated", "combined_score": 0.74}], "promotions": []${extra}}`
  writeFileSync(join(state, 'running.json'), status('running'))
  writeFileSync(
    join(state, 'done.json'),
    status('done', ', "summary": {"best_combined_score": 0.8}')
  )
  writeFileSync(join(state, 'failed.json'), status('failed'))
  writeFileSync(join(state, 'status.json'), status('queued'))
  script(
    join(checkout, '.venv', 'bin', 'python'),
    [
      'shift 3',
      'cmd=$1; shift',
      'echo "$cmd $*" >> "$FAKE_STATE/calls"',
      'case "$cmd" in',
      `  submit) for a in "$@"; do [ "$a" = --json ] && ok=1; done; [ -n "$ok" ] || { echo 'jevlab evolve: error: unrecognized arguments: --json' >&2; exit 2; }; echo '{"run_id": "${FAKE_LEDGER_RUN_ID}", "status": "queued", "spec_sha": "s1", "target": "email-replies-smoke", "iterations": 3, "usd_cap": 1.0, "seed_from": "email-replies-smoke", "rubric_from": null}' ;;`,
      `  worker) cp "$FAKE_STATE/running.json" "$FAKE_STATE/status.json"; trap 'cp "$FAKE_STATE/failed.json" "$FAKE_STATE/status.json"; exit 1' TERM; i=0; while [ $i -lt ${(options.workerSeconds ?? 0.4) * 10} ]; do sleep 0.1; i=$((i+1)); done; [ -e "$FAKE_STATE/die" ] && exit 9; cp "$FAKE_STATE/done.json" "$FAKE_STATE/status.json" ;;`,
      '  status) cat "$FAKE_STATE/status.json" ;;',
      'esac'
    ].join('\n')
  )
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_STATE: state }
  let reachable = true
  const run = async (spec: ProcessSpec) => {
    if (spec.program === 'ssh') {
      if (!reachable) {
        return {
          code: 255,
          signal: null,
          stdout: '',
          stderr: 'ssh: connect to host mw0001 port 22: Operation timed out',
          timedOut: false
        }
      }
      return await runProcess({
        ...spec,
        program: '/bin/sh',
        args: ['-c', spec.args!.at(-1)!],
        env
      })
    }
    return await runProcess({ ...spec, env })
  }
  const placement: WorkflowPlacement = {
    runsOn: 'fleet',
    mode: 'dispatched-seats',
    choice: 'named',
    host: {
      name: 'mw0001',
      machine: 'macserver-0-01',
      cores: 24,
      loadPerCore: 0.18,
      readAt: 1,
      ssh: 'mw0001'
    }
  }
  return {
    root,
    home,
    state,
    checkout: '~/Repos/jev-lab-evolve',
    run,
    placement,
    setReachable: (value: boolean) => {
      reachable = value
    }
  }
}
