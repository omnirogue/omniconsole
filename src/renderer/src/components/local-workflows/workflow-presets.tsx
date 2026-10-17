import {
  ClipboardCheck,
  Crown,
  Dna,
  Microscope,
  Scale,
  ScanSearch,
  TrendingUp,
  Trophy,
  UsersRound,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_DEFAULT_RUNS_ON,
  type WorkflowRunsOn
} from '../../../../shared/local-workflow-placement'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export type WorkflowPreset = NonNullable<TerminalTab['localWorkflow']>['preset']
/**
 * What a workflow tab is: a preset, or a graph workflow (custom, Best of N or Improve). Graph
 * workflows are stored as Council anchors carrying their graph (older builds read them as
 * Council), so this is derived.
 */
export type WorkflowKind = WorkflowPreset | GraphWorkflowKind | 'audit'
export type GraphWorkflowKind =
  | 'custom'
  | 'best-of-n'
  | 'improve'
  | 'find'
  | 'decide'
  | 'investigate'
  | 'quick-discover'

export function isGraphWorkflowKind(kind: string | undefined): kind is GraphWorkflowKind {
  return (
    kind === 'custom' ||
    kind === 'best-of-n' ||
    kind === 'improve' ||
    kind === 'find' ||
    kind === 'decide' ||
    kind === 'investigate' ||
    kind === 'quick-discover'
  )
}

export function workflowAnchorKind(
  anchor: Pick<NonNullable<TerminalTab['localWorkflow']>, 'preset' | 'draft'>
): WorkflowKind {
  if (anchor.draft?.audit) {
    return 'audit'
  }
  const template = anchor.draft?.graph?.spec.template
  return isGraphWorkflowKind(template) ? template : anchor.preset
}

/**
 * Audit reads its corpus on this computer; other workflows default to fleet placement.
 */
export function workflowPresetRunsOn(preset: WorkflowKind): WorkflowRunsOn {
  return preset === 'audit' ? 'local' : WORKFLOW_DEFAULT_RUNS_ON
}

/** Build + Review and Evolve run no workspace models, so they open from any workspace. */
export function workflowOpensOutsideLocalWorkspace(kind: WorkflowKind): boolean {
  return kind === 'build-review' || kind === 'evolve'
}

// Why re-exported: the label lives in an icon-free module so setup forms whose tests mock this
// module's icons (Build + Review) can read it without this file.
export { workflowRunsOnLabel } from './workflow-runs-on-label'

export const PRIMARY_WORKFLOW_MENU_ORDER: readonly WorkflowKind[] = ['discover', 'evolve'] as const

/** Decide replaces Council in the menu; saved Council runs still open. */
export const OTHER_WORKFLOW_MENU_ORDER: readonly WorkflowKind[] = [
  'improve',
  'find',
  'decide',
  'investigate',
  'audit',
  'build-review'
] as const

export const WORKFLOW_MENU_ORDER: readonly WorkflowKind[] = [
  ...PRIMARY_WORKFLOW_MENU_ORDER,
  ...OTHER_WORKFLOW_MENU_ORDER
] as const

// Why: resolved at render time, not module load, so a test that mocks part of lucide-react and
// only imports a surface that happens to include this module does not fail on a missing icon.
function presetIcon(preset: WorkflowKind): LucideIcon {
  switch (preset) {
    case 'audit':
      return ClipboardCheck
    case 'custom':
      return Workflow
    case 'best-of-n':
      return Trophy
    case 'improve':
      return TrendingUp
    case 'find':
      return Crown
    case 'decide':
      return Scale
    case 'investigate':
      return Microscope
    case 'quick-discover':
      return Zap
    case 'build-review':
      return Wrench
    case 'evolve':
      return Dna
    case 'council':
      return UsersRound
    case 'discover':
      return ScanSearch
  }
}

/** Translated display name. A function, because translate() may not run at module load. */
export function workflowPresetLabel(preset: WorkflowKind): string {
  switch (preset) {
    case 'audit':
      return translate('localWorkflow.preset.audit', 'Audit')
    case 'custom':
      return translate('localWorkflow.preset.custom', 'Workflow')
    case 'best-of-n':
      return translate('localWorkflow.preset.bestOfN', 'Best of N')
    case 'improve':
      return translate('localWorkflow.preset.improve', 'Improve')
    case 'find':
      return translate('localWorkflow.preset.find', 'Find the best')
    case 'decide':
      return translate('localWorkflow.preset.decide', 'Decide')
    case 'investigate':
      return translate('localWorkflow.preset.investigate', 'Investigate')
    case 'quick-discover':
      return translate('localWorkflow.preset.quickDiscover', 'Quick Discover')
    case 'build-review':
      return translate('localWorkflow.preset.buildReview', 'Build + Review')
    case 'evolve':
      return translate('localWorkflow.preset.evolve', 'Evolve')
    case 'council':
      return translate('localWorkflow.preset.council', 'Council')
    case 'discover':
      return translate('localWorkflow.preset.discover', 'Discover')
  }
}

const ENGLISH_LABELS: Record<WorkflowKind, string> = {
  audit: 'Audit',
  custom: 'Workflow',
  'best-of-n': 'Best of N',
  improve: 'Improve',
  find: 'Find the best',
  decide: 'Decide',
  investigate: 'Investigate',
  'quick-discover': 'Quick Discover',
  'build-review': 'Build + Review',
  evolve: 'Evolve',
  council: 'Council',
  discover: 'Discover'
}

/**
 * True when a tab title is still the preset name it was opened with. The English name is accepted
 * too, so switching the app language before Start does not look like a rename.
 */
export function isWorkflowPresetTitle(preset: WorkflowKind, title: string): boolean {
  return title === workflowPresetLabel(preset) || title === ENGLISH_LABELS[preset]
}

/** One-line description used by the ＋ menu and the setup header. */
export function workflowPresetDescription(preset: WorkflowKind): string {
  switch (preset) {
    case 'audit':
      return translate(
        'localWorkflow.preset.auditDescription',
        'Review a collection of records, check quoted evidence and compare plans to address what holds up'
      )
    case 'custom':
      return translate(
        'localWorkflow.preset.customDescription',
        'Describe your own steps; check the plan first or run it right away'
      )
    case 'best-of-n':
      return translate(
        'localWorkflow.preset.bestOfNDescription',
        'Several AIs each make a version; the best one is picked for you'
      )
    case 'improve':
      return translate(
        'localWorkflow.preset.improveDescription',
        'Make a draft, prompt or code better, round after round'
      )
    case 'find':
      return translate(
        'localWorkflow.preset.findDescriptionVersions',
        'Pick the best from many options, a few complete versions, or your own list'
      )
    case 'decide':
      return translate(
        'localWorkflow.preset.decideDescription',
        'Weighs many options against what matters to you, then recommends one and says what you give up'
      )
    case 'investigate':
      return translate(
        'localWorkflow.preset.investigateDescription',
        'Answers a question with evidence: what is true, what conflicts and what is still open'
      )
    case 'quick-discover':
      return translate(
        'localWorkflow.preset.quickDiscoverDescription',
        'One model reads all the code at once and lists problems, unverified; for code that fits one context'
      )
    case 'build-review':
      return translate(
        'localWorkflow.preset.buildReviewDescription',
        'Make a change, then have other AIs review it for a few rounds'
      )
    case 'evolve':
      return translate(
        'localWorkflow.preset.evolveDescription',
        "Evolve a prompt or policy with jev-lab's OpenEvolve on a fleet computer; results stay in the central ledger"
      )
    case 'council':
      return translate(
        'localWorkflow.preset.councilDescription',
        'Ask several AIs one question; get one combined answer'
      )
    case 'discover':
      return translate(
        'localWorkflow.preset.discoverDescription',
        'Find real problems in code or documents, and check the important ones'
      )
  }
}

/**
 * The preset's icon component, for a row that sizes and weights its own icons (the sidebar
 * nav). Everywhere else draws it with WorkflowPresetIcon; both read the same table.
 */
export function workflowPresetIconComponent(preset: WorkflowKind): LucideIcon {
  return presetIcon(preset)
}

/** The only way to draw a workflow preset icon, so every surface shows the same one. */
export function WorkflowPresetIcon({
  preset,
  className
}: {
  preset: WorkflowKind
  className?: string
}) {
  const iconClassName = cn('size-4 shrink-0', className)
  switch (preset) {
    case 'audit':
      return <ClipboardCheck aria-hidden="true" className={iconClassName} />
    case 'custom':
      return <Workflow aria-hidden="true" className={iconClassName} />
    case 'best-of-n':
      return <Trophy aria-hidden="true" className={iconClassName} />
    case 'improve':
      return <TrendingUp aria-hidden="true" className={iconClassName} />
    case 'find':
      return <Crown aria-hidden="true" className={iconClassName} />
    case 'decide':
      return <Scale aria-hidden="true" className={iconClassName} />
    case 'investigate':
      return <Microscope aria-hidden="true" className={iconClassName} />
    case 'quick-discover':
      return <Zap aria-hidden="true" className={iconClassName} />
    case 'build-review':
      return <Wrench aria-hidden="true" className={iconClassName} />
    case 'evolve':
      return <Dna aria-hidden="true" className={iconClassName} />
    case 'council':
      return <UsersRound aria-hidden="true" className={iconClassName} />
    case 'discover':
      return <ScanSearch aria-hidden="true" className={iconClassName} />
  }
}
