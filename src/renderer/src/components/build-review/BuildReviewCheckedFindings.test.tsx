// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import type { CheckedReviewFinding } from '../../../../shared/review-findings'
import { BuildReviewCheckedFindings } from './BuildReviewCheckedFindings'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))

afterEach(cleanup)

const finding = (status: CheckedReviewFinding['status']): CheckedReviewFinding => ({
  id: `F-${status}`,
  severity: 'blocker',
  claim: 'broken',
  status
})

describe('BuildReviewCheckedFindings', () => {
  it('never labels a blocking status with the non-blocking "not reproduced" wording', () => {
    const { container } = render(
      <BuildReviewCheckedFindings findings={[finding('located'), finding('not-reproduced')]} />
    )
    const label = (status: string) =>
      container.querySelector(`[data-build-review-evidence-status="${status}"]`)?.textContent
    expect(label('located')).toBe('Located (not proven), still blocking')
    expect(label('not-reproduced')).toBe('Not reproduced (earlier version), still blocking')
    const catalog = en.buildReview.evidence
    expect(catalog.located).toBe('Located (not proven), still blocking')
    expect(catalog.located.toLowerCase()).not.toContain('not reproduced')
    expect(catalog.notReproduced).toBe('Not reproduced (earlier version), still blocking')
  })
})
