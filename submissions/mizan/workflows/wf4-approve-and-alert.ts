import { workflow, node, trigger, sticky, expr, newCredential } from '@n8n/workflow-sdk';

/**
 * WF4 — Approve & Alert.
 *
 * The last link in the monitor chain. WF3 stops at `events.stage = 'verified'`
 * and never activates anything, because honesty rule 5 says a person approves
 * every new regulation pack before a founder sees it. This workflow is that
 * person's hand on the switch, and the only path from `draft` to `active`.
 *
 * It contains no LLM node on purpose. A new rule becoming a priced alert is
 * exactly the part a founder would be hurt by getting wrong, so every number
 * here is read from `task_exposure` — the same SQL view the dashboard reads —
 * and the alert body is assembled from the obligation's own requirement text.
 * Nothing in this file can invent a figure, because nothing in this file
 * produces prose that was not already in the database.
 */

const approveHook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: {
    name: 'POST /monitor/approve',
    parameters: {
      httpMethod: 'POST',
      path: 'monitor/approve',
      responseMode: 'responseNode',
      options: {}
    },
    webhookId: 'mizan-monitor-approve'
  },
  output: [{ body: { event_id: '22222222-2222-2222-2222-222222222222' } }]
});

/**
 * Loads the event with everything needed to decide whether it may be approved.
 * The guard below reads `stage` and `obligation_status` from here, so the
 * decision is made against the database rather than against the request body.
 */
const loadEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Load Event',
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT e.id AS event_id, e.stage, e.obligation_id, e.verification, '
        + 'o.code, o.title, o.requirement, o.jurisdiction, o.risk_types, o.due_hint, '
        + 'o.status AS obligation_status, o.money_source_url, '
        + 's.url AS source_url, s.title AS source_title, s.agency '
        + 'FROM events e '
        + 'LEFT JOIN obligations o ON o.id = e.obligation_id '
        + 'LEFT JOIN sources s ON s.id = e.source_id '
        + 'WHERE e.id = $1',
      options: { queryReplacement: expr('{{ $json.body.event_id }}') }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{
    event_id: '2222', stage: 'verified', obligation_id: 'ob-fla',
    code: 'IN-FLA', title: 'FLA annual return to RBI',
    requirement: 'File the Foreign Liabilities and Assets return with RBI each year.',
    jurisdiction: 'IN', risk_types: ['fines', 'regulatory'], due_hint: 'annual:07-15',
    obligation_status: 'draft', source_url: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx',
    agency: 'RBI'
  }]
});

/**
 * Honesty rule 5, enforced rather than documented. Only a verified event whose
 * obligation is still a draft may be approved. Re-posting the same event_id is
 * a no-op instead of a second round of alerts.
 */
const guard = node({
  type: 'n8n-nodes-base.if',
  version: 2.2,
  config: {
    name: 'Verified and still a draft?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, version: 2 },
        combinator: 'and',
        conditions: [
          {
            id: 'is-verified',
            operator: { type: 'string', operation: 'equals' },
            leftValue: expr('{{ $json.stage }}'),
            rightValue: 'verified'
          },
          {
            id: 'is-draft',
            operator: { type: 'string', operation: 'equals' },
            leftValue: expr('{{ $json.obligation_status }}'),
            rightValue: 'draft'
          }
        ]
      },
      options: {}
    }
  },
  output: [{ event_id: '2222', stage: 'verified', obligation_status: 'draft' }]
});

/**
 * Activates the obligation and records the approval in one statement, so an
 * event can never end up approved with its obligation still a draft.
 *
 * The verifier's quotes become obligation_evidence rows here. That matters:
 * honesty rule 1 hides any amount with no evidence behind it, so without this
 * step an approved rule would show "Unverified" on every screen even though a
 * person had just read the source and approved it.
 */
const activate = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Activate Obligation',
    parameters: {
      operation: 'executeQuery',
      query: 'WITH activated AS ('
        + '  UPDATE obligations SET status = \'active\' '
        + '   WHERE id = $1 AND status = \'draft\' RETURNING id, code, title'
        + '), approved AS ('
        + '  UPDATE events SET stage = \'approved\', updated_at = now() '
        + '   WHERE id = $2 AND stage = \'verified\' RETURNING id'
        + '), evidence AS ('
        + '  INSERT INTO obligation_evidence (obligation_id, kind, url, quote, supports) '
        + '  SELECT $1, \'official\', q->>\'url\', q->>\'quote\', q->>\'supports\' '
        + '    FROM jsonb_array_elements(coalesce($3::jsonb->\'quotes\', \'[]\'::jsonb)) q '
        + '   WHERE coalesce(q->>\'quote\', \'\') <> \'\' RETURNING id'
        + ') '
        + 'SELECT (SELECT count(*) FROM activated) AS activated, '
        + '       (SELECT count(*) FROM approved) AS approved, '
        + '       (SELECT count(*) FROM evidence) AS evidence_rows',
      options: {
        queryReplacement: expr('{{ $json.obligation_id }}, {{ $json.event_id }}, {{ JSON.stringify($json.verification || {}) }}')
      }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{ activated: 1, approved: 1, evidence_rows: 2 }]
});

/**
 * Every company, not a filtered list. Deciding who a rule applies to is the
 * rule evaluator's job, and the rule evaluator lives in WF2. Re-implementing
 * that filter in SQL here would be a second source of truth that could drift
 * from the first.
 */
const loadCompanies = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Load Every Company',
    executeOnce: true,
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT id AS company_id, name, owner_email FROM companies ORDER BY created_at ASC',
      options: {}
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [
    { company_id: '1111', name: 'Demo Flip Labs', owner_email: 'founder@example.com' },
    { company_id: '3333', name: 'Dosely', owner_email: 'lina@example.com' }
  ]
});

/**
 * Runs once per company. WF2 resets open tasks, evaluates every active
 * obligation — the new one included — and writes back the tasks that apply,
 * with their deadlines. Companies the rule does not touch simply gain no task,
 * which is what makes the next node's result the alert list.
 */
const rematch = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.2,
  config: {
    name: 'Re-match via WF2',
    parameters: {
      workflowId: { __rl: true, value: 'lVOpL336tDonulja', mode: 'list', cachedResultName: 'Mizan WF2 — Matching + Deadline Engine' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { company_id: expr('{{ $json.company_id }}') },
        schema: [{ id: 'company_id', displayName: 'company_id', type: 'string', required: true, canBeUsedToMatch: true }]
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ company_id: '1111', matched_count: 12, ok: true }]
});

/**
 * The alert list and its prices, in one read, from the same view the dashboard
 * uses. Honesty rule 2 — no model touches these numbers, and M-2's "numbers
 * match task_exposure" is true by construction rather than by comparison.
 *
 * A company only appears here if WF2 just created a task for this obligation,
 * so this is also the answer to "who does the new rule actually affect".
 */
const collectAffected = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Who It Affects, And For How Much',
    executeOnce: true,
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT x.company_id, c.name AS company_name, c.owner_email, x.task_id, '
        + 'x.code, x.title, x.due_date, x.days_late, '
        + 'x.cost_to_comply_usd, x.penalty_accrued_usd, x.amount_type, '
        + 'o.requirement, o.jurisdiction, o.risk_types, o.due_hint, o.money_source_url, '
        + '(SELECT count(*) FROM obligation_evidence oe WHERE oe.obligation_id = o.id) AS evidence_rows '
        + 'FROM task_exposure x '
        + 'JOIN tasks tk ON tk.id = x.task_id '
        + 'JOIN obligations o ON o.id = tk.obligation_id '
        + 'JOIN companies c ON c.id = x.company_id '
        + 'WHERE tk.obligation_id = $1 AND x.status = \'open\'',
      options: { queryReplacement: expr('{{ $("Load Event").first().json.obligation_id }}') }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{
    company_id: '1111', company_name: 'Demo Flip Labs', owner_email: 'founder@example.com',
    task_id: 't-fla', code: 'IN-FLA', title: 'FLA annual return to RBI',
    due_date: '2027-07-15', days_late: 0, cost_to_comply_usd: 90,
    penalty_accrued_usd: 0, amount_type: 'confirmed_fee',
    requirement: 'File the Foreign Liabilities and Assets return with RBI each year.',
    jurisdiction: 'IN', risk_types: ['fines', 'regulatory'], evidence_rows: 2
  }]
});

/**
 * Composes the alert from parts that already exist: the regulator's own
 * requirement sentence, the numbers from task_exposure, and the obligation's
 * risk types. Deliberately not a model — see the file header.
 *
 * Honesty rule 1 is applied here rather than left to the screen: an amount with
 * no evidence row behind it is written as "Unverified", so a figure cannot
 * reach a founder's inbox by a route that skips the UI's check.
 */
const composeAlert = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compose Alert',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: 'const ev = $(\'Load Event\').first().json;\n'
        + 'const usd = (n) => (n === null || n === undefined || n === \'\') ? null : Number(n);\n'
        + 'const money = (n, sourced) => {\n'
        + '  const v = usd(n);\n'
        + '  if (v === null || !sourced) return \'Unverified\';\n'
        + '  return \'$\' + v.toLocaleString(\'en-US\');\n'
        + '};\n'
        + 'return $input.all().map((item) => {\n'
        + '  const r = item.json;\n'
        + '  const sourced = Number(r.evidence_rows || 0) > 0;\n'
        + '  const risks = Array.isArray(r.risk_types) ? r.risk_types.join(\', \') : \'\';\n'
        + '  const lines = [];\n'
        + '  lines.push(r.requirement);\n'
        + '  lines.push(\'\');\n'
        + '  lines.push(\'Applies to you because this rule now covers \' + (r.jurisdiction || \'your jurisdiction\') + \'.\');\n'
        + '  if (r.due_date) lines.push(\'Due \' + r.due_date + (Number(r.days_late) > 0 ? \' — already \' + r.days_late + \' days late\' : \'\'));\n'
        + '  lines.push(\'Cost to comply: \' + money(r.cost_to_comply_usd, sourced));\n'
        + '  if (Number(r.penalty_accrued_usd) > 0) lines.push(\'Accrued so far: \' + money(r.penalty_accrued_usd, sourced));\n'
        + '  if (risks) lines.push(\'What you could lose: \' + risks);\n'
        + '  if (!sourced) lines.push(\'No amount is shown because no source has been attached to this rule yet.\');\n'
        + '  lines.push(\'\');\n'
        + '  lines.push(\'Source: \' + (ev.source_url || r.money_source_url || \'on file\') + (ev.agency ? \' (\' + ev.agency + \')\' : \'\'));\n'
        + '  lines.push(\'Information, not legal advice.\');\n'
        + '  return { json: Object.assign({}, r, {\n'
        + '    event_id: ev.event_id,\n'
        + '    obligation_id: ev.obligation_id,\n'
        + '    alert_title: \'New rule affects you: \' + r.title,\n'
        + '    alert_body: lines.join(\'\\n\'),\n'
        + '    sourced,\n'
        + '    cost_for_alert: sourced ? usd(r.cost_to_comply_usd) : null,\n'
        + '    penalty_for_alert: sourced ? usd(r.penalty_accrued_usd) : null\n'
        + '  }) };\n'
        + '});'
    }
  },
  output: [{
    company_id: '1111', alert_title: 'New rule affects you: FLA annual return to RBI',
    alert_body: 'File the Foreign Liabilities and Assets return with RBI each year.\n\nCost to comply: $90',
    sourced: true, cost_for_alert: 90, penalty_for_alert: 0
  }]
});

/**
 * One alert per affected company. The unique index on (company_id, event_id)
 * is what makes a repeated approval harmless; without it a second POST would
 * duplicate every alert.
 */
const writeAlerts = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Write Alerts',
    parameters: {
      operation: 'executeQuery',
      query: 'INSERT INTO alerts (company_id, event_id, obligation_id, title, body, cost_to_comply_usd, penalty_usd) '
        + 'VALUES ($1, $2, $3, $4, $5, $6, $7) '
        + 'ON CONFLICT (company_id, event_id) DO UPDATE SET '
        + '  title = EXCLUDED.title, body = EXCLUDED.body, '
        + '  cost_to_comply_usd = EXCLUDED.cost_to_comply_usd, penalty_usd = EXCLUDED.penalty_usd '
        + 'RETURNING id, company_id',
      options: {
        queryReplacement: expr('{{ $json.company_id }}, {{ $json.event_id }}, {{ $json.obligation_id }}, {{ $json.alert_title }}, {{ $json.alert_body }}, {{ $json.cost_for_alert }}, {{ $json.penalty_for_alert }}')
      }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{ id: 'al-1', company_id: '1111' }]
});

const sendEmail = node({
  type: 'n8n-nodes-base.emailSend',
  version: 2.1,
  config: {
    name: 'Email the Founder',
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    parameters: {
      fromEmail: 'mizan@example.com',
      toEmail: expr('{{ $("Compose Alert").item.json.owner_email }}'),
      subject: expr('{{ $("Compose Alert").item.json.alert_title }}'),
      emailFormat: 'text',
      text: expr('{{ $("Compose Alert").item.json.alert_body }}'),
      options: {}
    }
  },
  output: [{ accepted: ['founder@example.com'] }]
});

/**
 * `onError: continueRegularOutput` on the email node means a bounced address
 * cannot roll back an approval that already happened. The alert row is the
 * record; `sent_at` only claims delivery was attempted.
 */
const markSent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Mark Sent',
    executeOnce: true,
    parameters: {
      operation: 'executeQuery',
      query: 'UPDATE alerts SET sent_at = now() WHERE event_id = $1 AND sent_at IS NULL RETURNING id',
      options: { queryReplacement: expr('{{ $("Load Event").first().json.event_id }}') }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{ id: 'al-1' }]
});

const writeAuditLog = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Write Audit Log',
    executeOnce: true,
    parameters: {
      operation: 'executeQuery',
      query: 'INSERT INTO audit_log (company_id, event, detail) '
        + 'SELECT a.company_id, \'rule_approved\', jsonb_build_object('
        + '  \'event_id\', $1::uuid, \'obligation_code\', $2::text, \'alerted\', $3::int) '
        + 'FROM alerts a WHERE a.event_id = $1::uuid RETURNING id',
      options: {
        queryReplacement: expr('{{ $("Load Event").first().json.event_id }}, {{ $("Load Event").first().json.code }}, {{ $("Compose Alert").all().length }}')
      }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{ id: 43 }]
});

const respondOk = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Respond Approved',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ ok: true, event_id: $("Load Event").first().json.event_id, obligation_code: $("Load Event").first().json.code, alerted: $("Compose Alert").all().length, companies: $("Compose Alert").all().map(i => i.json.company_name) }) }}'),
      options: {}
    }
  },
  output: [{ ok: true, alerted: 1 }]
});

/**
 * The refusal path matters as much as the happy one. An event that is not
 * verified, or an obligation already active, returns 409 and changes nothing —
 * so monitor.html gets a real reason instead of a silent success.
 */
const respondRefused = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Respond Not Approvable',
    parameters: {
      respondWith: 'json',
      responseCode: 409,
      responseBody: expr('{{ JSON.stringify({ ok: false, reason: $json.stage !== "verified" ? "Event is at stage " + $json.stage + ", not verified" : "Obligation is already " + $json.obligation_status, event_id: $json.event_id }) }}'),
      options: {}
    }
  },
  output: [{ ok: false, reason: 'Event is at stage researched, not verified' }]
});

const overviewNote = sticky(
  '## WF4 — Approve & Alert\n\n'
    + 'The human gate at the end of the monitor chain, and the only path from `draft` to `active`.\n\n'
    + '1. **Load Event** reads the state from the database, not the request body.\n'
    + '2. **Verified and still a draft?** enforces honesty rule 5 and makes a repeated POST a no-op.\n'
    + '3. **Activate Obligation** flips the status, marks the event approved and writes the verifier\'s quotes into `obligation_evidence` — all in one statement, so the three can never disagree.\n'
    + '4. **Re-match via WF2** runs the rule evaluator per company. Who a rule affects is WF2\'s answer, never a second filter written here.\n'
    + '5. **Who It Affects** reads `task_exposure`, so the alert prices are the dashboard\'s prices.\n\n'
    + '**No LLM node, deliberately.** A new rule becoming a priced alert is the part a founder would be hurt by getting wrong. The body is assembled from the regulator\'s own requirement text and SQL numbers; an amount with no evidence row is written "Unverified" rather than shown.',
  [approveHook, loadEvent, guard, activate, loadCompanies, rematch, collectAffected, composeAlert],
  { color: 4 }
);

export default workflow('mizan-wf4-approve-alert', 'Mizan WF4 — Approve & Alert')
  .add(approveHook)
  .to(loadEvent)
  .to(guard)
  .to(activate)
  .to(loadCompanies)
  .to(rematch)
  .to(collectAffected)
  .to(composeAlert)
  .to(writeAlerts)
  .to(sendEmail)
  .to(markSent)
  .to(writeAuditLog)
  .to(respondOk)
  .add(respondRefused)
  .add(overviewNote)
  .group('Approval gate', [loadEvent, guard, activate], {
    description: 'Reads the event state from the database, refuses anything not verified, then activates the obligation and records the approval in one statement'
  })
  .group('Priced alerts', [loadCompanies, rematch, collectAffected, composeAlert, writeAlerts], {
    description: 'Re-matches every company through WF2, reads the resulting prices from task_exposure, and writes one alert per affected company'
  });
