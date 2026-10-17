import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { buildWorkflowClaudeArgs } from '../../../src/shared/workflow-claude-command'
import answerSchema from '../../../src/main/runtime/workflow-script/presets/schemas/answer.schema.json'

export const MANIFEST_SHA = '7242abce4716524cb9b551e942457fc5b5c1a1edfb84efc212ff41ae464f4455'
const sourcePaths = [
  'src/main/runtime/workflow-script/presets/council.ts',
  'src/main/runtime/workflow-script/presets/discover.ts',
  'src/main/runtime/workflow-script/presets/discover-assessment.ts',
  'src/main/runtime/workflow-script/presets/discover-clustering.ts',
  'src/main/runtime/workflow-script/workflow-preset-runner.ts',
  'src/main/runtime/workflow-script/workflow-execution-service.ts',
  'src/main/runtime/workflow-script/presets/schemas/answer.schema.json',
  'src/main/runtime/workflow-script/presets/schemas/council-review.schema.json',
  'src/main/runtime/workflow-script/presets/schemas/council-synthesis.schema.json',
  'src/main/runtime/workflow-script/presets/schemas/findings.schema.json',
  'src/main/runtime/workflow-script/presets/schemas/refutation.schema.json',
  'src/main/runtime/workflow-script/presets/schemas/discovery-ranking.schema.json',
  'src/main/runtime/workflow-script/presets/schemas/discovery-clusters.schema.json',
  'src/shared/workflow-claude-command.ts',
  'src/shared/local-workflow-draft.ts',
  'config/scripts/workflows/diagnostic-council-launch.ts',
  'config/scripts/workflows/quality-stable-baseline.ts',
  'config/scripts/workflows/probe-stable-quality-case.ts',
  'config/scripts/workflows/quality-stable-snapshot.ts',
  'config/scripts/workflows/quality-stable-preflight.ts',
  'config/scripts/workflows/run-stable-quality-batch.mjs',
  'config/scripts/workflows/probe-discover-v5-quality-case.ts',
  'config/scripts/workflows/run-discover-v5-quality-batch.mjs',
  'config/scripts/workflows/export-discover-v5-blind.mjs',
  'docs/workflows/quality-gate-discover-v5-2026-09-21.json',
  'config/scripts/workflows/probe-discover-v6-quality-case.ts',
  'config/scripts/workflows/run-discover-v6-quality-batch.mjs',
  'config/scripts/workflows/export-discover-v6-blind.mjs',
  'docs/workflows/quality-gate-discover-v6-2026-09-21.json'
]
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 10_000 }).trim()
}
export function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function sourceFingerprints(): Record<string, string> {
  return Object.fromEntries(sourcePaths.map((path) => [path, sha(readFileSync(path))]))
}
export function cliVersions(): Record<string, string> {
  return Object.fromEntries(
    ['claude', 'codex', 'grok'].map((route) => [
      route,
      execFileSync(route, ['--version'], { encoding: 'utf8', timeout: 8_000 }).trim()
    ])
  )
}
export function assertStableSource(
  expectedHead: string,
  fingerprints: Record<string, string>
): void {
  if (git('rev-parse', 'HEAD') !== expectedHead || git('status', '--porcelain') !== '') {
    throw new Error('Workflow quality source head or working tree changed')
  }
  if (JSON.stringify(sourceFingerprints()) !== JSON.stringify(fingerprints)) {
    throw new Error('Workflow preset, prompt or CLI policy changed during quality run')
  }
}
export function attestClaudePolicy(): void {
  const args = buildWorkflowClaudeArgs({
    model: 'claude-sonnet-5',
    effort: 'low',
    attemptId: randomUUID(),
    schema: answerSchema
  })
  if (args[args.indexOf('--permission-mode') + 1] !== 'dontAsk') {
    throw new Error('Final Claude workflow permission policy is not active')
  }
}
