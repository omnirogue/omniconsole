import type { AutomationTemplate } from './automation-templates'
import { translate } from '@/i18n/i18n'

export function builtInAutomationTemplates(): AutomationTemplate[] {
  const templates: AutomationTemplate[] = [
    {
      id: 'email-triage',
      category: translate('routines.templates.email-triage.category', 'Personal'),
      label: translate('routines.templates.email-triage.name', 'Email triage'),
      name: translate('routines.templates.email-triage.name', 'Email triage'),
      description: translate(
        'routines.templates.email-triage.description',
        'Categorize your inbox and draft responses.'
      ),
      preset: 'weekdays',
      time: '11:00',
      connectorPresets: ['email'],
      prompt: translate(
        'routines.templates.email-triage.prompt',
        `Review my inbox for new and unread emails. For each email:
1. Categorize into: Urgent, Action Needed, FYI, or Low Priority
2. Summarize the key point in one sentence
3. Draft a response for any emails marked Urgent or Action Needed
Present results grouped by category, with Urgent items first. For drafted responses, keep the tone professional and concise. If the inbox is empty or all caught up, confirm that briefly.`
      )
    },
    {
      id: 'briefing',
      category: translate('routines.templates.briefing.category', 'Personal'),
      label: translate('routines.templates.briefing.name', 'Briefing'),
      name: translate('routines.templates.briefing.name', 'Briefing'),
      description: translate(
        'routines.templates.briefing.description',
        'Catch up on meetings, messages, and action items.'
      ),
      preset: 'weekdays',
      time: '08:30',
      connectorPresets: ['calendar', 'email', 'slack', 'hub-tasks'],
      prompt: translate(
        'routines.templates.briefing.prompt',
        `Generate a briefing to help me catch up. Include:
1. Schedule — List upcoming meetings and events with times, attendees, and any preparation needed
2. Important emails — Summarize unread emails that need attention, grouped by urgency
3. Messages requiring response — Flag any direct messages or mentions that need a reply
4. Action items — List any pending tasks or follow-ups from recent activity
Keep the briefing concise and scannable. If there's nothing notable in a section, skip it rather than saying "nothing to report."`
      )
    },
    {
      id: 'issue-triage',
      category: translate('routines.templates.issue-triage.category', 'Engineering'),
      label: translate('routines.templates.issue-triage.name', 'Issue triage'),
      name: translate('routines.templates.issue-triage.name', 'Issue triage'),
      description: translate(
        'routines.templates.issue-triage.description',
        'Prioritize and categorize new project issues.'
      ),
      preset: 'weekdays',
      time: '11:30',
      connectorPresets: ['github', 'hub-board'],
      prompt: translate(
        'routines.templates.issue-triage.prompt',
        `Review new and unassigned issues across connected project trackers. For each issue:
1. Categorize as: Bug, Feature Request, Improvement, or Question
2. Assess priority based on content: Critical, High, Medium, or Low
3. Suggest assignment if the issue clearly relates to a specific team or area
4. Flag duplicates if similar issues already exist
Present a summary table of all triaged issues, then detailed notes for Critical and High priority items. If there are no new issues, confirm briefly.`
      )
    },
    {
      id: 'dependency-update-check',
      category: translate('routines.templates.dependency-update-check.category', 'Engineering'),
      label: translate(
        'routines.templates.dependency-update-check.name',
        'Dependency update check'
      ),
      name: translate('routines.templates.dependency-update-check.name', 'Dependency update check'),
      description: translate(
        'routines.templates.dependency-update-check.description',
        'Check updates, breaking changes, and security advisories.'
      ),
      preset: 'weekly',
      time: '14:30',
      dayOfWeek: '1',
      repositoryRequired: true,
      prompt: translate(
        'routines.templates.dependency-update-check.prompt',
        `Check all dependencies in the connected repositories for available updates. For each outdated dependency:
1. Current version vs latest version
2. Update type — major, minor, or patch
3. Breaking changes noted in changelogs
4. Security advisories — any known CVEs or vulnerabilities
Prioritize security-related updates. Group results by repository and severity. If everything is up to date, confirm briefly.`
      )
    },
    {
      id: 'system-health-check',
      category: translate('routines.templates.system-health-check.category', 'Operations'),
      label: translate('routines.templates.system-health-check.name', 'System health check'),
      name: translate('routines.templates.system-health-check.name', 'System health check'),
      description: translate(
        'routines.templates.system-health-check.description',
        'Review incidents, errors, and performance anomalies.'
      ),
      preset: 'daily',
      time: '08:00',
      connectorPresets: ['monitoring'],
      notify: {
        onFinish: true,
        onlyWhenNotable: true,
        channels: [{ kind: 'desktop' }, { kind: 'slack-dm' }]
      },
      prompt: translate(
        'routines.templates.system-health-check.prompt',
        `Perform a health check across connected monitoring services. Report:
1. Active incidents — Any ongoing outages or incidents with severity and status
2. Errors and warnings — New errors or warning patterns since the last check
3. Performance anomalies — Unusual latency, error rates, or resource usage
4. Resolved items — Incidents or alerts that were resolved since the last check
Prioritize by severity. For each issue, include the service affected and a direct link if available. If all systems are healthy, confirm with a brief "All systems nominal" message.`
      )
    },
    {
      id: 'flaky-test-tracker',
      category: translate('routines.templates.flaky-test-tracker.category', 'Engineering'),
      label: translate('routines.templates.flaky-test-tracker.name', 'Flaky test tracker'),
      name: translate('routines.templates.flaky-test-tracker.name', 'Flaky test tracker'),
      description: translate(
        'routines.templates.flaky-test-tracker.description',
        'Find flaky tests and propose a targeted fix.'
      ),
      preset: 'weekly',
      time: '12:00',
      dayOfWeek: '1',
      repositoryRequired: true,
      connectorPresets: ['github'],
      tools: { skills: [], mcpServers: [], allowWrite: true },
      prompt: translate(
        'routines.templates.flaky-test-tracker.prompt',
        `Identify flaky tests — tests that both passed and failed on the same code over the past week.
1. Pull CI workflow runs from the last 7 days on the default branch. Focus on test jobs.
2. For each test failure, note the test name, file, and the commit it ran against. A test is flaky if it failed on a commit where the same test also passed (in a retry, a re-run, or a later run on the same SHA).
3. Rank flaky tests by flake rate (failures ÷ total runs) and total time wasted on retries.
4. For the top 5, include: test name and file path, flake rate, a link to one failing and one passing run on the same commit, and the failure message pattern if it's consistent.
5. Note any tests that are newly flaky this week vs. ones that appeared in last week's report.
6. For the #1 flakiest test, attempt a fix: read the test and the code it exercises, identify the likely cause (race condition, unawaited promise, time/order dependence, shared state, network reliance), apply a targeted fix, verify it passes locally across several runs, and open a pull request titled "fix(flaky): <test name>" with the root-cause analysis in the description. If you can't determine a safe fix, open a draft PR that quarantines the test (skip with a comment linking this report) instead.
Present as a ranked table followed by per-test detail, then a link to the fix PR. If no flaky tests are found, confirm briefly.`
      )
    },
    {
      id: 'release-notes-drafter',
      category: translate('routines.templates.release-notes-drafter.category', 'Engineering'),
      label: translate('routines.templates.release-notes-drafter.name', 'Release notes drafter'),
      name: translate('routines.templates.release-notes-drafter.name', 'Release notes drafter'),
      description: translate(
        'routines.templates.release-notes-drafter.description',
        'Draft a concise release note for a merged pull request.'
      ),
      preset: 'daily',
      time: '17:00',
      repositoryRequired: true,
      connectorPresets: ['github'],
      trigger: { kind: 'pull-request', event: 'closed' },
      tools: { skills: [], mcpServers: [], allowWrite: true },
      prompt: translate(
        'routines.templates.release-notes-drafter.prompt',
        `A pull request was just merged to the main branch. Draft a release-notes entry for it.
1. Read the PR title, description, and diff. Identify the user-visible change — a new feature, a bug fix, a breaking change, or an internal-only refactor.
2. If the change is internal-only (tests, CI, build tooling, comments, dead-code removal, pure refactors), stop and post a comment saying "Internal change — no release note." Do not draft an entry for these.
3. Otherwise, draft a one-paragraph entry written for end users, not contributors. Use the imperative voice. Avoid jargon and internal codenames. Do not mention file paths, function names, or commit SHAs.
4. Classify the entry under one of: New, Improved, Fixed, or Breaking.
5. If this is a breaking change, explicitly list what users need to do to migrate.
6. Post the draft as a PR comment. Include a one-line "suggested changelog location" hint if the repo has an obvious CHANGELOG.md or docs/changelog path.
Keep drafts short — 2 to 4 sentences. Long release notes don't get read.`
      )
    }
  ]
  return templates.map((template) => ({
    outputFormat: 'markdown',
    delivery: [{ kind: 'chat' }],
    notify: { onFinish: true, onlyWhenNotable: true, channels: [{ kind: 'desktop' }] },
    trigger: { kind: 'schedule' },
    ...template
  }))
}
