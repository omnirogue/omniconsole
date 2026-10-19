import { describe, expect, it } from 'vitest'
import {
  artifactContentUrl,
  parseArtifactContentUrl,
  sanitizeArtifactSessionOrigin
} from './artifact-session'

const API = 'https://app.omnisi.ai'

describe('artifact content URLs', () => {
  it('round-trips a slug through the content URL', () => {
    const url = artifactContentUrl(API, 'plan_2-a')
    expect(url).toBe('https://app.omnisi.ai/a/plan_2-a/content')
    expect(parseArtifactContentUrl(url, API)).toBe('plan_2-a')
  })

  it('refuses anything that is not exactly an artifact document on the API origin', () => {
    expect(parseArtifactContentUrl('https://evil.example/a/plan/content', API)).toBeNull()
    expect(parseArtifactContentUrl(`${API}/a/plan`, API)).toBeNull()
    expect(parseArtifactContentUrl(`${API}/a/plan/content?x=1`, API)).toBeNull()
    expect(parseArtifactContentUrl(`${API}/a/plan/content#top`, API)).toBeNull()
    expect(parseArtifactContentUrl(`${API}/v1/artifacts/plan/content`, API)).toBeNull()
    expect(parseArtifactContentUrl(`${API}/a/..%2Fv1/content`, API)).toBeNull()
    expect(parseArtifactContentUrl('not a url', API)).toBeNull()
  })
})

describe('sanitizeArtifactSessionOrigin', () => {
  it('keeps only non-empty string identity fields', () => {
    expect(
      sanitizeArtifactSessionOrigin({ paneKey: 'tab:leaf', worktreeId: 'wt', extra: 'x' })
    ).toEqual({ paneKey: 'tab:leaf', worktreeId: 'wt' })
    expect(sanitizeArtifactSessionOrigin({ worktreeId: 'wt', paneKey: 7 })).toEqual({
      worktreeId: 'wt'
    })
  })

  it('reads a missing or malformed origin as none', () => {
    expect(sanitizeArtifactSessionOrigin(undefined)).toBeNull()
    expect(sanitizeArtifactSessionOrigin('tab:leaf')).toBeNull()
    expect(sanitizeArtifactSessionOrigin({ paneKey: '', worktreeId: null })).toBeNull()
    expect(sanitizeArtifactSessionOrigin({ paneKey: 'x'.repeat(5_000) })).toBeNull()
  })
})
