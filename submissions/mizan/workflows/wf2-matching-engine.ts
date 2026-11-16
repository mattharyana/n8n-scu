import { workflow, node, trigger, sticky, expr, newCredential } from '@n8n/workflow-sdk';

const runMatching = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Run Matching',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [{ name: 'company_id', type: 'string' }]
      }
    }
  },
  output: [{ company_id: '11111111-1111-1111-1111-111111111111' }]
});

const loadCompany = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Load Company',
    parameters: {
      operation: 'executeQuery',
      query: 'WITH reset AS (UPDATE tasks SET status = \'not_applicable\' WHERE company_id = $1 AND status = \'open\' RETURNING id) SELECT c.id, c.name, c.owner_email, c.facts, (SELECT count(*) FROM reset) AS reset_count FROM companies c WHERE c.id = $1',
      options: { queryReplacement: expr('{{ $json.company_id }}') }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Demo Flip Labs',
    owner_email: 'founder@example.com',
    facts: {
      entity_type: 'C-Corp',
      incorporation_state: 'DE',
      has_india_subsidiary: true,
      received_fdi_india: true,
      indian_resident_founders: true,
      foreign_owned_25pct: true,
      headcount: 4,
      customer_regions: ['US', 'CA', 'IN'],
      data_types: ['personal'],
      raising_soon: true,
      last_allotment_date: '2025-12-20',
      fdi_amount_inr: 10000000
    },
    reset_count: 11
  }]
});

const loadObligations = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Load Active Obligations',
    executeOnce: true,
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT id, code, title, requirement, jurisdiction, category, rule, frequency, due_rule, due_hint, evidence, owner_role, currency, amount_type FROM obligations WHERE status = \'active\'',
      options: {}
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [
    { id: 'ob-de', code: 'DE-ANNUAL', title: 'Delaware annual report + franchise tax', rule: '{"all":[{"fact":"incorporation_state","op":"==","value":"DE"},{"fact":"entity_type","op":"==","value":"C-Corp"}]}', due_rule: 'annual:03-01', currency: 'USD', amount_type: 'confirmed_fee' },
    { id: 'ob-fcgpr', code: 'IN-FCGPR', title: 'FEMA FC-GPR after share allotment', rule: '{"all":[{"fact":"has_india_subsidiary","op":"true"},{"fact":"received_fdi_india","op":"true"}]}', due_rule: 'event+30d', currency: 'INR', amount_type: 'confirmed_fee' }
  ]
});

const ruleEvaluator = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Evaluate Applicability Rules',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: 'const companyRow = $(\'Load Company\').first().json;\n'
        + 'const rawFacts = companyRow.facts;\n'
        + 'const facts = typeof rawFacts === \'string\' ? JSON.parse(rawFacts) : (rawFacts || {});\n'
        + '\n'
        + 'function testCond(cond) {\n'
        + '  const v = facts[cond.fact];\n'
        + '  if (cond.op === \'==\') return v === cond.value;\n'
        + '  if (cond.op === \'!=\') return v !== cond.value;\n'
        + '  if (cond.op === \'>=\') return Number(v) >= Number(cond.value);\n'
        + '  if (cond.op === \'<=\') return Number(v) <= Number(cond.value);\n'
        + '  if (cond.op === \'contains\') return Array.isArray(v) && v.includes(cond.value);\n'
        + '  if (cond.op === \'true\') return v === true;\n'
        + '  return false;\n'
        + '}\n'
        + '\n'
        + 'function evaluate(rule) {\n'
        + '  if (!rule) return false;\n'
        + '  if (rule.all) return rule.all.every(function (r) { return r.fact ? testCond(r) : evaluate(r); });\n'
        + '  if (rule.any) return rule.any.some(function (r) { return r.fact ? testCond(r) : evaluate(r); });\n'
        + '  return false;\n'
        + '}\n'
        + '\n'
        + 'const matched = [];\n'
        + 'for (const it of $input.all()) {\n'
        + '  let rule = it.json.rule;\n'
        + '  if (typeof rule === \'string\') {\n'
        + '    try { rule = JSON.parse(rule); } catch (e) { rule = null; }\n'
        + '  }\n'
        + '  if (evaluate(rule)) {\n'
        + '    matched.push({ json: {\n'
        + '      company_id: companyRow.id,\n'
        + '      obligation_id: it.json.id,\n'
        + '      code: it.json.code,\n'
        + '      title: it.json.title,\n'
        + '      jurisdiction: it.json.jurisdiction,\n'
        + '      due_rule: it.json.due_rule,\n'
        + '      facts: facts\n'
        + '    } });\n'
        + '  }\n'
        + '}\n'
        + 'return matched;'
    }
  },
  output: [
    { company_id: '1111', obligation_id: 'ob-de', code: 'DE-ANNUAL', title: 'Delaware annual report + franchise tax', jurisdiction: 'US-DE', due_rule: 'annual:03-01', facts: { incorporation_state: 'DE' } },
    { company_id: '1111', obligation_id: 'ob-fcgpr', code: 'IN-FCGPR', title: 'FEMA FC-GPR after share allotment', jurisdiction: 'IN-RBI', due_rule: 'event+30d', facts: { last_allotment_date: '2025-12-20' } }
  ]
});

const deadlineEngine = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Deadlines',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: 'const item = $input.item.json;\n'
        + 'const facts = item.facts || {};\n'
        + 'const today = new Date();\n'
        + '\n'
        + 'const EVENT_DATE_FACT = { \'IN-FCGPR\': \'last_allotment_date\', \'I9\': \'last_hire_date\' };\n'
        + '\n'
        + 'function nextDue(code, rule, f) {\n'
        + '  if (!rule) return null;\n'
        + '  let m = rule.match(/^annual:(\\d\\d)-(\\d\\d)$/);\n'
        + '  if (m) {\n'
        + '    const d = new Date(Date.UTC(today.getUTCFullYear(), Number(m[1]) - 1, Number(m[2])));\n'
        + '    if (d < today) d.setUTCFullYear(d.getUTCFullYear() + 1);\n'
        + '    return d.toISOString().slice(0, 10);\n'
        + '  }\n'
        + '  m = rule.match(/^event\\+(\\d+)d$/);\n'
        + '  const evFact = EVENT_DATE_FACT[code];\n'
        + '  if (m && evFact && f[evFact]) {\n'
        + '    const d = new Date(f[evFact]);\n'
        + '    d.setUTCDate(d.getUTCDate() + Number(m[1]));\n'
        + '    return d.toISOString().slice(0, 10);\n'
        + '  }\n'
        + '  return null;\n'
        + '}\n'
        + '\n'
        + 'const due = nextDue(item.code, item.due_rule, facts);\n'
        + 'const amount = item.code === \'IN-FCGPR\' ? (facts.fdi_amount_inr || null) : null;\n'
        + '\n'
        + 'return { json: {\n'
        + '  company_id: item.company_id,\n'
        + '  obligation_id: item.obligation_id,\n'
        + '  code: item.code,\n'
        + '  title: item.title,\n'
        + '  due_date: due,\n'
        + '  amount_involved: amount\n'
        + '} };'
    }
  },
  output: [{ company_id: '1111', obligation_id: 'ob-fcgpr', code: 'IN-FCGPR', title: 'FEMA FC-GPR after share allotment', due_date: '2026-01-19', amount_involved: 10000000 }]
});

const upsertTasks = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Upsert Tasks',
    parameters: {
      operation: 'executeQuery',
      query: 'INSERT INTO tasks (company_id, obligation_id, status, due_date, amount_involved) VALUES ($1, $2, \'open\', NULLIF($3, \'\')::date, NULLIF($4, \'\')::numeric) ON CONFLICT (company_id, obligation_id) DO UPDATE SET status = CASE WHEN tasks.status = \'done\' THEN \'done\' ELSE \'open\' END, due_date = EXCLUDED.due_date, amount_involved = EXCLUDED.amount_involved RETURNING id, obligation_id, due_date, status',
      options: { queryReplacement: expr('{{ $json.company_id }}, {{ $json.obligation_id }}, {{ $json.due_date || \'\' }}, {{ $json.amount_involved || \'\' }}') }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{ id: 'task-1', obligation_id: 'ob-fcgpr', due_date: '2026-01-19', status: 'open' }]
});

const writeAuditLog = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.5,
  config: {
    name: 'Write Audit Log',
    executeOnce: true,
    parameters: {
      operation: 'executeQuery',
      query: 'INSERT INTO audit_log (company_id, event, detail) VALUES ($1, \'matched\', jsonb_build_object(\'matched_count\', $2::int)) RETURNING id',
      options: { queryReplacement: expr('{{ $("Load Company").first().json.id }}, {{ $("Compute Deadlines").all().length }}') }
    },
    credentials: { postgres: newCredential('Supabase Postgres') }
  },
  output: [{ id: 42 }]
});

const summarise = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Matching Summary',
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'sum-company', name: 'company_id', value: expr('{{ $("Load Company").first().json.id }}'), type: 'string' },
          { id: 'sum-count', name: 'matched_count', value: expr('{{ $("Compute Deadlines").all().length }}'), type: 'number' },
          { id: 'sum-ok', name: 'ok', value: true, type: 'boolean' }
        ]
      }
    }
  },
  output: [{ company_id: '1111', matched_count: 11, ok: true }]
});

const overviewNote = sticky(
  '## WF2 — Matching + Deadline Engine\n\nCalled by WF1 (after facts are confirmed) and WF4 (after a new rule is approved).\n\n1. **Load Company** also resets this company\'s open tasks to `not_applicable` so obligations that no longer apply drop off.\n2. **Evaluate Applicability Rules** runs the rule evaluator over every active obligation using `companies.facts`.\n3. **Compute Deadlines** turns `due_rule` into a real date (`annual:MM-DD` or `event+Nd`).\n4. **Upsert Tasks** writes them back as `open`, preserving anything already marked `done`.\n\nMoney is never computed here — the SQL views `task_exposure` and `compliance_debt` own all amounts.',
  [runMatching, loadCompany, loadObligations, ruleEvaluator, deadlineEngine, upsertTasks],
  { color: 4 }
);

export default workflow('mizan-wf2-matching', 'Mizan WF2 — Matching + Deadline Engine')
  .add(runMatching)
  .to(loadCompany)
  .to(loadObligations)
  .to(ruleEvaluator)
  .to(deadlineEngine)
  .to(upsertTasks)
  .to(writeAuditLog)
  .to(summarise)
  .add(overviewNote)
  .group('Matching engine', [loadCompany, loadObligations, ruleEvaluator, deadlineEngine, upsertTasks], {
    description: 'Loads company facts and active obligations, evaluates applicability rules, computes deadlines and upserts the resulting tasks'
  });
