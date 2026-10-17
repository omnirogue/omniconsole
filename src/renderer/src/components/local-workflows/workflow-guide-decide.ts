import { translate } from '@/i18n/i18n'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import type { WorkflowGuide } from './workflow-guide'

/** Decide in plain words. No run has been timed yet, so it gives the most AI calls, not a time. */
export function decideGuide(): WorkflowGuide {
  const calls = String(planWorkflowCalls(workflowTemplate('decide')).agentTotal)
  return {
    what: translate(
      'localWorkflow.guide.decide.what',
      'Helps you make a choice. You describe the decision; it gathers many options, works out the most promising few in detail, compares them point by point and recommends one, saying what you give up and when you would switch.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.decide.when1',
        'When you face a real choice with trade-offs, such as a tool, a supplier or a plan'
      ),
      translate(
        'localWorkflow.guide.decide.when2',
        'When you want options you might not think of, and the reasons for and against each'
      )
    ],
    steps: [
      translate(
        'localWorkflow.guide.decide.step1',
        'It writes down the decision, the limits any choice must meet, and what a good choice looks like.'
      ),
      translate(
        'localWorkflow.guide.decide.step2',
        'Two different AIs suggest about a dozen options each, including unusual ones.'
      ),
      translate(
        'localWorkflow.guide.decide.step3',
        'It keeps a short, varied list and works each option out: how it works, its costs and risks, and what must be true for it to be best.'
      ),
      translate(
        'localWorkflow.guide.decide.step4',
        'It compares them point by point, and names the deciding question when the top two are close.'
      ),
      translate(
        'localWorkflow.guide.decide.step5',
        'It writes a recommendation, checks it against the best option and against your limits, and says plainly if nothing passed.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.decide.youGet',
      'A recommendation with the reasons, what you give up, when you would switch, and the cheapest next test, marked with how far it was checked. It uses at most {{calls}} AI calls; we have not timed a full run yet.',
      { calls }
    )
  }
}
