import { boardDeliveryPostRoutes } from './console-board-delivery-routes'
import { routineAlertRoutes } from './console-routine-alert-routes'
import { jiraSessionReadRoutes } from './console-jira-session-routes'
/**
 * Every route the signed-person transport may reach, as the concrete path shape it
 * permits. Deny by default: a client method whose path is not here is refused before
 * any request is made, which is a silent failure if nothing asserts the URL — so every
 * read and write has a client test naming its path.
 *
 * Each entry carries the path TEMPLATE beside its pattern. The template is what the
 * route catalog is checked against: a pattern alone is unreadable to a reviewer and
 * unmatchable by a gate, so an activated route with no catalog entry — or a catalog
 * entry marked activated with no route here — fails CI rather than drifting quietly.
 */
import { route, type AllowedRoute } from './console-workflow-route-helper'
import { routineConversationRoutes } from './console-routine-conversation-routes'
import { teamRoutineRoutes } from './console-team-routines-routes'
import { calendarRoutes } from './console-calendar-routes'
import { accessRoutes } from './console-access-routes'
import { browserLoginGetRoutes, browserLoginPostRoutes } from './console-browser-logins-routes'
import { sessionPeerRoutes } from './console-session-peers-routes'
import { desktopPublicationRoutes } from './console-desktop-publication-routes'
import { waitRoutes } from './console-waits-routes'
import { taskDependencyRoutes } from './console-task-dependency-routes'
import { taskFileRoutes } from './console-task-file-routes'
import { advertisingActionRoutes } from './console-advertising-actions-routes'
import { advertisingReadRoutes } from './console-advertising-read-routes'

export type { AllowedRoute } from './console-workflow-route-helper'

export const routes: Record<'GET' | 'POST' | 'PATCH' | 'DELETE', AllowedRoute[]> = {
  GET: [
    route(
      '/api/customer-service/session-launches/{launch_id}',
      /^\/api\/customer-service\/session-launches\/csl_[a-f0-9]{32}$/
    ),
    ...routineAlertRoutes.GET,
    ...advertisingActionRoutes.GET,
    ...jiraSessionReadRoutes,
    ...teamRoutineRoutes.GET,
    ...routineConversationRoutes.GET,
    ...calendarRoutes.GET,
    route(
      '/api/gtd/hub/api/sessions/{session_id}',
      /^\/api\/gtd\/hub\/api\/sessions\/ses_[A-Za-z0-9]{4,64}$/
    ),
    route(
      '/api/team/tasks/{task_id}/agent-context',
      /^\/api\/team\/tasks\/btk_[A-Za-z0-9]{4,64}\/agent-context$/
    ),
    route(
      ['/api/gtd/hub/api/board/{task_id}/drive', '/api/gtd/hub/api/board/{task_id}/drive/intakes'],
      /^\/api\/gtd\/hub\/api\/board\/btk_[A-Za-z0-9]{4,64}\/drive(?:\/intakes)?$/
    ),
    route('/api/communication/config', /^\/api\/communication\/config$/),
    ...sessionPeerRoutes,
    ...desktopPublicationRoutes.GET,
    ...waitRoutes.GET,
    route(
      '/api/gtd/hub/api/team/tasks/{task_id}/events',
      /^\/api\/gtd\/hub\/api\/team\/tasks\/btk_[A-Za-z0-9]{4,64}\/events$/
    ),
    route('/api/board/{task_id}/lifecycle', /^\/api\/board\/btk_[A-Za-z0-9]{4,64}\/lifecycle$/),
    route('/api/sessions', /^\/api\/sessions$/),
    route('/api/sessions/{ledger_id}', /^\/api\/sessions\/als_[a-f0-9]{24}$/),
    route('/api/work/board-all', /^\/api\/work\/board-all$/),
    ...taskFileRoutes.GET,
    route('/api/gtd/workflow-dispatch-inventory', /^\/api\/gtd\/workflow-dispatch-inventory$/),
    route(
      [
        '/api/gtd/workflow-tasks/{task_id}/context',
        '/api/gtd/workflow-tasks/{task_id}/reconciliation-capabilities'
      ],
      /^\/api\/gtd\/workflow-tasks\/btk_[A-Za-z0-9]{4,64}\/(?:context|reconciliation-capabilities)$/
    ),
    route(
      '/api/gtd/jobs/{job_id}/log',
      /^\/api\/gtd\/jobs\/job_[a-z0-9]{8,40}\/log(?:\?attempt=\d+)?$/
    ),
    route(
      '/api/gtd/jobs/{job_id}/evidence',
      /^\/api\/gtd\/jobs\/job_[a-z0-9]{8,40}\/evidence\?(?:attempt=\d+&)?(?:lease_generation=\d+&)?after=\d+&limit=\d+(?:&kind=(?:input|provider_event|output|status))?$/
    ),
    // Why: exactly the queue shapes the client builds (received, or the reader's own sent
    // requests, plus an opaque page cursor); an assignee or any other parameter stays refused.
    route(
      '/api/gtd/hub/api/handoffs',
      /^\/api\/gtd\/hub\/api\/handoffs\?(?:view=attention|state=(?:open|replied|resolved)|view=(?:sent|archived)(?:&state=(?:open|replied|resolved))?)(?:&cursor=[A-Za-z0-9_-]{1,512})?$/
    ),
    route(
      '/api/gtd/hub/api/handoffs/{thread_id}',
      /^\/api\/gtd\/hub\/api\/handoffs\/hth_[A-Za-z0-9_-]{1,128}$/
    ),
    route('/api/gtd/hub/api/employees', /^\/api\/gtd\/hub\/api\/employees$/),
    route(
      '/api/gtd/hub/api/board/{task_id}/files',
      /^\/api\/gtd\/hub\/api\/board\/btk_[A-Za-z0-9]{4,64}\/files$/
    ),
    route('/api/gtd/hub/api/workflow-templates', /^\/api\/gtd\/hub\/api\/workflow-templates$/),
    route(
      '/api/gtd/hub/api/board/{task_id}',
      /^\/api\/gtd\/hub\/api\/board\/btk_[A-Za-z0-9]{4,64}$/
    ),
    route(
      '/api/gtd/workflow-graphs/{graph_id}',
      /^\/api\/gtd\/workflow-graphs\/wf_[A-Za-z0-9_-]{1,128}$/
    ),
    route('/api/gtd/workflow-actions', /^\/api\/gtd\/workflow-actions$/),
    route(
      '/api/gtd/workflow-jobs/{job_id}/handoff',
      /^\/api\/gtd\/workflow-jobs\/job_[a-z0-9]{8,40}\/handoff$/
    ),
    route(
      '/api/gtd/jobs',
      /^\/api\/gtd\/jobs(?:\?(?:task=btk_[A-Za-z0-9]{4,64}|conversation_source=true))?$/
    ),
    route('/api/gtd/jobs/{job_id}', /^\/api\/gtd\/jobs\/job_[a-z0-9]{8,40}$/),
    route(
      '/api/gtd/jobs/{job_id}/events',
      /^\/api\/gtd\/jobs\/job_[a-z0-9]{8,40}\/events(?:\?(?:limit=\d+|event_id=\d+|limit=\d+&event_id=\d+|after=\d+&limit=\d+))?$/
    ),
    route(
      '/api/gtd/workflow-jobs/{job_id}/events',
      /^\/api\/gtd\/workflow-jobs\/job_[a-z0-9]{8,40}\/events\?after=\d+&limit=\d+$/
    ),
    // Companies view: the estate's read-only projections of the hub, the org tree,
    // the scorecard's judgement and one company's finances. Reads only.
    route(
      ['/api/estate/rollup', '/api/estate/missions', '/api/estate/today'],
      /^\/api\/estate\/(?:rollup|missions|today)$/
    ),
    // The Work home: the money scorecard (pruned to the reader's companies by the
    // relay), who is signed in and their company scope, and the people chart.
    route('/api/gtd/estate/scorecard', /^\/api\/gtd\/estate\/scorecard$/),
    route('/api/me', /^\/api\/me$/),
    route('/api/gtd/hub/api/orgchart', /^\/api\/gtd\/hub\/api\/orgchart$/),
    route('/api/estate/company/{id}', /^\/api\/estate\/company\/[A-Za-z0-9_-]{1,128}$/),
    route('/api/org', /^\/api\/org$/),
    route(
      '/api/gtd/scorecard/attention',
      /^\/api\/gtd\/scorecard\/attention(?:\?company=[a-z0-9_-]{1,64}(?:&domain=[a-z0-9_-]{1,64})?)?$/
    ),
    route('/api/accounting', /^\/api\/accounting\?company=(?:omnirogue|acme)$/),
    // The books connection's state. Read-only: authorizing a company, choosing its
    // ledger accounts and re-checking are writes, and one is a consent only a person
    // can give in a browser.
    route('/api/accounting/connections/quickbooks', /^\/api\/accounting\/connections\/quickbooks$/),
    ...accessRoutes.GET,
    // The Companies tree: which companies and departments this reader may file work
    // under. Without this the tree and every folder-scoped filter read nothing.
    route('/api/work/recipients', /^\/api\/work\/recipients$/),
    // The admin users list: the sign-in directory an admin already holds, read by Add Next while the
    // member-readable recipients route is not served; members are refused and read employees.
    route('/api/admin/users', /^\/api\/admin\/users$/),
    route('/api/work/folders', /^\/api\/work\/folders$/),
    // Advertising, read-only (2026-09-12). The console's Sales relay closes these
    // query sets itself (bff/omni_bff/sales_relay.py) and the hub re-checks the
    // reader's employee/company grant; the shapes below are exactly what the
    // native view builds, in a fixed key order, so an unlisted parameter — or any
    // Sales path that is not one of these two reads — stays refused here first.
    ...advertisingReadRoutes,
    // One task, read whole: its filing, its people, its next action — and every
    // session that has worked it, which is how a Task holds many Sessions.
    route('/api/work/card/{task_id}', /^\/api\/work\/card\/btk_[A-Za-z0-9]{4,64}$/),
    route(
      '/api/work/card/{task_id}/sessions',
      /^\/api\/work\/card\/btk_[A-Za-z0-9]{4,64}\/sessions$/
    ),
    // The estate session ledger (2026-09-13): what is live or today's, and who else is on
    // the same card or branch as one of this desktop's own rows. Public projection only.
    route('/api/agent-sessions/now', /^\/api\/agent-sessions\/now\?scope=(?:live|today)$/),
    // The Task-holds-Conversations read: every IDE pane whose "Add to a task" stamped
    // this card, keyed by ledger_id. Same public projection as /now, filtered server-side.
    route(
      '/api/agent-sessions/by-card/{task_id}',
      /^\/api\/agent-sessions\/by-card\/btk_[A-Za-z0-9]{4,64}$/
    ),
    route(
      '/api/agent-sessions/{ledger_id}/peers',
      /^\/api\/agent-sessions\/als_[a-f0-9]{24}\/peers$/
    ),
    // Team memory (Sal 2026-09-13): whether the instructions Sal and Uma wrote are
    // loaded into this person's connector. A read of my own state only; the admin
    // memory and transcript pages stay dormant here.
    route('/api/team-memory/status', /^\/api\/team-memory\/status$/),
    ...taskDependencyRoutes.GET,
    ...browserLoginGetRoutes
  ],
  POST: [
    route(
      [
        '/api/customer-service/session-launches/{launch_id}/claim',
        '/api/customer-service/session-launches/{launch_id}/receipt'
      ],
      /^\/api\/customer-service\/session-launches\/csl_[a-f0-9]{32}\/(?:claim|receipt)$/
    ),
    ...routineAlertRoutes.POST,
    ...advertisingActionRoutes.POST,
    ...teamRoutineRoutes.POST,
    ...routineConversationRoutes.POST,
    ...calendarRoutes.POST,
    ...waitRoutes.POST,
    route(
      [
        '/api/gtd/hub/api/board/{task_id}/drive/declare',
        '/api/gtd/hub/api/board/{task_id}/drive/intakes'
      ],
      /^\/api\/gtd\/hub\/api\/board\/btk_[A-Za-z0-9]{4,64}\/drive\/(?:declare|intakes)$/
    ),
    route('/api/peer/send', /^\/api\/peer\/send$/),
    route('/api/peer/reply', /^\/api\/peer\/reply$/),
    route('/api/peer/rooms/{room_id}/join', /^\/api\/peer\/rooms\/[A-Za-z0-9_-]{1,128}\/join$/),
    route(
      '/api/peer/rooms/{room_id}/messages',
      /^\/api\/peer\/rooms\/[A-Za-z0-9_-]{1,128}\/messages$/
    ),
    route(
      [
        '/api/gtd/hub/api/session-peers/messages/{message_id}/read',
        '/api/gtd/hub/api/session-peers/messages/{message_id}/resolve',
        '/api/gtd/hub/api/session-peers/messages/{message_id}/archive'
      ],
      /^\/api\/gtd\/hub\/api\/session-peers\/messages\/pm_[a-f0-9]{24}\/(?:read|resolve|archive)$/
    ),
    route(
      '/api/gtd/hub/api/session-peers/messages',
      /^\/api\/gtd\/hub\/api\/session-peers\/messages$/
    ),
    route(
      '/api/gtd/hub/api/team/tasks/{task_id}/comment',
      /^\/api\/gtd\/hub\/api\/team\/tasks\/btk_[A-Za-z0-9]{4,64}\/comment$/
    ),
    route(
      ['/api/gtd/workflow-jobs/{job_id}/cancel', '/api/gtd/workflow-jobs/{job_id}/retry'],
      /^\/api\/gtd\/workflow-jobs\/job_[a-z0-9]{8,40}\/(?:cancel|retry)$/
    ),
    route(
      '/api/gtd/workflow-graphs/{graph_id}/cancel',
      /^\/api\/gtd\/workflow-graphs\/wf_[A-Za-z0-9_-]{1,128}\/cancel$/
    ),
    route(
      '/api/gtd/workflow-tasks/{task_id}/outcome-plan',
      /^\/api\/gtd\/workflow-tasks\/btk_[A-Za-z0-9]{4,64}\/outcome-plan$/
    ),
    route(
      '/api/gtd/workflow-tasks/{task_id}/continue',
      /^\/api\/gtd\/workflow-tasks\/btk_[A-Za-z0-9]{4,64}\/continue$/
    ),
    route(
      [
        '/api/gtd/workflow-tasks/{task_id}/preview',
        '/api/gtd/workflow-tasks/{task_id}/admit',
        '/api/gtd/workflow-tasks/{task_id}/reconcile'
      ],
      /^\/api\/gtd\/workflow-tasks\/btk_[A-Za-z0-9]{4,64}\/(?:preview|admit|reconcile)$/
    ),
    // The only accounting write: asking the bank connection to refresh itself.
    route(
      ['/api/accounting/omnirogue/sync', '/api/accounting/acme/sync'],
      /^\/api\/accounting\/(?:omnirogue|acme)\/sync$/
    ),
    route(
      '/api/gtd/hub/api/team/tasks/{task_id}/handoffs',
      /^\/api\/gtd\/hub\/api\/team\/tasks\/btk_[A-Za-z0-9]{4,64}\/handoffs$/
    ),
    route(
      [
        '/api/gtd/hub/api/handoffs/{thread_id}/forward',
        '/api/gtd/hub/api/handoffs/{thread_id}/review',
        '/api/gtd/hub/api/handoffs/{thread_id}/read',
        '/api/gtd/hub/api/handoffs/{thread_id}/entries',
        '/api/gtd/hub/api/handoffs/{thread_id}/archive',
        '/api/gtd/hub/api/handoffs/{thread_id}/files/return'
      ],
      /^\/api\/gtd\/hub\/api\/handoffs\/hth_[A-Za-z0-9_-]{1,128}\/(?:forward|review|read|entries|archive|files\/return)$/
    ),
    // Card-less handoffs (hub migration 334, behind Settings → Experimental): a thread with
    // no card, a file added to an open thread, and "make this a task". Exactly these shapes.
    route('/api/gtd/hub/api/handoffs', /^\/api\/gtd\/hub\/api\/handoffs$/),
    route(
      '/api/gtd/hub/api/handoffs/{thread_id}/files/upload',
      /^\/api\/gtd\/hub\/api\/handoffs\/hth_[A-Za-z0-9_-]{1,128}\/files\/upload$/
    ),
    route(
      '/api/gtd/hub/api/handoffs/{thread_id}/bind',
      /^\/api\/gtd\/hub\/api\/handoffs\/hth_[A-Za-z0-9_-]{1,128}\/bind$/
    ),
    route('/api/gtd/classify', /^\/api\/gtd\/classify$/),
    // Dismiss: the owner's machine-generated decisions, dry-run first (hub #1520).
    // The console BFF serves this one only through its hub relay, never at its own root.
    route(
      '/api/gtd/hub/api/decisions/bulk-dismiss',
      /^\/api\/gtd\/hub\/api\/decisions\/bulk-dismiss$/
    ),
    // Answer an agent's handoff question: the hub's one write that closes it (Work → Needs you).
    route(
      '/api/gtd/hub/api/decisions/{decision_id}/decide',
      /^\/api\/gtd\/hub\/api\/decisions\/dcn_[A-Za-z0-9]{1,64}\/decide$/
    ),
    // A conversation says it exists, and which durable commitment it serves. The hub's
    // own seam: a session may stay conversational with no task at all.
    route('/api/gtd/hub/api/sessions/ingest', /^\/api\/gtd\/hub\/api\/sessions\/ingest$/),
    route(
      '/api/gtd/hub/api/sessions/{session_id}/attach',
      /^\/api\/gtd\/hub\/api\/sessions\/ses_[A-Za-z0-9]{4,64}\/attach$/
    ),
    route(
      '/api/gtd/hub/api/sessions/{session_id}/update',
      /^\/api\/gtd\/hub\/api\/sessions\/ses_[A-Za-z0-9]{4,64}\/update$/
    ),
    route(
      ['/api/gtd/workflow-graphs/preview', '/api/gtd/workflow-graphs/admit'],
      /^\/api\/gtd\/workflow-graphs\/(?:preview|admit|reconcile)$/
    ),
    route(
      [
        '/api/gtd/workflow-jobs/{job_id}/decision',
        '/api/gtd/workflow-jobs/{job_id}/progress',
        '/api/gtd/workflow-jobs/{job_id}/started',
        '/api/gtd/workflow-jobs/{job_id}/activate',
        '/api/gtd/workflow-jobs/{job_id}/artifact',
        '/api/gtd/workflow-jobs/{job_id}/result'
      ],
      /^\/api\/gtd\/workflow-jobs\/job_[a-z0-9]{8,40}\/(?:decision|progress|started|activate|artifact|result)$/
    ),
    ...boardDeliveryPostRoutes,
    // Session ledger writes: this desktop's own rows only (the console derives the
    // employee from the principal and refuses any other row).
    route('/api/agent-sessions/events', /^\/api\/agent-sessions\/events$/),
    route(
      '/api/agent-sessions/{ledger_id}/register',
      /^\/api\/agent-sessions\/als_[a-f0-9]{24}\/register$/
    ),
    // The omnios Work feed (Sal 2026-09-25): this desktop's own work sessions as posts; the
    // console files each under the signed-in person and never under a body-named author.
    ...desktopPublicationRoutes.POST,
    // Employee agent transcripts (Sal 2026-09-13): every IDE agent session's
    // rendered, gate-checked transcript, on the signed-in employee's own behalf.
    // The BFF stamps the employee; there is no employee_id in the body to spoof.
    route('/api/employee-transcripts', /^\/api\/employee-transcripts$/),
    // App health: a feature name and a status, so a missing team memory or a
    // refused transcript is visible to Sal/Uma instead of silent on one machine.
    route('/api/app-health', /^\/api\/app-health$/),
    // The canonical lifecycle verb behind a Kanban move. Completion is NOT here:
    // `done` stays on the board PATCH so the hub's evidence gate still answers.
    route(
      '/api/collab/board/{task_id}/lifecycle',
      /^\/api\/collab\/board\/btk_[A-Za-z0-9]{4,64}\/lifecycle$/
    ),
    ...taskDependencyRoutes.POST,
    ...browserLoginPostRoutes
  ],
  PATCH: [
    ...calendarRoutes.PATCH,
    route('/api/collab/board/{task_id}', /^\/api\/collab\/board\/btk_[A-Za-z0-9]{4,64}$/),
    ...accessRoutes.PATCH
  ],
  DELETE: taskDependencyRoutes.DELETE
}
