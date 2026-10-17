import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkPlanShape } from '../../../../../shared/work-plan-shapes'
import { MenuItem } from './MenuItems'

export function WorkPlanRouting({
  topology,
  route,
  external,
  destination,
  available,
  onTopology,
  onRoute,
  onExternal
}: {
  topology: WorkPlanShape
  route: 'human' | 'new-session'
  external: boolean
  destination: 'agent' | 'person' | 'fleet' | null
  available: (shape: WorkPlanShape, route?: 'human' | 'new-session') => boolean
  onTopology: (shape: WorkPlanShape) => void
  onRoute: (route: 'human' | 'new-session') => void
  onExternal: (kind: 'agent' | 'person' | 'fleet') => void
}) {
  const shapes: [WorkPlanShape, string][] = [
    ['solo', translate('nextStep.shapeSolo', '1 agent')],
    ['parallel', translate('nextStep.shapeParallel', 'Parallel ×3')],
    ['council', translate('nextStep.shapeCouncil', 'Council')],
    ['bestOfN', translate('nextStep.shapeBestOfN', 'Best-of-N')]
  ]
  const [howOpen, setHowOpen] = useState(false)
  const [whereOpen, setWhereOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={howOpen}
        onClick={() => setHowOpen(!howOpen)}
      >
        {translate('nextStep.howNext', 'HOW · {{shape}}', {
          shape: shapes.find(([id]) => id === topology)?.[1]
        })}
      </Button>
      {howOpen ? (
        <div role="group" aria-label={translate('nextStep.howQuestion', 'HOW')}>
          {shapes
            .filter(([shape]) => available(shape))
            .map(([shape, label]) => (
              <MenuItem
                key={shape}
                selected={shape === topology}
                onChoose={() => {
                  onTopology(shape)
                }}
              >
                {label}
              </MenuItem>
            ))}
        </div>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={whereOpen}
        onClick={() => setWhereOpen(!whereOpen)}
      >
        {translate('nextStep.whereNext', 'WHERE · {{route}}', {
          route:
            destination === 'agent'
              ? translate('nextStep.agentKind', '🤖 Agent')
              : destination === 'person'
                ? translate('nextStep.personKind', '👤 Person')
                : destination === 'fleet'
                  ? translate('nextStep.routeComputer', 'Computer or fleet…')
                  : route === 'human'
                    ? translate('nextStep.routeMe', 'Me')
                    : translate('nextStep.routeContinue', 'Continue workflow')
        })}
      </Button>
      {whereOpen ? (
        <div role="group" aria-label={translate('nextStep.whereQuestion', 'WHERE')}>
          {(['human', 'new-session'] as const)
            .filter((value) => available(topology, value))
            .map((value) => (
              <MenuItem
                key={value}
                selected={value === route && !external}
                onChoose={() => {
                  onRoute(value)
                }}
              >
                {value === 'human'
                  ? translate('nextStep.routeMe', 'Me')
                  : translate('nextStep.routeContinue', 'Continue workflow')}
              </MenuItem>
            ))}
          <MenuItem
            onChoose={() => {
              onExternal('agent')
            }}
          >
            {translate('nextStep.agentKind', '🤖 Agent')}
          </MenuItem>
          <MenuItem
            onChoose={() => {
              onExternal('person')
            }}
          >
            {translate('nextStep.personKind', '👤 Person')}
          </MenuItem>
          <MenuItem
            onChoose={() => {
              onExternal('fleet')
            }}
          >
            {translate('nextStep.routeComputer', 'Computer or fleet…')}
          </MenuItem>
        </div>
      ) : null}
    </>
  )
}
