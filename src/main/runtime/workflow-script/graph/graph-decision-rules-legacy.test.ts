import { describe, expect, it } from 'vitest'
import { DECISION_SCENARIOS, planDigest } from './graph-decision-test-scenarios'
import { drive } from './graph-test-harness'

// Taken on main-next 12f9735c2, before decision rules: a run frozen then must plan byte for byte.
const BEFORE: Record<string, string> = {
  Council: 'c02db34c443c7fa3decacf0bb3324e141e665356257626f27d4be5f8098e9c3d',
  Discover: '227092ae539998b3af7593d5286618d26ae4a205aa35913173d668c043533e91',
  Decide: 'b0707169ecbbeed834e9aa14cb22e9bdde1980f405549b708a6a39f34c595577',
  'Decide, an option unscored': '0ef82c3bc76502c5321d13cf421fb0e34b262ab288023481f894352d5ca7d2b1',
  'Decide, one answer unsure': 'd96dae6f2db73790774493528bee31649565a0c3924a541132d11d87f7968449',
  'Decide, one answer sure': '317d6e7477734dd42f07927e622f9d4734bddedf18b61bb95cac26508d21254c',
  'Find the best': '29a8385fd9739df08381c79f6ece65f99f0e9224ae9bf82ea4a4fd043eef7475',
  'Find the best, your list and rubric lines':
    '6584afc932e81c4e051db52f089f28cb66438294ff6c089e76ecbc180932d0b9',
  Improve: '927c9e47a558ae9ee78c4dd200c78c665f16f6dc593f3bec11ae695dc6ba6de4'
}

describe('a run frozen before decision rules', () => {
  it('pins every scenario', () => {
    expect(DECISION_SCENARIOS.map((scenario) => scenario.name).sort()).toEqual(
      Object.keys(BEFORE).sort()
    )
  })

  it.each(DECISION_SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    '%s plans exactly as before',
    (name, scenario) => {
      const plan = drive(scenario.spec, scenario.answer, { discoverVerifyRules: undefined })
      expect(plan.ready).toEqual([])
      expect(planDigest(plan)).toBe(BEFORE[name])
    }
  )
})
