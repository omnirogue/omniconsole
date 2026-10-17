import { describe, expect, it } from 'vitest'
import {
  captureFleetSourceRequest,
  captureFleetSourceResult
} from './conversation-fleet-source-snapshot'

function snapshot() {
  return {
    snapshotId: '10000000-0000-4000-8000-000000000001',
    files: ['manifest.md', 'report.pdf', 'source.ts'].map((targetPath, index) => ({
      id: `20000000-0000-4000-8000-00000000000${index}`,
      name: targetPath,
      targetPath,
      size: 0,
      sha256: '0'.repeat(64),
      executable: false
    })),
    deletions: [],
    warnings: [],
    source: { connectionId: null }
  }
}

describe('captured people deliverable contract', () => {
  it('accepts source-host absolute request paths but only portable returned handoff identities', () => {
    expect(
      captureFleetSourceRequest.safeParse({
        worktree: 'id:workspace',
        paths: [],
        includeDirtyTracked: false,
        deliverables: { kind: 'manifest', manifestPath: '/source/manifest.md' }
      }).success
    ).toBe(true)
    expect(
      captureFleetSourceResult.safeParse({
        ...snapshot(),
        deliverables: { kind: 'manifest', manifestPath: '/source/manifest.md' },
        deliverablePaths: ['manifest.md', 'report.pdf']
      }).success
    ).toBe(false)
  })

  it('requires the full returned deliverable set to reference captured files', () => {
    const valid = {
      ...snapshot(),
      deliverables: { kind: 'manifest', manifestPath: 'manifest.md' },
      deliverablePaths: ['manifest.md', 'report.pdf']
    }
    expect(captureFleetSourceResult.safeParse(valid).success).toBe(true)
    expect(
      captureFleetSourceResult.safeParse({ ...valid, deliverablePaths: ['report.pdf'] }).success
    ).toBe(false)
    expect(
      captureFleetSourceResult.safeParse({
        ...valid,
        deliverablePaths: ['manifest.md', 'missing.pdf']
      }).success
    ).toBe(false)
    expect(
      captureFleetSourceResult.safeParse({ ...valid, deliverablePaths: undefined }).success
    ).toBe(false)
  })

  it('prevents unrelated source context from joining direct-file handoff deliverables', () => {
    const direct = {
      ...snapshot(),
      deliverables: { kind: 'files', paths: ['report.pdf'] },
      deliverablePaths: ['report.pdf']
    }
    expect(captureFleetSourceResult.safeParse(direct).success).toBe(true)
    expect(
      captureFleetSourceResult.safeParse({
        ...direct,
        deliverablePaths: ['report.pdf', 'source.ts']
      }).success
    ).toBe(false)
    expect(
      captureFleetSourceResult.safeParse({
        ...direct,
        deliverablePaths: ['report.pdf', 'report.pdf']
      }).success
    ).toBe(false)
  })

  it('keeps summary-only and older source snapshots compatible', () => {
    expect(captureFleetSourceResult.safeParse(snapshot()).success).toBe(true)
    expect(
      captureFleetSourceResult.safeParse({
        ...snapshot(),
        deliverables: { kind: 'files', paths: [] },
        deliverablePaths: []
      }).success
    ).toBe(true)
  })
})
