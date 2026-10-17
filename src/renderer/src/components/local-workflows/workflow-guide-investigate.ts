import { translate } from '@/i18n/i18n'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import type { WorkflowGuide } from './workflow-guide'

/** Investigate in plain words. No run has been timed yet, so it gives the most AI calls, not a time. */
export function investigateGuide(): WorkflowGuide {
  const calls = String(planWorkflowCalls(workflowTemplate('investigate')).agentTotal)
  return {
    what: translate(
      'localWorkflow.guide.investigate.what',
      'Answers a question with evidence. You ask something; three AIs look into it separately, each from a different angle, and the answer says what is true, what conflicts and what is still open, with where each piece of evidence is.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.investigate.when1',
        'When you need to know how something really works, such as how a part of your code fits together'
      ),
      translate(
        'localWorkflow.guide.investigate.when2',
        'For an audit, such as "did this get worse since last month?"'
      ),
      translate(
        'localWorkflow.guide.investigate.when3',
        'For background on competitors, a market or a scientific topic'
      )
    ],
    steps: [
      translate(
        'localWorkflow.guide.investigate.step1',
        'It splits your question into three different angles.'
      ),
      translate(
        'localWorkflow.guide.investigate.step2',
        'Three AIs, from different makers where you have them, each look into one angle alone and note what they find, quoting the file and line or the source.'
      ),
      translate(
        'localWorkflow.guide.investigate.step3',
        'One AI puts it together: what holds, what conflicts and what is open.'
      ),
      translate(
        'localWorkflow.guide.investigate.step4',
        'A fact-checker opens the quoted evidence again, and a skeptic looks for claims that go too far or angles nobody looked at.'
      ),
      translate(
        'localWorkflow.guide.investigate.step5',
        'The final answer ends with a table of the key claims: confirmed, refuted or open.'
      ),
      translate(
        'localWorkflow.guide.investigate.pages',
        'You can also list web pages for the three AIs to read. The app reads each page once before they start and keeps a copy; they quote the pages but never do what a page says, and a claim from a page counts as confirmed only when the app found its quote there.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.investigate.youGet',
      'An answer with a table of the key claims. A claim is marked confirmed only when the fact-checker agreed and its evidence is named; anything that could not be checked is marked open. It uses at most {{calls}} AI calls; we have not timed a full run yet.',
      { calls }
    )
  }
}
