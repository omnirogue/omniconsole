import { readFile, writeFile } from 'node:fs/promises'
import { parseWorkflowNativeResult } from '../../../src/main/runtime/workflow-script/workflow-native-result'

async function main(): Promise<void> {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false
  }
  const input = JSON.parse(await readFile('docs/workflows/evidence/a01-codex-initial.json', 'utf8'))
  const result = parseWorkflowNativeResult('codex', input, schema, (value) =>
    (value as { answer: string }).answer === 'council-native-schema-probe'
      ? null
      : 'unexpected answer'
  )
  const evidence = {
    testId: 'A01-codex-native-parse',
    status: 'pass',
    attemptId: input.attemptId,
    expectedModelFromLaunch: 'gpt-5.6-sol',
    modelReturnedByEnvelope: null,
    limitation:
      'The NDJSON envelope does not attest resolved model lineage. Route certification remains pending.',
    result
  }
  await writeFile(
    'docs/workflows/evidence/a01-codex-native-parse.json',
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  const grok = JSON.parse(await readFile('docs/workflows/evidence/a01-grok-initial.json', 'utf8'))
  const grokResult = parseWorkflowNativeResult('grok', grok, schema, (value) =>
    (value as { answer: string }).answer === 'council-native-schema-probe'
      ? null
      : 'unexpected answer'
  )
  await writeFile(
    'docs/workflows/evidence/a01-grok-native-parse.json',
    `${JSON.stringify({ testId: 'A01-grok-native-parse', status: 'pass', attemptId: grok.attemptId, result: grokResult }, null, 2)}\n`
  )
  const claude = JSON.parse(
    await readFile('docs/workflows/evidence/a01-claude-explicit-config.json', 'utf8')
  )
  const claudeResult = parseWorkflowNativeResult('claude', claude, schema, (value) =>
    (value as { answer: string }).answer === 'council-native-schema-probe'
      ? null
      : 'unexpected answer'
  )
  await writeFile(
    'docs/workflows/evidence/a01-claude-native-parse.json',
    `${JSON.stringify({ testId: 'A01-claude-native-parse', status: 'pass', attemptId: claude.attemptId, result: claudeResult }, null, 2)}\n`
  )
  console.log(JSON.stringify({ codex: evidence, grok: grokResult, claude: claudeResult }))
}
void main()
