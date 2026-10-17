import { translate } from '@/i18n/i18n'
import type { WorkflowKind } from './workflow-presets'
import { decideGuide } from './workflow-guide-decide'
import { evolveGuide } from './workflow-guide-evolve'
import { investigateGuide } from './workflow-guide-investigate'
import { quickDiscoverGuide } from './workflow-guide-quick-discover'
import { auditGuide } from './workflow-guide-audit'

/**
 * What each workflow does, in words for someone who has never used AI: no model names, no
 * method names. Shown as "How this works" before a run starts. A time is given only where runs
 * were measured.
 */
export type WorkflowGuide = {
  what: string
  useWhen: string[]
  steps: string[]
  youGet: string
  time?: string
}

function discover(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.discover.what',
      'Looks for real problems in your code or documents. Other AIs try to disprove the most important findings, and the report ranks what holds up, with anything not checked listed separately.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.discover.when1',
        'Before a release, to catch the bugs you missed'
      ),
      translate(
        'localWorkflow.guide.discover.when2',
        'When you take over code and want to know its risks'
      ),
      translate(
        'localWorkflow.guide.discover.when3',
        'To check a document or plan for gaps and mistakes'
      )
    ],
    steps: [
      translate(
        'localWorkflow.guide.discover.step1',
        'It first sets out what to look for and what evidence a finding needs.'
      ),
      translate(
        'localWorkflow.guide.discover.step2',
        'Several AIs search, each from a different angle.'
      ),
      translate(
        'localWorkflow.guide.discover.step3',
        'Other AIs try to disprove the most important findings; doubtful ones get extra checks, within the run’s limits.'
      ),
      translate('localWorkflow.guide.discover.step4', 'A final report ranks what held up.'),
      translate(
        'localWorkflow.guide.discover.pages',
        'You can also list web pages for it to read. The app reads each page once before the search and keeps a copy; the AIs quote the pages but never do what a page says. With pages, you choose how each finding is scored: by general questions or by your own.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.discover.youGet',
      'A ranked list of problems, each with where it is, why it matters and a next step. Tick the ones you want and start a session to fix them.'
    ),
    time: translate(
      'localWorkflow.guide.discover.time',
      'A full run on a large codebase took about 3 hours in our tests.'
    )
  }
}

function council(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.council.what',
      'Several AIs answer your question separately. Their answers are compared with the names hidden, then one AI combines the strongest parts.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.council.when1',
        'When you want a second opinion on a decision'
      ),
      translate(
        'localWorkflow.guide.council.when2',
        'For a question where different AIs might disagree'
      ),
      translate('localWorkflow.guide.council.when3', 'To check an answer before you rely on it')
    ],
    steps: [
      translate('localWorkflow.guide.council.step1', 'Each AI answers on its own.'),
      translate(
        'localWorkflow.guide.council.step2',
        'The answers are compared with the names hidden.'
      ),
      translate(
        'localWorkflow.guide.council.step3',
        'One AI writes the final answer from the best parts.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.council.youGet',
      'One answer that draws on every AI, plus each answer and how it was rated.'
    ),
    time: translate('localWorkflow.guide.council.time', 'About a minute in our tests.')
  }
}

function improve(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.improve.what',
      'Makes a piece of work better, round after round. AIs write improved versions, judges keep the best, and it stops when more rounds stop helping.'
    ),
    useWhen: [
      translate('localWorkflow.guide.improve.when1', 'To polish a draft, an email or an ad'),
      translate('localWorkflow.guide.improve.when2', 'To strengthen a prompt or a plan'),
      translate(
        'localWorkflow.guide.improve.when3',
        'To improve code against a test or check you give it'
      )
    ],
    steps: [
      translate('localWorkflow.guide.improve.step1', 'First versions are written.'),
      translate(
        'localWorkflow.guide.improve.step2',
        'Judges compare them without knowing who wrote which, and keep the best.'
      ),
      translate(
        'localWorkflow.guide.improve.step3',
        'New versions try to beat the one being kept.'
      ),
      translate(
        'localWorkflow.guide.improve.step4',
        'It stops when repeated attempts bring nothing better, when your check passes (if you set one), or at the round limit.'
      ),
      translate(
        'localWorkflow.guide.improve.step5',
        'If you ask for predictions, each version must first say what your test will show. A version whose prediction is wrong is dropped before judging.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.improve.youGet',
      'The best version found, and a short history of each round: what changed and why the winner was kept.'
    )
  }
}

function find(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.find.what',
      'Picks the best from many options: ideas it comes up with, a few complete versions, or a list you give it.'
    ),
    useWhen: [
      translate('localWorkflow.guide.find.when1', 'To choose a tool, library or supplier'),
      translate(
        'localWorkflow.guide.find.when2',
        'To pick the strongest of many ideas or headlines'
      ),
      translate('localWorkflow.guide.find.when3', 'To rank a list you already have')
    ],
    steps: [
      translate('localWorkflow.guide.find.step1', 'It gathers the options, or takes your list.'),
      translate('localWorkflow.guide.find.step2', 'A quick scoring pass keeps the promising ones.'),
      translate(
        'localWorkflow.guide.find.step3',
        'The shortlist is compared more closely to choose a winner.'
      ),
      translate('localWorkflow.guide.find.step4', 'You get the winner and the runners-up.')
    ],
    youGet: translate(
      'localWorkflow.guide.find.youGet',
      'A shortlist with scores, the winner and why it won. Next you can improve the winner or combine the best ones.'
    )
  }
}

function bestOfN(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.bestOfN.what',
      'Several AIs each make their own version of the same thing, and judges pick the best one.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.bestOfN.when1',
        'When there are many good ways to do something'
      ),
      translate(
        'localWorkflow.guide.bestOfN.when2',
        'For creative work such as names, taglines or designs'
      )
    ],
    steps: [
      translate('localWorkflow.guide.bestOfN.step1', 'Each AI makes its own version.'),
      translate('localWorkflow.guide.bestOfN.step2', 'Judges compare them with the names hidden.'),
      translate('localWorkflow.guide.bestOfN.step3', 'The best one is shown first.')
    ],
    youGet: translate(
      'localWorkflow.guide.bestOfN.youGet',
      'The winning version, with every version and how it was rated.'
    )
  }
}

function buildReview(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.buildReview.what',
      'One AI changes your project. Other AIs review the changes, and the builder deals with what they find. This repeats until they approve or the run reaches its limit.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.buildReview.when1',
        'For a code change you want checked before you accept it'
      ),
      translate(
        'localWorkflow.guide.buildReview.when2',
        'For a fix that must not break anything else'
      )
    ],
    steps: [
      translate(
        'localWorkflow.guide.buildReview.step1',
        'The builder makes the change and runs the checks.'
      ),
      translate(
        'localWorkflow.guide.buildReview.step2',
        'Reviewers read the change and look for problems, with evidence.'
      ),
      translate('localWorkflow.guide.buildReview.step3', 'The builder fixes what they found.'),
      translate(
        'localWorkflow.guide.buildReview.step4',
        'It repeats until the reviewers approve, or it reaches its limit.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.buildReview.youGet',
      'The changes in the workspace you chose, what the reviewers found and the evidence, and whether they approved.'
    )
  }
}

function custom(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.custom.what',
      'Describe the steps you want in your own words. You can build the plan and look at it first, or enter a task and run it straight away.'
    ),
    useWhen: [
      translate('localWorkflow.guide.custom.when1', 'When none of the other workflows fits'),
      translate('localWorkflow.guide.custom.when2', 'To try a new way of working with several AIs')
    ],
    steps: [
      translate('localWorkflow.guide.custom.step1', 'Describe what you want done, and how.'),
      translate('localWorkflow.guide.custom.step2', 'Check the diagram of steps it builds.'),
      translate('localWorkflow.guide.custom.step3', 'Start it and follow each step.')
    ],
    youGet: translate(
      'localWorkflow.guide.custom.youGet',
      'What your last step produces, with every step’s work there to look at.'
    )
  }
}

export function workflowGuide(kind: WorkflowKind): WorkflowGuide {
  switch (kind) {
    case 'audit':
      return auditGuide()
    case 'discover':
      return discover()
    case 'council':
      return council()
    case 'improve':
      return improve()
    case 'find':
      return find()
    case 'best-of-n':
      return bestOfN()
    case 'build-review':
      return buildReview()
    case 'evolve':
      return evolveGuide()
    case 'custom':
      return custom()
    case 'decide':
      return decideGuide()
    case 'investigate':
      return investigateGuide()
    case 'quick-discover':
      return quickDiscoverGuide()
  }
}
