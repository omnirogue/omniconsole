import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OMP_APPROVAL_OVERLAY_YAML } from '../../shared/omp-approval-overlay'
import { writeOmpApprovalOverlayConfig } from './omp-approval-overlay-writer'

describe('writeOmpApprovalOverlayConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omp-approval-overlay-writer-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the overlay file with the managed write-approval YAML', () => {
    const overlayPath = join(dir, 'nested', 'omp-approval-overlay.yaml')
    const result = writeOmpApprovalOverlayConfig(overlayPath)
    expect(result).toBe(overlayPath)
    expect(readFileSync(overlayPath, 'utf-8')).toBe(OMP_APPROVAL_OVERLAY_YAML)
  })

  it('is idempotent when the file already matches', () => {
    const overlayPath = join(dir, 'omp-approval-overlay.yaml')
    writeOmpApprovalOverlayConfig(overlayPath)
    const beforeMtime = readFileSync(overlayPath, 'utf-8')
    writeOmpApprovalOverlayConfig(overlayPath)
    expect(readFileSync(overlayPath, 'utf-8')).toBe(beforeMtime)
  })

  it('overwrites a file that drifted from the managed contents', () => {
    const overlayPath = join(dir, 'omp-approval-overlay.yaml')
    writeFileSync(overlayPath, 'tools:\n  approvalMode: yolo\n', 'utf-8')
    writeOmpApprovalOverlayConfig(overlayPath)
    expect(readFileSync(overlayPath, 'utf-8')).toBe(OMP_APPROVAL_OVERLAY_YAML)
  })
})
