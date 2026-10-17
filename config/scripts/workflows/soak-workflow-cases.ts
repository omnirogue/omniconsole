export type SoakScenario = 'clean' | 'retry-invalid' | 'permanent-invalid'
type Preset = 'council' | 'discover'
export type SoakCase = {
  id: string
  preset: Preset
  scenario: SoakScenario
  expectedState: string
  expectedLaunches: number
  expectedAccepted: number
}

/** Twenty-five per preset; expected failures stay in the denominator. */
export const soakCases: SoakCase[] = [
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `council-clean-${i + 1}`,
    preset: 'council' as const,
    scenario: 'clean' as const,
    expectedState: 'completed',
    expectedLaunches: 7,
    expectedAccepted: 7
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `council-retry-${i + 1}`,
    preset: 'council' as const,
    scenario: 'retry-invalid' as const,
    expectedState: 'completed',
    expectedLaunches: 8,
    expectedAccepted: 7
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `council-fail-${i + 1}`,
    preset: 'council' as const,
    scenario: 'permanent-invalid' as const,
    expectedState: 'failed',
    expectedLaunches: 8,
    expectedAccepted: 5
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `discover-clean-${i + 1}`,
    preset: 'discover' as const,
    scenario: 'clean' as const,
    expectedState: 'completed',
    expectedLaunches: 6,
    expectedAccepted: 6
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `discover-retry-${i + 1}`,
    preset: 'discover' as const,
    scenario: 'retry-invalid' as const,
    expectedState: 'completed',
    expectedLaunches: 7,
    expectedAccepted: 6
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `discover-fail-${i + 1}`,
    preset: 'discover' as const,
    scenario: 'permanent-invalid' as const,
    expectedState: 'failed',
    expectedLaunches: 7,
    expectedAccepted: 4
  }))
]
