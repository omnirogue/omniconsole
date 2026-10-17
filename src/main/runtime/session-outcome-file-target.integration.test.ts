import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { compileNextStepOutcomes } from '../../shared/next-outcome-definition-compile'
import { verifySessionOutcomeCondition } from './session-outcome-evidence'

it.each([
  ['Write ./deliverable.v2.txt.', 'deliverable.v2.txt'],
  ['Write "./deliverable final.v2.txt"!', 'deliverable final.v2.txt']
])('verifies the actual file committed by %s', async (instructions, filename) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'outcome-file-target-'))
  try {
    const [definition] = compileNextStepOutcomes(
      [{ id: 'result', finish: { kind: 'complete' }, instructions, steps: [] }],
      {
        chainId: 'chain',
        workspacePath,
        sessionLabel: 'Deliver a report',
        fallbackActor: { agent: 'codex' },
        steps: []
      }
    )
    const condition = definition!.conditions[0]!
    expect(definition!.conditions).toHaveLength(1)
    expect(condition.target).toBe(`./${filename}`)
    expect(await verifySessionOutcomeCondition(condition, workspacePath)).toMatchObject({
      verified: false
    })

    await writeFile(join(workspacePath, filename), 'Verified report content.')
    expect(await verifySessionOutcomeCondition(condition, workspacePath)).toMatchObject({
      verified: true,
      receipt: expect.stringContaining('sha256:')
    })
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})
