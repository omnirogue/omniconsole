import { expect } from 'vitest'

export const expectedRoutinePrompt = expect.stringMatching(
  /^Routine definition context:[\s\S]*End routine definition context\.\n\nrun this$/
)
