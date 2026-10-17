import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildGrokChatHistoryPathCandidates,
  resolveGrokSessionsDir
} from '../../../src/shared/grok-session-paths'
import { workflowEvidenceDigest } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'

async function main() {
  const label = process.argv[2] ?? 'read-only-profile'
  if (!/^[a-z-]+$/.test(label)) {
    throw new Error('Invalid probe label')
  }
  const receipt = JSON.parse(
    await readFile(`docs/workflows/evidence/a01-grok-${label}.json`, 'utf8')
  )
  const [history] = buildGrokChatHistoryPathCandidates({
    sessionId: receipt.attemptId,
    cwd: await realpath(receipt.cwd),
    sessionsDir: resolveGrokSessionsDir()
  })
  if (!history) {
    throw new Error('No session artifact path')
  }
  const root = dirname(history)
  const context = JSON.parse(await readFile(join(root, 'prompt_context.json'), 'utf8'))
  const tools = JSON.parse(await readFile(join(root, 'tool_definitions.json'), 'utf8')) as {
    function: { name: string }
  }[]
  const system = await readFile(join(root, 'system_prompt.txt'), 'utf8')
  const rows = (await readFile(history, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const report = {
    testId: `grok-artifact-inspection-${label}`,
    attemptId: receipt.attemptId,
    artifacts: root,
    instructionFiles: context.agents_md_files,
    memoryEnabled: context.memory_enabled,
    memoryV2Enabled: context.memory_v2_enabled,
    tools: tools.map((tool) => tool.function.name),
    systemBytes: Buffer.byteLength(system),
    systemDigest: workflowEvidenceDigest(system),
    messages: rows.map((row) => ({
      type: row.type,
      syntheticReason: row.synthetic_reason ?? null,
      bytes: Buffer.byteLength(JSON.stringify(row.content ?? null)),
      digest: workflowEvidenceDigest(JSON.stringify(row.content ?? null))
    }))
  }
  await writeFile(
    `docs/workflows/evidence/grok-artifacts-${label}.json`,
    `${JSON.stringify(report, null, 2)}\n`
  )
  console.log(JSON.stringify(report, null, 2))
}
void main()
