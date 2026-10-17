import { describe, expect, it } from 'vitest'
import {
  HANDOFF_CARD_ROUTE_MAX_BYTES,
  HANDOFF_GIT_ROUTE_MAX_BYTES,
  HANDOFF_PIN_ROUTE_MAX_BYTES,
  isEmptyRoutePlan,
  relativeInside,
  routeHandoffFile,
  routeHandoffFiles
} from './handoff-file-routing'

const repo = '/Users/maintainer/repo'
const person = { kind: 'person' as const, sameWorktree: false }
const agentHere = { kind: 'agent' as const, sameWorktree: true }
const machine = { kind: 'machine' as const, sameWorktree: false }

function file(
  path: string,
  size: number,
  extra: Partial<Parameters<typeof routeHandoffFile>[0]> = {}
) {
  return { path, size, repoRoot: repo, ignored: false, ...extra }
}

describe('routeHandoffFile', () => {
  it('moves nothing between agent steps on the same worktree', () => {
    expect(routeHandoffFile(file(`${repo}/src/a.ts`, 10), agentHere)).toEqual({
      route: 'none',
      path: `${repo}/src/a.ts`
    })
    expect(routeHandoffFile(file('/tmp/outside.bin', 10), agentHere).route).toBe('none')
  })

  it('sends a tracked repo file by git and records its relative path', () => {
    expect(routeHandoffFile(file(`${repo}/docs/plan.md`, 2_000), person)).toEqual({
      route: 'git',
      path: `${repo}/docs/plan.md`,
      rel: 'docs/plan.md'
    })
    expect(routeHandoffFile(file(`${repo}/docs/plan.md`, 2_000), machine).route).toBe('git')
  })

  it('never commits an ignored file; it goes to the card workspace as a pin', () => {
    expect(
      routeHandoffFile(file(`${repo}/dist/bundle.js`, 500, { ignored: true }), person)
    ).toEqual({
      route: 'pin',
      path: `${repo}/dist/bundle.js`,
      name: 'bundle.js'
    })
  })

  it('sends a file outside the repo as a pin when it fits', () => {
    expect(routeHandoffFile(file('/Users/maintainer/Desktop/brief.pdf', 3_000), person)).toEqual({
      route: 'pin',
      path: '/Users/maintainer/Desktop/brief.pdf',
      name: 'brief.pdf'
    })
    expect(routeHandoffFile(file('/anywhere/x.md', 1, { repoRoot: null }), person).route).toBe(
      'pin'
    )
  })

  it('routes a repo file over the git ceiling to the card workspace instead of git', () => {
    const big = file(`${repo}/assets/video.mp4`, HANDOFF_GIT_ROUTE_MAX_BYTES + 1)
    expect(routeHandoffFile(big, person).route).toBe('card')
  })

  it('routes files between the pin and card ceilings to the card delivery', () => {
    expect(routeHandoffFile(file('/x/a.bin', HANDOFF_PIN_ROUTE_MAX_BYTES), person).route).toBe(
      'pin'
    )
    expect(routeHandoffFile(file('/x/a.bin', HANDOFF_PIN_ROUTE_MAX_BYTES + 1), person).route).toBe(
      'card'
    )
    expect(routeHandoffFile(file('/x/a.bin', HANDOFF_CARD_ROUTE_MAX_BYTES), person).route).toBe(
      'card'
    )
  })

  it('refuses a file above every ceiling with the reason shown', () => {
    const route = routeHandoffFile(file('/x/render.mov', HANDOFF_CARD_ROUTE_MAX_BYTES + 1), person)
    expect(route.route).toBe('refused')
    expect(route.route === 'refused' && route.reason).toMatch(
      /render\.mov is 32 MB; the card upload ceiling is 32 MB/
    )
  })

  it('refuses an unreadable file and a file with no size', () => {
    expect(routeHandoffFile(file('/x/gone.txt', 1, { readable: false }), person).route).toBe(
      'refused'
    )
    expect(routeHandoffFile(file('/x/nan.txt', Number.NaN), person).route).toBe('refused')
  })

  it('treats Windows separators and the repo root itself correctly', () => {
    expect(relativeInside('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeInside(repo, repo)).toBeNull()
    expect(relativeInside(repo, `${repo}2/file.txt`)).toBeNull()
    expect(relativeInside(repo, `${repo}/../secret`)).toBeNull()
  })
})

describe('routeHandoffFiles', () => {
  it('groups by route and flags a plan that moves nothing', () => {
    const plan = routeHandoffFiles(
      [
        file(`${repo}/a.md`, 1),
        file('/tmp/b.pdf', 1),
        file('/tmp/c.bin', HANDOFF_PIN_ROUTE_MAX_BYTES + 1),
        file('/tmp/d.mov', HANDOFF_CARD_ROUTE_MAX_BYTES + 1)
      ],
      person
    )
    expect(plan.git.map((entry) => entry.rel)).toEqual(['a.md'])
    expect(plan.pin.map((entry) => entry.name)).toEqual(['b.pdf'])
    expect(plan.card.map((entry) => entry.name)).toEqual(['c.bin'])
    expect(plan.refused).toHaveLength(1)
    expect(plan.none).toBe(false)
    expect(isEmptyRoutePlan(plan)).toBe(false)
  })

  it('is a no-op plan between agent steps on one worktree', () => {
    const plan = routeHandoffFiles([file(`${repo}/a.md`, 1), file('/tmp/b.pdf', 1)], agentHere)
    expect(plan.none).toBe(true)
    expect(isEmptyRoutePlan(plan)).toBe(true)
  })

  it('an empty file list is an empty plan, not a no-op plan', () => {
    const plan = routeHandoffFiles([], person)
    expect(plan.none).toBe(false)
    expect(isEmptyRoutePlan(plan)).toBe(true)
  })
})
