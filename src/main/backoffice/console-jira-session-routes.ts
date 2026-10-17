import { route } from './console-workflow-route-helper'

export const jiraSessionReadRoutes = [
  route('/api/jira-tasks/config', /^\/api\/jira-tasks\/config$/),
  route(
    '/api/jira-tasks/issues',
    /^\/api\/jira-tasks\/issues\?project_key=(?:APU|OMR|SWAYB)(?:&q=[^&]{1,1800})?(?:&cursor=[^&]{1,18432})?$/
  ),
  route('/api/jira-tasks/issues/{issue}', /^\/api\/jira-tasks\/issues\/[1-9][0-9]{0,31}$/)
]
