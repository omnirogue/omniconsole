import { describe, expect, it } from 'vitest'
import { hardStopOf, pausesAds, type HardStopCategory } from './next-step-keep-going-hard-stops'

const HITS: Record<HardStopCategory, string[]> = {
  'ad-spend': [
    'Switch the TikTok campaign back on',
    'Re-enable the paused ad sets',
    'Turn on more qualifying ads at their existing budgets',
    'Unpause ad 12',
    'Resume the Instagram ads',
    'Activate the new ad set',
    'Reactivate ad group 7',
    'Unarchive the old Facebook campaigns',
    'Scale the winning ad set by 20%',
    'Ad set 4 should be turned back on Monday',
    'Raise the SD25 daily budget to $300',
    'Lower the lifetime budget on the retargeting campaign',
    'Increase the campaign budget by 20%',
    'Cut the ad set budget in half',
    'Change the bid cap to $40',
    'Set a spend limit of $500 on the account',
    'Increase the budget on the Meta campaign',
    'Double the budget for SD25 ads',
    'Adjust the bids in Google Ads',
    'Reduce spend on TikTok',
    'Daily budget $100 -> $150',
    'Budget increase for the winning campaign',
    // Pausing one thing and raising another's spend is spend.
    'Pause ad set 4 and raise the SD25 daily budget to $300',
    'Pause the losing ads, then turn the winning ad sets back on'
  ],
  // Sal: "we dont pause campaigns, we pause adsets".
  'ad-campaign-pause': [
    'Pause the SD25 Meta campaign',
    'Stop the Google Ads campaign',
    'Archive the old Facebook campaigns',
    'Shut down the TikTok campaign',
    'Turn the retargeting campaign off',
    'The SD25 campaign should be paused tonight',
    'Pause the whole ad account'
  ],
  // OmniRogue Enterprise is flag-only.
  'ad-enterprise': [
    'Pause the Enterprise webinar ad set',
    'Turn off the OmniRogue Enterprise ads',
    'Pause ad set 3 in the webinar campaign',
    'Pause the Enterprise campaign',
    'The WebinarJam retargeting ad set should be paused'
  ],
  'ad-pause': [
    'Pause ad set 4 in SD25',
    'Turn off all ads in SD25',
    'Turn the losing ad sets off',
    'Disable the underperforming ads',
    'Deactivate ad group 7',
    'Kill the losing ad sets',
    'Pause all ads in the SD25 campaign',
    'Pause ad set 4 in the DTC spring campaign',
    'Ad set 4 should be paused until Monday'
  ],
  deploy: [
    'Deploy the change to omni-dev',
    'Cut a release of the desktop app',
    'Publish the package to npm',
    'Ship it',
    'Roll this out to everyone',
    'Check the production logs after the fix',
    'Try it on staging'
  ],
  'shared-branch': [
    'Push this to main',
    'git push origin main-next',
    'Merge the branch into omni-brand',
    'Merge the PR',
    'Force-push the rebased branch',
    'git push --force-with-lease',
    'git push origin +feature',
    'Delete the old feature branch',
    'git branch -D stale',
    'git push origin --delete old-branch',
    'git tag -d v1.2.0',
    'Push to release/1.6'
  ],
  'delete-data': [
    'Delete the test database',
    'Drop the users table',
    'Remove the old backups',
    'Wipe the S3 bucket',
    'Clean up untracked files',
    'Delete everything in the output folder',
    'Remove ~/Library/Caches/omni',
    'Delete the files on the Desktop',
    'rm -rf node_modules',
    'Run git clean -fdx',
    'find . -name "*.log" -delete',
    'Truncate the records'
  ],
  history: [
    'git reset --hard origin/main',
    'Rebase onto main and resolve conflicts',
    'Run git filter-repo to drop the large file',
    'Amend the pushed commit',
    'git stash drop',
    'Rewrite the history to squash commits'
  ],
  send: [
    'Send an email to the customer',
    'Message the team on Slack',
    'Reply to the reviewer',
    'Notify Sal when done',
    'Post it publicly',
    'Comment on the PR with the results',
    'Upload the logs to the shared drive',
    'rsync the logs to backup@host:/srv'
  ],
  payment: [
    'Refund the customer',
    'Charge the card again',
    'Update the Stripe subscription',
    'Send the invoice',
    'Buy more CI minutes',
    'Fix the billing page'
  ],
  credentials: [
    'Rotate the API key',
    'Print the token to check it',
    'Update the password',
    'Add my key to authorized_keys',
    'Run it with sudo',
    'Give the service admin rights',
    'chmod 777 the folder',
    'Make it writable by everyone',
    'Fix the .npmrc registry entry'
  ]
}

// Ordinary development steps Keep going runs without asking (Sal, 2026-09-23).
const NORMAL = [
  'Commit the change',
  'Install the missing dependency',
  'Update the tsconfig',
  'Remove the unused import',
  'Run pnpm test',
  'Push the feature branch',
  'Open a PR for this',
  'Run the migrations locally',
  'Add a regression test for the parser',
  'Fix the failing assertion in parser.test.ts',
  'Run the full test suite and report failures',
  'Review the diff for missed callers',
  'Refactor the lexer into smaller functions',
  'Rename the helper to say what it does',
  'Add logging around the retry loop',
  'Fix the type error in settings.ts',
  'Write docs for the new setting',
  'Clean up the lint warnings',
  'Delete the unused helper function',
  'Update the README with the new flag',
  'Bump the dependency version',
  'Merge main into this feature branch',
  'Rebase this branch on the feature work',
  'Fix the email validation in signup.ts',
  'Update the error message the parser prints',
  'Change the text the button shows',
  'Set up the environment for the tests',
  // Ad work that changes no delivery or budget.
  'Read the ads report for SD25',
  'Summarize campaign results for last week',
  'Draft ad copy for the new offer',
  'Write ads for the spring launch',
  'Do an ad creative review',
  'Add the address field to the form',
  'Load the page and download the CSV',
  'Look up the SD25 daily budget and cost per lead',
  'Compare the ad set budgets across campaigns',
  'Check which ads were paused yesterday',
  'Pull the Meta campaign metrics for the last 7 days',
  // Budgets, pauses and toggles in code.
  'Increase the retry budget for the summarizer',
  'Raise the bundle size budget to 250 kB',
  'Pause the video on hover',
  'Stop the dev server',
  'Disable the lint rule for this file',
  'Turn off the feature flag in tests',
  'Archive the old logs',
  'Disable the ad blocker check',
  'Stop after summarizing campaign results',
  // Enterprise work that pauses nothing.
  'Draft Enterprise ad copy for the webinar',
  'Summarize the Enterprise webinar results',
  'Flag the Enterprise ad set with the high CPA for Sal'
]

// The independent review's misses (round 4), as complete instructions.
const REVIEW_MISSES: [string, HardStopCategory][] = [
  ['Run `gh pr merge --squash` once CI is green', 'shared-branch'],
  ['gh pr merge 123 --merge --delete-branch', 'shared-branch'],
  ['Switch to main and merge the feature branch', 'shared-branch'],
  ['git checkout main && git merge feat/parser', 'shared-branch'],
  ['Check out main-next, then merge this work into it', 'shared-branch'],
  ['Run `git rebase origin/main`', 'history'],
  ['git rebase -i HEAD~3 to tidy the commits', 'history'],
  ['Remove `/tmp/customer-export.csv` after importing it', 'delete-data'],
  ['Delete "~/Downloads/report.pdf" when done', 'delete-data'],
  ["Delete '../shared-fixtures/cache.json'", 'delete-data'],
  ['Show the contents of `.env.local` to check the port', 'credentials'],
  ['cat .env', 'credentials'],
  ['Run `printenv` and look for the port', 'credentials'],
  ['Run export -p to see what is set', 'credentials'],
  ['Inspect the environment variables for the proxy', 'credentials'],
  ['Print the environment', 'credentials'],
  ['Email Dana the summary', 'send'],
  ['Message @oncall with the failure', 'send'],
  ['Text the team the test results', 'send'],
  ['Ping Uma about the flaky test', 'send'],
  ['DM them the results', 'send'],
  ['Reply to Josh with the fix', 'send'],
  ['Run `gh pr comment 42 --body "done"`', 'send'],
  ['gh issue comment 7 --body ok', 'send'],
  ['gh pr review 42 --comment -b "looks good"', 'send'],
  ['git send-email the patch series', 'send'],
  ['Post the results to the team webhook', 'send'],
  ['Post a summary to the chat', 'send'],
  ['kubectl apply -f k8s/deployment.yaml', 'deploy'],
  ['kubectl rollout restart deploy/api', 'deploy'],
  ['kubectl set image deploy/api api=img:2', 'deploy'],
  ['helm upgrade api ./chart', 'deploy'],
  ['helm install api ./chart', 'deploy'],
  ['terraform apply -auto-approve', 'deploy'],
  ['docker push ghcr.io/acme/api:2', 'deploy'],
  ['fly deploy', 'deploy'],
  ['vercel --prod', 'deploy'],
  ['netlify deploy --prod', 'deploy'],
  ['serverless deploy', 'deploy'],
  ['aws cloudformation deploy --template-file t.yaml', 'deploy'],
  ['gcloud app deploy', 'deploy']
]

describe('hardStopOf', () => {
  it.each(REVIEW_MISSES)('stops the review miss %j', (text, category) => {
    expect(hardStopOf(text)?.category).toBe(category)
  })

  // Every hit stops under the strictest setting; only an ad pause depends on it.
  for (const [category, texts] of Object.entries(HITS) as [HardStopCategory, string[]][]) {
    it.each(texts)(`stops %j as ${category}`, (text) => {
      expect(hardStopOf(text, 'ask-first')).toEqual({ category, reason: `needs-you-${category}` })
      if (category !== 'ad-pause') {
        expect(hardStopOf(text)).toEqual({ category, reason: `needs-you-${category}` })
      }
    })
  }

  it.each(HITS['ad-pause'])('lets the ad pause %j run by default', (text) => {
    expect(hardStopOf(text)).toBeNull()
    expect(hardStopOf(text, 'allowed')).toBeNull()
    expect(pausesAds(text)).toBe(true)
  })

  it.each(HITS['ad-spend'])('never reads the spend change %j as a pause', (text) => {
    expect(pausesAds(text)).toBe(false)
  })

  it('still stops another hard stop in a step that also pauses ads', () => {
    expect(hardStopOf('Pause ad set 4 and deploy the landing page')?.category).toBe('deploy')
    expect(hardStopOf('Pause ad set 4 and email the team')?.category).toBe('send')
  })

  it.each(NORMAL)('lets %j run', (text) => {
    expect(hardStopOf(text)).toBeNull()
    expect(hardStopOf(text, 'ask-first')).toBeNull()
    expect(pausesAds(text)).toBe(false)
  })

  it('keeps pushing a feature branch and opening a PR allowed: only shared branches stop it', () => {
    expect(hardStopOf('Push the feature branch')).toBeNull()
    expect(hardStopOf('git push -u origin feat/parser-0923')).toBeNull()
    expect(hardStopOf('Open a PR for this')).toBeNull()
    expect(hardStopOf('Push the feature branch to main')?.category).toBe('shared-branch')
  })
})
