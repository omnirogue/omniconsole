import { useEffect, useRef, useState, type RefObject } from 'react'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import type { WorkflowStageModel } from './workflow-run-stages'

type StageDisclosureProps = {
  open: boolean
  onToggle?: () => void
  /** Set on the last stage: the answer or report a finished run leads with. */
  itemRef?: RefObject<HTMLLIElement | null>
}

/** Toggles belong to one phase of the run: those made while it worked end when it finishes. */
type Overrides = { completed: boolean; open: Record<string, boolean> }

/** Less than this much of the result showing counts as off screen: a heading alone says nothing. */
const LEAD_MIN_VISIBLE_PX = 48

/**
 * The box the run is read in: its nearest ancestor that scrolls (the run pane), else the window.
 * An ancestor that could scroll but fits its content holds the whole run, so it is passed over.
 */
function visibleEdges(element: HTMLElement): { top: number; bottom: number } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    const scrolls = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
    if (scrolls && node.scrollHeight > node.clientHeight) {
      const { top, bottom } = node.getBoundingClientRect()
      return { top, bottom }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}

/** True when the result starts above the pane or too far down it to be read. */
function leadOffScreen(element: HTMLElement): boolean {
  const { top } = element.getBoundingClientRect()
  const edges = visibleEdges(element)
  return top < edges.top || top > edges.bottom - LEAD_MIN_VISIBLE_PX
}

/**
 * Every started stage is open while a run works. A finished run leads with its last stage (the
 * chairman's answer or the Discover report) and folds the rest — at once when it finishes, not
 * only when reopened — so nobody scrolls past dozens of cards to reach the result. If the result
 * then sits outside the pane it is read in, it is scrolled into view. Any stage with content can
 * be toggled.
 */
export function useStageDisclosure(
  view: Pick<LocalWorkflowView, 'state'>,
  stages: readonly WorkflowStageModel[]
) {
  const completed = view.state === 'completed'
  const [overrides, setOverrides] = useState<Overrides>(() => ({ completed, open: {} }))
  const current = overrides.completed === completed ? overrides.open : {}
  const lastIndex = stages.length - 1
  const leadRef = useRef<HTMLLIElement>(null)
  // True when the run was already finished when this view opened: nothing to bring forward.
  const settledSeen = useRef(completed)
  useEffect(() => {
    if (!completed) {
      settledSeen.current = false
      return
    }
    if (settledSeen.current) {
      return
    }
    settledSeen.current = true
    const element = leadRef.current
    if (element && leadOffScreen(element)) {
      element.scrollIntoView({ block: 'start' })
    }
  }, [completed])
  return {
    props(stage: WorkflowStageModel): StageDisclosureProps {
      const started = stage.tone !== 'queued'
      const last = stage.index === lastIndex
      const defaultOpen = completed ? last : started || stage.index === 0
      const open = current[stage.id] ?? defaultOpen
      const lead = last ? { itemRef: leadRef } : {}
      if (!started && !completed) {
        return { open, ...lead }
      }
      return {
        open,
        ...lead,
        onToggle: () => setOverrides({ completed, open: { ...current, [stage.id]: !open } })
      }
    }
  }
}
