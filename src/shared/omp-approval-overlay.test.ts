import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  OMP_APPROVAL_OVERLAY_FILE_NAME,
  OMP_APPROVAL_OVERLAY_YAML,
  applyOmpApprovalOverlayArgs,
  getOmpApprovalOverlayConfigPath
} from './omp-approval-overlay'

describe('omp-approval-overlay', () => {
  it('names the overlay YAML with the write approval mode', () => {
    expect(OMP_APPROVAL_OVERLAY_YAML).toBe('tools:\n  approvalMode: write\n')
    expect(OMP_APPROVAL_OVERLAY_FILE_NAME).toBe('omp-approval-overlay.yaml')
  })

  it('computes a deterministic overlay path under the home directory', () => {
    const first = getOmpApprovalOverlayConfigPath()
    const second = getOmpApprovalOverlayConfigPath()
    expect(first).toBe(second)
    expect(first.endsWith('omp-approval-overlay.yaml')).toBe(true)
    expect(first).toContain('.omniconsole')
    expect(first).toBe(join(homedir(), '.omniconsole', OMP_APPROVAL_OVERLAY_FILE_NAME))
    expect(getOmpApprovalOverlayConfigPath('C:\\Users\\Sal')).toBe(
      'C:\\Users\\Sal\\.omniconsole\\omp-approval-overlay.yaml'
    )
  })

  describe('applyOmpApprovalOverlayArgs (the non-Bypass preset)', () => {
    it('appends --config <overlay path> to empty args', () => {
      expect(applyOmpApprovalOverlayArgs('', '/tmp/omp-approval-overlay.yaml')).toBe(
        '--config /tmp/omp-approval-overlay.yaml'
      )
      expect(applyOmpApprovalOverlayArgs(null, '/tmp/omp-approval-overlay.yaml')).toBe(
        '--config /tmp/omp-approval-overlay.yaml'
      )
      expect(applyOmpApprovalOverlayArgs(undefined, '/tmp/omp-approval-overlay.yaml')).toBe(
        '--config /tmp/omp-approval-overlay.yaml'
      )
    })

    it('preserves unrelated existing args and appends the overlay flag', () => {
      expect(applyOmpApprovalOverlayArgs('--model opus', '/tmp/omp-approval-overlay.yaml')).toBe(
        '--model opus --config /tmp/omp-approval-overlay.yaml'
      )
    })

    it('quotes an overlay path containing spaces', () => {
      expect(
        applyOmpApprovalOverlayArgs('', '/tmp/a path/omp-approval-overlay.yaml', 'posix')
      ).toBe("--config '/tmp/a path/omp-approval-overlay.yaml'")
    })

    it('leaves an explicit --yolo override untouched', () => {
      expect(applyOmpApprovalOverlayArgs('--yolo', '/tmp/omp-approval-overlay.yaml')).toBe('--yolo')
    })

    it('leaves an explicit --auto-approve override untouched', () => {
      expect(applyOmpApprovalOverlayArgs('--auto-approve', '/tmp/omp-approval-overlay.yaml')).toBe(
        '--auto-approve'
      )
    })

    it('leaves an explicit --approval-mode override untouched', () => {
      expect(
        applyOmpApprovalOverlayArgs('--approval-mode always-ask', '/tmp/omp-approval-overlay.yaml')
      ).toBe('--approval-mode always-ask')
    })

    it('leaves an explicit user --config override untouched, without doubling it', () => {
      expect(
        applyOmpApprovalOverlayArgs(
          '--config /home/user/omp.yaml',
          '/tmp/omp-approval-overlay.yaml'
        )
      ).toBe('--config /home/user/omp.yaml')
    })
  })
})
