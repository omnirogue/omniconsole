import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../../src/shared/child-process/run-process'
import type { JsonSchema } from '../../../src/shared/json-schema-validate'
import { resolveOllamaBaseUrl } from '../../../src/main/local-ollama/ollama-inventory'
import { parseWorkflowNativeResult } from '../../../src/main/runtime/workflow-script/workflow-native-result'
import {
  workflowOllamaCallContext,
  workflowOllamaCatalog,
  workflowOllamaProfile
} from '../../../src/main/runtime/workflow-script/workflow-ollama-catalog'
import { OLLAMA_WORKER_SCRIPT } from '../../../src/main/runtime/workflow-script/workflow-ollama-worker'

/**
 * A real workflow call on this computer's Ollama: the shipped worker script, a schema answer, and
 * with --workspace a read of a small folder through the workspace tools. Prints the catalog the
 * setup screen would list and the parsed receipt. `--model <tag>` picks the model; otherwise the
 * first installed one whose family is known.
 */
const schema: JsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' }, confident: { type: 'boolean' } },
  required: ['answer', 'confident'],
  additionalProperties: false
}

async function main(): Promise<void> {
  const flag = (name: string) => {
    const at = process.argv.indexOf(name)
    return at === -1 ? undefined : process.argv[at + 1]
  }
  const workspace = process.argv.includes('--workspace')
  const catalog = await workflowOllamaCatalog()
  console.log(
    JSON.stringify({
      catalog: catalog.models.map((model) => ({
        id: model.catalog.id,
        lineage: model.lineage,
        tools: model.supportsTools,
        note: model.catalog.description
      })),
      unavailableReason: catalog.unavailableReason ?? null
    })
  )
  const model =
    flag('--model') ??
    catalog.models.find(
      (entry) => entry.lineage !== 'unknown' && (!workspace || entry.supportsTools)
    )?.catalog.id
  if (!model) {
    throw new Error('No installed Ollama model this probe can use.')
  }
  const root = await mkdtemp(join(tmpdir(), 'workflow-ollama-probe-'))
  await writeFile(join(root, 'notes.txt'), 'The launch code word is PELICAN.\n')
  const prompt = workspace
    ? 'Read notes.txt in the workspace with the tools and answer: what is the launch code word?'
    : 'Answer in one word: what is the capital of France?'
  const base = resolveOllamaBaseUrl()
  const started = Date.now()
  const result = await runProcess({
    program: process.execPath,
    args: ['-e', OLLAMA_WORKER_SCRIPT],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      ELECTRON_RUN_AS_NODE: '1',
      OMNI_WORKFLOW_OLLAMA_URL: base
    },
    input: JSON.stringify({
      model,
      attemptId: 'probe',
      prompt,
      schema,
      mode: workspace ? 'workspace-read' : 'frozen',
      ...(workspace ? { root } : {}),
      ...workflowOllamaCallContext({
        model,
        promptChars: prompt.length,
        workspaceRead: workspace,
        limit: (await workflowOllamaProfile(model, base))?.contextTokens
      }),
      timeoutMs: 600_000
    }),
    timeoutMs: 610_000,
    maxOutputBytes: 1_000_000
  })
  const lines = result.stdout.trim().split('\n')
  console.log(
    JSON.stringify({
      model,
      mode: workspace ? 'workspace-read' : 'frozen',
      exit: result.code,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      lineTypes: lines.map((line) => JSON.parse(line).type)
    })
  )
  if (result.code !== 0) {
    throw new Error(lines.at(-1) ?? 'the worker failed')
  }
  const parsed = parseWorkflowNativeResult('ollama', result, schema, () => null)
  console.log(
    JSON.stringify({
      value: parsed.value,
      resolvedModels: parsed.resolvedModels,
      usage: parsed.usage
    })
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
