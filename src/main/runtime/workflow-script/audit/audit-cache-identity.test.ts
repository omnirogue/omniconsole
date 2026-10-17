import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_READER_SCHEMA } from '../../../../shared/workflow-audit-contracts'
import { assertAuditReader } from '../../../../shared/workflow-audit-validation'
import { auditDurableFixture } from './audit-durable.test-fixture'
import { auditCaller } from './audit-call'
import { buildAuditCorpus } from './audit-corpus'
import { readAuditSources } from './audit-snapshot'

const fixtures: ReturnType<typeof auditDurableFixture>[] = []
afterEach(() => {
  fixtures.splice(0).forEach((item) => item.close())
})

describe('audit call identity on the durable port', () => {
  it.each(['source', 'schema', 'options'] as const)(
    'refuses stale cache reuse when %s changes under the same call label',
    async (change) => {
      const f = auditDurableFixture()
      fixtures.push(f)
      const ask = auditCaller(f.context, 'Audit fixture')
      let chunk = f.audit.corpus.chunks[0]
      let schema = AUDIT_READER_SCHEMA
      const read = () =>
        ask('read/chunk-0001', 'Read every source.', 'claude', { chunk }, schema, (value) =>
          assertAuditReader(value, chunk.id, chunk.sourceIds)
        )
      const accepted = await read()
      expect(await read()).toEqual(accepted)
      expect(f.calls).toHaveLength(1)
      if (change === 'source') {
        const sources = readAuditSources(f.audit.sourceFile, f.audit.format).filter((source) =>
          chunk.sourceIds.includes(source.id)
        )
        chunk = buildAuditCorpus(
          sources.map((source) => ({ ...source, text: `${source.text}\nNew evidence arrived.` })),
          { maxChunkBytes: 10_000 }
        ).chunks[0]
      } else if (change === 'schema') {
        schema = { ...AUDIT_READER_SCHEMA, description: 'A revised reader contract' }
      } else {
        f.changeSeatIdentity()
      }
      await expect(read()).rejects.toThrow('call identity changed')
      expect(f.calls).toHaveLength(1)
    }
  )
})
