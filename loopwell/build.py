#!/usr/bin/env python3
"""Builds the Loopwell n8n workflow JSON (cloud version + local test version)."""
import json, sys, uuid, pathlib, copy, re

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "dist"
OUT.mkdir(exist_ok=True)

TABLE = "loopwell_accounts"
SETTINGS = "loopwell_settings"
WATCH = "loopwell_watch"  # one row per account: last homepage headline snapshot + what changed
WATCH_COLS = ["account_id", "company", "lines", "checked_at", "changed_at", "changes"]  # one row: key approve_passcode, value <passcode>. Never committed.
LIB = (SRC / "code" / "lib.js").read_text()
SEED = json.loads((SRC / "seed.json").read_text())
SENDER = re.search(r"const SENDER = '([^']+)';", LIB).group(1)  # set in src/code/lib.js
P = {k: (SRC / "prompts" / f"{k}.md").read_text().strip().replace("__SENDER__", SENDER) for k in ["research", "draft", "judge", "revise", "factcheck", "relevance", "learn"]}
P["judge"] += '\n\nIf the input is ALREADY_PASSED, respond with {"keep": true} and nothing else.'
DASH = (SRC / "dashboard.html").read_text()

COLUMNS = [
    ("account_id", "string"), ("company", "string"), ("domain", "string"), ("homepage_url", "string"),
    ("news_query", "string"), ("contact_name", "string"), ("contact_title", "string"), ("contact_email", "string"),
    ("timezone", "string"), ("deal_stage", "string"), ("loss_reason", "string"), ("loss_details", "string"),
    ("close_date", "string"), ("original_ask", "string"), ("call_notes", "string"),
    ("status", "string"), ("track", "string"), ("triage_note", "string"), ("signal", "string"),
    ("research_json", "string"), ("draft_subject", "string"), ("draft_body", "string"), ("qa_json", "string"),
    ("score", "number"), ("passes", "number"), ("edited", "boolean"), ("gmail_draft_id", "string"), ("updated_at", "string"),
]
COLTYPE = dict(COLUMNS)


def uid():
    return str(uuid.uuid4())


class WF:
    def __init__(self, name):
        self.name = name
        self.nodes = []
        self.conns = {}

    def add(self, name, type_, version, params, pos, **extra):
        node = {"parameters": params, "id": uid(), "name": name, "type": type_, "typeVersion": version, "position": list(pos)}
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, a, b, out=0, kind="main", inp=0):
        c = self.conns.setdefault(a, {}).setdefault(kind, [])
        while len(c) <= out:
            c.append([])
        c[out].append({"node": b, "type": kind, "index": inp})

    def chain(self, *names):
        for a, b in zip(names, names[1:]):
            self.link(a, b)

    def json(self):
        return {"name": self.name, "nodes": self.nodes, "connections": self.conns, "pinData": {},
                "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "all", "saveManualExecutions": True},
                "meta": {"templateCredsSetupCompleted": False}, "tags": []}


def code(js, lib=False):
    body = (LIB + "\n" + js) if lib else js
    return {"jsCode": body.replace("__SENDER__", SENDER).strip() + "\n"}


def dt_rl():
    return {"__rl": True, "mode": "name", "value": TABLE}


def schema_for(keys):
    return [{"id": k, "displayName": k, "required": False, "defaultMatch": False, "display": True,
             "type": COLTYPE[k], "canBeUsedToMatch": True} for k in keys]


def dt_update(values, id_expr="={{ $json.account_id }}"):
    return {
        "resource": "row", "operation": "update", "dataTableId": dt_rl(),
        "matchType": "allConditions",
        "filters": {"conditions": [{"keyName": "account_id", "condition": "eq", "keyValue": id_expr}]},
        "columns": {"mappingMode": "defineBelow", "value": values, "matchingColumns": [], "schema": schema_for(values.keys()),
                    "attemptToConvertTypes": False, "convertFieldsToString": False},
        "options": {},
    }


def dt_get(id_expr=None):
    p = {"resource": "row", "operation": "get", "dataTableId": dt_rl(), "returnAll": True}
    if id_expr:
        p.update({"matchType": "allConditions",
                  "filters": {"conditions": [{"keyName": "account_id", "condition": "eq", "keyValue": id_expr}]}})
    else:
        p.update({"matchType": "anyCondition", "filters": {}})
    return p


def respond(body_expr, ctype="application/json; charset=utf-8"):
    return {"respondWith": "text", "responseBody": body_expr,
            "options": {"responseHeaders": {"entries": [{"name": "Content-Type", "value": ctype},
                                                        {"name": "Cache-Control", "value": "no-store"}]}}}


def llm(system, text_expr):
    return {"promptType": "define", "text": text_expr, "hasOutputParser": False,
            "messages": {"messageValues": [{"type": "SystemMessagePromptTemplate", "message": system}]},
            "batching": {"batchSize": 5}}


def sticky(wf, title, body, pos, w, h, color):
    body = body.replace("__SENDER__", SENDER)
    wf.add(title, "n8n-nodes-base.stickyNote", 1, {"content": f"## {title}\n{body}", "height": h, "width": w, "color": color}, pos)


NOW = "={{ $now.toISO() }}"

# ---------------------------------------------------------------- Code node bodies
JS_PAGE = """
const h = $input.first().json.headers || {};
const host = h['x-forwarded-host'] || h.host;
const proto = String(h['x-forwarded-proto'] || (/^(localhost|127\\.|0\\.0\\.0\\.0|\\[::1\\])/.test(String(host)) ? 'http' : 'https')).split(',')[0].trim();
const html = __HTML__;
return [{ json: { html: html.split('__API_URL__').join(`${proto}://${host}/webhook/loopwell-api`)
  .split('__WORKFLOW_URL__').join(`${proto}://${host}/workflow/${$workflow.id}`) } }];
"""

JS_DEMO = """
// The demo CRM's contacts are made up. Mail for them goes to the demo inbox (loopwell_settings key demo_inbox,
// plus-tagged per account) and never to the address shown. Real CRM rows send to their own contact_email.
const DEMO_IDS = __DEMO_IDS__;
function deliverTo(r, inbox) {
  if (!DEMO_IDS.includes(r.account_id)) return { to: r.contact_email || '', demo: false };
  const m = /^([^@+\\s]+)(?:\\+[^@\\s]*)?@([^@\\s]+\\.[^@\\s]+)$/.exec(String(inbox || '').trim());
  return { to: m ? `${m[1]}+${String(r.account_id).replace(/^acc_/, '')}@${m[2]}` : '', demo: true };
}
"""

JS_DEMO = JS_DEMO.replace("__DEMO_IDS__", json.dumps([a["account_id"] for a in SEED]))

JS_SHAPE_LIST = """
const items = $('CRM: read all').all();
const watchRows = $input.all().map((i) => i.json).filter((r) => r && r.account_id);
const watchBy = Object.fromEntries(watchRows.map((r) => {
  let changes = []; try { changes = JSON.parse(r.changes || '[]'); } catch (e) {}
  return [r.account_id, { checked_at: r.checked_at || '', changed_at: r.changed_at || '', changes }];
}));
const lastCheck = watchRows.map((r) => r.checked_at || '').sort().pop() || '';
const first = items[0] && items[0].json;
const crm_url = $('Check passcode').first().json.crm_url || '';
if (first && first.error) return [{ json: { needs_setup: true, accounts: [], crm_url, message: 'The CRM table does not exist yet.' } }];
const accounts = items.map((i) => i.json).filter((r) => r && r.account_id).map((r) => {
  const { research_json, qa_json, ...rest } = r;
  return { ...rest, research: parseJSON(research_json), qa: parseJSON(qa_json), watch: watchBy[r.account_id] || null };
});
const style = $('Check passcode').first().json.style || null;
const learned = $('Check passcode').first().json.learned || null;
const inbox = $('Check passcode').first().json.demo_inbox || '';
accounts.forEach((a) => { const d = deliverTo(a, inbox); a.send_to = d.to; a.demo = d.demo; });
return [{ json: { needs_setup: accounts.length === 0, accounts, crm_url, style, learned, watcher: { last_check: lastCheck, watching: watchRows.length }, server_time: new Date().toISOString() } }];
"""

JS_PREP_EDIT = """
const b = $input.first().json.body || {};
return [{ json: { account_id: String(b.account_id || ''), draft_subject: String(b.subject || '').trim(), draft_body: String(b.body || '').replace(/\\r/g, '').trim() } }];
"""

JS_SEED = """
const seed = __SEED__;
const now = new Date().toISOString();
return seed.map((a) => ({ json: { ...a, status: 'queued', track: '', triage_note: '', signal: '', research_json: '', draft_subject: '', draft_body: '', qa_json: '', score: 0, passes: 0, edited: false, gmail_draft_id: '', updated_at: now } }));
"""

JS_COUNT = "return [{ json: { ok: true, count: $input.all().length } }];"

JS_TRIAGE = """
const body = $('Webhook: API').first().json.body || {};
const only = new Set(String(body.account_ids || body.account_id || '').split(',').map((x) => x.trim()).filter(Boolean));
const viaWatch = body.trigger === 'watch';
const now = new Date();
const today = now.toISOString().slice(0, 10);
const DAY = 864e5;
const cp = $('Check passcode').first().json;
const rules = (cp.learned && cp.learned.rules) || [];
const style_guide = [(cp.style || {}).md || '', rules.length ? "## Learned from __SENDER__'s own edits (strong preferences)\\n" + rules.map((r) => '- ' + r).join('\\n') : '']
  .filter(Boolean).join('\\n\\n');
const out = [];
for (const it of $input.all()) {
  const a = it.json;
  if (!a || !a.account_id) continue;
  if (only.size && !only.has(a.account_id)) continue;
  if (['sent', 'in_gmail'].includes(a.status)) continue; // already emailed: never redraft, so it can't be sent twice
  const reason = String(a.loss_reason || '').toLowerCase();
  const stage = String(a.deal_stage || '').toLowerCase();
  const close = a.close_date ? new Date(a.close_date + 'T00:00:00Z') : null;
  const isCompetitor = reason.includes('competitor');
  const cooldown = isCompetitor ? 90 : 60;
  const after = close ? new Date(close.getTime() + cooldown * DAY) : null;
  const junk = !a.domain || /\\b(course|test|testing|personal)\\b/i.test(a.company || '') || reason.includes('outside of icp');
  let track = '';
  let status = 'researching';
  let note = '';
  if (junk) { track = 'cleanup'; status = 'cleaned_up'; note = 'Not a real B2B prospect. Marked do-not-contact, no draft.'; }
  else if (stage.includes('won')) { track = 'win-back'; note = 'Former customer, so this is a win-back, not a lost-deal email.'; }
  else if (isCompetitor) { track = 'check-in'; note = reason.includes(',') ? 'Tagged Competitor plus another reason. Competitor wins, so this is a no-pitch check-in.' : 'Lost to a competitor, so this is a no-pitch check-in.'; }
  else if (/(budget|price|tabled|timing|no response|internal hire|strategy|unrealistic)/.test(reason)) { track = 'standard'; note = `Lost on "${a.loss_reason}", so this is a standard re-engagement.`; }
  else { track = 'flag'; status = 'needs_review'; note = 'Loss reason is unclear, so this is flagged for __SENDER__ instead of drafted.'; }
  if (status === 'researching' && (!only.size || viaWatch) && track !== 'win-back') {
    if (after && after > now) { status = 'cooling_down'; note = `Cooldown: ${cooldown} days after ${isCompetitor ? 'a competitor loss' : 'close'}. Resurfaces ${after.toISOString().slice(0, 10)}.`; }
    else if (close && (now - close) / DAY > 1095) { status = 'expired'; note = 'Closed more than 3 years ago, outside the re-engagement window.'; }
  }
  if (viaWatch && status === 'researching') note = `The watcher found something new on their site or in the news, so it queued this account. ${note}`;
  else if (only.size && status === 'researching') note = `Named account, so eligibility was skipped. ${note}`;
  out.push({ json: { ...a, track, status, triage_note: note, today, style_guide } });
}
return out;
"""

JS_ELIGIBLE = "return $input.all().filter((i) => i.json.status === 'researching');"

JS_SOURCES = r"""
const accts = $('Eligible accounts').all();
const homes = $('Fetch homepage').all();
const news = $input.all();
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');
const clean = (s) => decode(s).replace(/\s+/g, ' ').trim();
function pageText(html) {
  const pick = (re) => { const m = html.match(re); return m ? clean(m[1]) : ''; };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || pick(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const og = pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  const heads = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => clean(m[1].replace(/<[^>]+>/g, ' '))).filter((t) => t && t.length < 200).slice(0, 14);
  const body = clean(html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const parts = [...new Set([title, desc, og, ...heads].filter(Boolean))];
  return { title, text: (parts.join(' | ') + ' | ' + body).slice(0, 3500) };
}
function parseRss(xml, maxAgeDays) {
  const items = [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const block = m[1];
    const get = (tag) => { const r = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>')); return r ? clean(r[1]) : ''; };
    const d = new Date(get('pubDate'));
    const ok = !isNaN(d.getTime());
    return { title: get('title'), link: get('link'), source: get('source'), date: ok ? d.toISOString().slice(0, 10) : '', ts: ok ? d.getTime() : 0 };
  }).filter((x) => x.title && x.ts && (Date.now() - x.ts) / 864e5 <= maxAgeDays);
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, 6);
}
return accts.map((a, i) => {
  const acct = a.json;
  const hj = homes[i] && homes[i].json;
  const html = hj && typeof hj.data === 'string' ? hj.data : '';
  const nj = news[i] && news[i].json;
  const rss = nj && typeof nj.data === 'string' ? nj.data : '';
  const sources = [];
  if (html.length > 200) {
    const p = pageText(html);
    if (p.text.length > 80) sources.push({ id: 'H1', type: 'homepage', url: acct.homepage_url, title: p.title || acct.company + ' homepage', date: acct.today, text: p.text });
  }
  parseRss(rss, 120).forEach((it, k) => sources.push({ id: 'N' + (k + 1), type: 'news', url: it.link, title: it.title, date: it.date, text: it.title + (it.source && !it.title.endsWith(it.source) ? ' (' + it.source + ')' : '') }));
  const fetch_log = { homepage: sources.some((s) => s.type === 'homepage') ? 'read' : 'unavailable', news_items: sources.filter((s) => s.type === 'news').length };
  const research_input = JSON.stringify({ account: acctBrief(acct), today: acct.today, sources });
  return { json: { ...acct, sources, fetch_log, research_input } };
});
"""

JS_VERIFY = r"""
const prev = $('Build sources').all();
const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
return $input.all().map((it, i) => {
  const st = prev[i].json;
  const r = llmOut(it) || { found: false };
  let signal;
  if (r.found && r.sensitivity !== 'adverse_only') {
    const src = (st.sources || []).find((s) => s.id === r.source_id);
    const q = norm(r.evidence_quote).replace(/^["']+|["']+$/g, '').replace(/[.]$/, '');
    const ok = !!(src && q.length >= 12 && norm(src.text).includes(q));
    signal = {
      found: true, verified: ok, type: r.type, signal: r.signal, evidence_quote: r.evidence_quote, source_id: r.source_id,
      source_url: src ? src.url : '', source_title: src ? src.title : '', source_date: src ? src.date : '', source_type: src ? src.type : '',
      why_it_matters: r.why_it_matters || '',
      rejected_reason: ok ? '' : (src ? 'The agent quoted text that is not in the source word-for-word, so the signal was thrown out.' : 'The agent cited a source that does not exist, so the signal was thrown out.'),
    };
  } else if (r.sensitivity === 'adverse_only') {
    signal = { found: false, verified: false, rejected_reason: 'Only adverse news turned up (sensitivity screen), so no signal was used.' };
  } else {
    signal = { found: false, verified: false, rejected_reason: 'Nothing specific and current in the sources, so the draft uses genuine questions instead.' };
  }
  const quarter = 'Q' + (Math.floor(new Date().getMonth() / 3) + 1);
  const base = { ...st, signal };
  const draft_input = JSON.stringify({ account: acctBrief(base), track: st.track, signal: signalBrief(base), today: st.today, quarter, style_guide: st.style_guide || undefined });
  const research_json = JSON.stringify({ signal, sources: (st.sources || []).map((s) => ({ id: s.id, type: s.type, url: s.url, title: s.title, date: s.date })), fetch: st.fetch_log });
  const { sources, research_input, ...rest } = st;
  return { json: { ...rest, signal, draft_input, research_json, signal_text: signal.verified ? signal.signal : '' } };
});
"""

JS_CHECK_V1 = """
const prev = $('Verify signal').all();
return $input.all().map((it, i) => {
  const st = prev[i].json;
  const cur = normalizeDraft(llmOut(it) || { subject: '', body: String(it.json.text || '') });
  const det = checkDraft(cur, st);
  const versions = [{ v: 1, subject: cur.subject, body: cur.body, rule_failures: det.failures }];
  return { json: { ...st, cur, det, versions, passed: false, judge_input: judgeInput(st, cur) } };
});
"""


def js_score(prev):
    return f"""
const prev = $('{prev}').all();
return $input.all().map((it, i) => {{
  const st = prev[i].json;
  if (st.passed) return {{ json: {{ ...st, revise_input: 'NO_REVISION_NEEDED' }} }};
  const j = llmOut(it) || {{ score: 5, failures: [{{ check: 'human', detail: 'The judge output could not be read.' }}], strengths: [], verdict: '' }};
  const jf = Array.isArray(j.failures) ? j.failures : [];
  const score = scoreOf(j.score, st.det.failures.length);
  const passed = st.det.failures.length === 0 && Number(j.score) >= 8 && !jf.some((f) => f.check === 'grounding');
  const versions = st.versions.slice();
  versions[versions.length - 1] = {{ ...versions[versions.length - 1], judge_score: Number(j.score), score, judge_failures: jf, strengths: j.strengths || [], verdict: j.verdict || '' }};
  return {{ json: {{ ...st, judge: j, score, passed, versions, revise_input: passed ? 'NO_REVISION_NEEDED' : reviseInput(st, st.cur, st.det.failures, jf) }} }};
}});
"""


def js_apply(prev):
    return f"""
const prev = $('{prev}').all();
return $input.all().map((it, i) => {{
  const st = prev[i].json;
  if (st.passed) return {{ json: {{ ...st, judge_input: 'ALREADY_PASSED' }} }};
  const r = llmOut(it);
  let cur = st.cur;
  if (r && !r.keep && r.body) cur = normalizeDraft({{ ...r, angle: r.angle || st.cur.angle, notes: st.cur.notes }});
  const det = checkDraft(cur, st);
  const versions = [...st.versions, {{ v: st.versions.length + 1, subject: cur.subject, body: cur.body, rule_failures: det.failures, changes: (r && Array.isArray(r.notes)) ? r.notes : [] }}];
  return {{ json: {{ ...st, cur, det, versions, judge_input: judgeInput(st, cur) }} }};
}});
"""


JS_FINAL = """
const prev = $('Apply revision v2').all();
const now = new Date().toISOString();
return $input.all().map((it, i) => {
  let st = prev[i].json;
  if (!st.passed) {
    const j = llmOut(it) || { score: 5, failures: [{ check: 'human', detail: 'The judge output could not be read.' }], strengths: [], verdict: '' };
    const jf = Array.isArray(j.failures) ? j.failures : [];
    const score = scoreOf(j.score, st.det.failures.length);
    const passed = st.det.failures.length === 0 && Number(j.score) >= 8 && !jf.some((f) => f.check === 'grounding');
    const versions = st.versions.slice();
    versions[versions.length - 1] = { ...versions[versions.length - 1], judge_score: Number(j.score), score, judge_failures: jf, strengths: j.strengths || [], verdict: j.verdict || '' };
    st = { ...st, judge: j, score, passed, versions };
  }
  // Keep the best-scoring version (later version wins ties), not simply the last one.
  // A version whose body is leaked JSON is never chosen while a clean one exists.
  let bestIdx = -1;
  st.versions.forEach((v, k) => {
    if (looksLikeJSON(v.body)) return;
    if (bestIdx < 0 || (Number(v.score) || 0) >= (Number(st.versions[bestIdx].score) || 0)) bestIdx = k;
  });
  if (bestIdx < 0) bestIdx = st.versions.length - 1;
  const best = st.versions[bestIdx];
  if (bestIdx !== st.versions.length - 1) {
    const cur = { ...st.cur, subject: best.subject, body: best.body };
    const det = checkDraft(cur, st);
    const passed = det.failures.length === 0 && Number(best.judge_score) >= 8 && !(best.judge_failures || []).some((f) => f.check === 'grounding');
    st = { ...st, cur, det, score: best.score, passed, judge: { score: best.judge_score, strengths: best.strengths || [], verdict: best.verdict || '' } };
  }
  const last = best;
  const failing = st.passed ? [] : [...st.det.failures, ...((last.judge_failures || []).map((f) => f.detail || String(f)))];
  const sig = st.signal || {};
  const notes = [
    `Loss reason: ${st.loss_reason || 'none recorded'}. ${st.loss_details || ''}`.trim(),
    `Contact: ${st.contact_name}, ${st.contact_title}. Demo data, so the address is not verified. Check it before sending.`,
    `They came to Northfold for: ${st.original_ask}`,
    sig.verified ? `Opener signal: ${sig.signal} (${sig.source_type === 'homepage' ? 'their homepage, read today' : sig.source_title}).` : `No opener signal: ${sig.rejected_reason || 'none found'}`,
    st.cur.angle ? `Angle: ${st.cur.angle}` : '',
    st.timezone ? `Day-ask uses ${st.timezone} (from the CRM).` : 'No timezone on record, so the ask says "next week".',
    ...((st.cur.notes || []).slice(0, 2)),
    failing.length ? `Still failing after ${st.versions.length} passes: ${failing.join(' ')}` : '',
  ].filter(Boolean);
  const qa = {
    final_score: st.score, passed: st.passed, flagged: !st.passed, failing, versions: st.versions, chosen_version: bestIdx + 1,
    rules: st.det.checks, rules_passed: st.det.passed, rules_total: st.det.total, words: st.det.words, lines: st.det.lines,
    judge: { score: st.judge ? st.judge.score : null, strengths: (st.judge && st.judge.strengths) || [], verdict: (st.judge && st.judge.verdict) || '' },
    angle: st.cur.angle, notes,
  };
  return { json: {
    account_id: st.account_id, company: st.company, contact_name: st.contact_name, contact_title: st.contact_title,
    contact_email: st.contact_email, track: st.track, draft_subject: st.cur.subject, draft_body: st.cur.body,
    score: st.score, passes: st.versions.length, passed: st.passed, qa_json: JSON.stringify(qa), updated_at: now,
    fact_ctx: { call_notes: st.call_notes, loss_details: st.loss_details, original_ask: st.original_ask, loss_reason: st.loss_reason,
      deal_stage: st.deal_stage, close_date: st.close_date, contact_name: st.contact_name, contact_title: st.contact_title, signal: st.signal || null },
    factcheck_input: JSON.stringify({ draft: { subject: st.cur.subject, body: st.cur.body }, sources: factSources(st) }),
  } };
});
"""

JS_VERIFY_FACTS = """
// The fact checker proposes claims + evidence; verifyClaims (shared lib) only marks a claim verified when
// code finds the claim in the draft and the evidence in the cited source.
const prev = $('Final scoring').all();
return $input.all().map((it, i) => {
  const { fact_ctx, factcheck_input, ...p } = prev[i].json;
  const qa = parseJSON(p.qa_json) || {};
  qa.facts = verifyClaims(llmOut(it), fact_ctx, p.draft_body);
  return { json: { ...p, qa_json: JSON.stringify(qa) } };
});
"""

JS_CHECK_PASS = """
// Anyone with the link can look (list). Every change (run, edit, reset, approve, reject) needs the passcode
// stored in the loopwell_settings Data Table. The passcode is stripped from the body before routing.
const req = $('Webhook: API').first().json;
const body = { ...(req.body || {}) };
const given = String(body.passcode || '');
delete body.passcode;
const action = String(body.action || 'list');
const rows = $input.all().map((i) => i.json).filter((r) => r && r.key);
const setting = (k) => { const r = rows.find((x) => x.key === k); return r ? String(r.value || '').trim() : ''; };
const stored = setting('approve_passcode') || '__TEST_PASS__';
const crm_url = /^https:\\/\\//.test(setting('crm_url')) ? setting('crm_url') : ''; // optional: where "Open CRM" goes
let auth = 'ok';
if (action !== 'list') auth = !stored ? 'not_set' : given !== stored ? 'wrong' : 'ok';
// The imported writing guide (if any), saved from the desk's Writing style panel.
let style = null;
try { const v = setting('style'); const s = v ? JSON.parse(v) : null; if (s && s.md) style = { name: s.name, md: s.md, words: s.words, truncated: !!s.truncated, updated_at: s.updated_at }; } catch (e) {}
// Rules learned from Jayden's own edits (written by the Style Learner after each saved edit).
let learned = null;
try { const v = setting('learned'); const l = v ? JSON.parse(v) : null; if (l && Array.isArray(l.rules)) learned = l; } catch (e) {}
// Where demo contacts' mail goes (see Decision). Optional; without it, demo contacts can't be sent.
const demo_inbox = setting('demo_inbox') || '__TEST_INBOX__';
return [{ json: { headers: req.headers, query: req.query, body, auth, crm_url, style, learned, demo_inbox } }];
"""

JS_LEARN_INPUT = """
// After an edit is saved: compare the AI's chosen draft with Jayden's saved version.
const row = $input.first().json || {};
const edit = $('Prepare edit').first().json;
const qa = parseJSON(row.qa_json) || {};
const versions = qa.versions || [];
const ai = versions[(qa.chosen_version || versions.length) - 1] || {};
const aiBody = String(ai.body || '').trim();
const edited = String(edit.draft_body || '').trim();
const same = (a, b) => a.replace(/\\s+/g, ' ').trim() === b.replace(/\\s+/g, ' ').trim();
const rules = (($('Check passcode').first().json.learned || {}).rules) || [];
if (!aiBody || !edited || same(aiBody, edited)) return [{ json: { learn: false } }];
return [{ json: { learn: true, learn_input: JSON.stringify({ company: row.company, ai_draft: { subject: ai.subject, body: aiBody }, edited_draft: { subject: edit.draft_subject, body: edited }, current_rules: rules }) } }];
"""

JS_LEARN_MERGE = """
// Keeps the learned list short and clean, and remembers what this edit added so the desk can show it.
const r = llmOut($input.first()) || {};
const prev = (($('Check passcode').first().json.learned || {}).rules) || [];
const tidy = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => String(typeof x === 'string' ? x : (x && x.text) || '').replace(/\\s+/g, ' ').trim()).filter((x) => x && x.length <= 160))];
let rules = tidy(r.rules);
if (!rules.length) rules = prev;
rules = rules.slice(0, 10);
const added = tidy(r.added).filter((x) => rules.includes(x) || true).slice(0, 3);
const company = $('CRM: load for learning').first().json.company || '';
const value = JSON.stringify({ rules, last: { at: new Date().toISOString(), company, added } });
return [{ json: { value, rules, added } }];
"""

JS_FORGET = """
// Removes one learned rule (by its text) from the list.
const b = $input.first().json.body || {};
const cur = $('Check passcode').first().json.learned || { rules: [] };
const text = String(b.rule || '').trim();
const rules = (cur.rules || []).filter((r) => r !== text);
const value = JSON.stringify({ rules, last: { ...(cur.last || {}), removed: text, at_removed: new Date().toISOString() } });
return [{ json: { value, message: rules.length < (cur.rules || []).length ? 'Forgot that rule. It applies from the next run.' : 'That rule was already gone.' } }];
"""

JS_WATCH_PICK = """
// The watcher looks at every account it could still re-engage: not sent, not set aside, not mid-run.
const SKIP = ['sent', 'in_gmail', 'cleaned_up', 'researching', 'drafting', 'reviewing', 'fact_checking'];
return $input.all().map((i) => i.json)
  .filter((a) => a && a.account_id && a.homepage_url && !SKIP.includes(a.status))
  .map((a) => ({ json: { account_id: a.account_id, company: a.company, homepage_url: a.homepage_url, news_query: a.news_query || a.company, status: a.status, edited: !!a.edited } }));
"""

JS_WATCH_COMPARE = r"""
// Compares today's homepage headlines with the last snapshot and looks for news that is new since the last check.
// Numbers are masked, so a changing counter on a homepage is not "news".
const accts = $('Watch: pick accounts').all().map((i) => i.json);
const homes = $('Watch: fetch homepage').all();
const feeds = $('Watch: fetch news').all();
const rows = $input.all().map((i) => i.json).filter((r) => r && r.account_id);
const prevBy = Object.fromEntries(rows.map((r) => [r.account_id, r]));
const now = new Date();
const FIRST_LOOKBACK_DAYS = 7;
const ADVERSE = /\b(layoffs?|laid off|lays off|lawsuit|sues|sued|breach|outage|resigns?|steps down|investigation|probe|down round|job cuts|cuts jobs|bankrupt)/i;
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
const clean = (s) => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const key = (s) => s.toLowerCase().replace(/\d+([.,]\d+)*/g, '#').replace(/[^a-z#% ]+/g, ' ').replace(/\s+/g, ' ').trim();
function headlines(html) {
  const out = [];
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (t) out.push(clean(t[1]));
  const d = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i); if (d) out.push(clean(d[1]));
  for (const m of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) out.push(clean(m[1]));
  const seen = new Set();
  return out.filter((l) => l.length >= 12 && l.length <= 160).filter((l) => { const k = key(l); if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}
function newsItems(xml, company) {
  const name = new RegExp('\\b' + String(company || '').split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  return [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const get = (tag) => { const r = m[1].match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>')); return r ? clean(r[1]) : ''; };
    const d = new Date(get('pubDate'));
    return { title: get('title'), url: get('link'), source: get('source'), ts: isNaN(d) ? 0 : d.getTime(), date: isNaN(d) ? '' : d.toISOString().slice(0, 10) };
  }).filter((n) => n.title && n.ts && name.test(n.title) && !ADVERSE.test(n.title));
}
const out = accts.map((a, i) => {
  if (!a.account_id) return null;
  const hj = homes[i] && homes[i].json;
  const html = hj && typeof hj.data === 'string' ? hj.data : '';
  const nj = feeds[i] && feeds[i].json;
  const xml = nj && typeof nj.data === 'string' ? nj.data : '';
  const prev = prevBy[a.account_id] || null;
  let prevLines = [];
  try { prevLines = prev && prev.lines ? JSON.parse(prev.lines) : []; } catch (e) {}
  const lines = html ? headlines(html) : prevLines;
  const prevKeys = new Set(prevLines.map(key));
  const newLines = prev && prevLines.length ? lines.filter((l) => !prevKeys.has(key(l))).slice(0, 3) : [];
  const since = prev && prev.checked_at ? new Date(prev.checked_at).getTime() : now.getTime() - FIRST_LOOKBACK_DAYS * 864e5;
  const freshNews = newsItems(xml, a.company).filter((n) => n.ts > since).sort((x, y) => y.ts - x.ts).slice(0, 3);
  const changes = [
    ...newLines.map((t) => ({ type: 'homepage', text: t, url: a.homepage_url, date: now.toISOString().slice(0, 10) })),
    ...freshNews.map((n) => ({ type: 'news', text: n.title, url: n.url, date: n.date, source: n.source })),
  ];
  const about = lines.slice(0, 2).join(' | ');
  let domain = ''; try { domain = new URL(a.homepage_url).hostname.replace(/^www\./, ''); } catch (e) {}
  const changed = changes.length > 0;
  return { json: {
    account_id: a.account_id, company: a.company, status: a.status, edited: a.edited,
    lines: JSON.stringify(lines), checked_at: now.toISOString(),
    changed_at: changed ? now.toISOString() : (prev && prev.changed_at) || '',
    changes: changed ? JSON.stringify(changes) : (prev && prev.changes) || '[]',
    changed_now: changed, baseline: !prev, homepage_read: !!html,
    prev_changed_at: (prev && prev.changed_at) || '', prev_changes: (prev && prev.changes) || '[]', about, domain,
  } };
}).filter(Boolean);
return out.length ? out : [{ json: { none: true } }];
"""

JS_WATCH_REL_INPUT = """
// One relevance check per watcher run: every account's candidate news headlines in a single request.
// Runs once per check, so it reads every account from the comparison step (its own input is only the first item).
const rows = $('Watch: compare').all().map((i) => i.json).filter((r) => r.account_id);
const accounts = rows.map((r) => {
  const news = JSON.parse(r.changes || '[]').map((c, k) => ({ n: k, ...c })).filter((c) => c.type === 'news');
  return r.changed_now && news.length ? { account_id: r.account_id, company: r.company, domain: r.domain, homepage_says: r.about, headlines: news.map((c) => ({ n: c.n, text: c.text, publisher: c.source || '' })) } : null;
}).filter(Boolean);
return [{ json: { relevance_input: accounts.length ? JSON.stringify({ accounts }) : 'NONE' } }];
"""

JS_WATCH_APPLY = """
// Keeps homepage changes as they are and only the news headlines the relevance filter judged to be about the company.
const rows = $('Watch: compare').all().map((i) => i.json);
const r = llmOut($input.first()) || {};
const keep = r.keep && typeof r.keep === 'object' ? r.keep : {};
const out = rows.map((row) => {
  if (!row.account_id || !row.changed_now) return row;
  const all = JSON.parse(row.changes || '[]');
  const ok = new Set((keep[row.account_id] || []).map(Number));
  const changes = all.filter((c, k) => c.type !== 'news' || ok.has(k));
  const changed = changes.length > 0;
  return { ...row, changes: changed ? JSON.stringify(changes) : row.prev_changes, changed_at: changed ? row.changed_at : row.prev_changed_at, changed_now: changed, dropped: all.length - changes.length };
});
return out.map((json) => ({ json }));
"""

JS_WATCH_SUMMARY = """
// One summary per check: what changed, which accounts to research and draft now, and how to call the run API.
const items = $('Watch: apply relevance').all().map((i) => i.json).filter((r) => r.account_id);
const changed = items.filter((r) => r.changed_now);
// Accounts with a draft Jayden edited are flagged but not redrafted, so an edit is never overwritten.
const queue = changed.filter((r) => !r.edited).map((r) => r.account_id);
const rows = $('Watch: read settings').all().map((i) => i.json).filter((r) => r && r.key);
const passcode = ((rows.find((r) => r.key === 'approve_passcode') || {}).value || '__TEST_PASS__').trim();
let source = 'schedule', base = '';
try { const h = $('Check passcode').first().json.headers || {}; source = 'api'; const host = h['x-forwarded-host'] || h.host; const proto = String(h['x-forwarded-proto'] || (/^(localhost|127\\.)/.test(String(host)) ? 'http' : 'https')).split(',')[0].trim(); base = proto + '://' + host; } catch (e) {}
if (!base) { try { base = new URL($execution.resumeUrl).origin; } catch (e) {} }
const names = (ids) => ids.map((id) => (items.find((r) => r.account_id === id) || {}).company).filter(Boolean);
const message = !items.length ? 'No accounts to watch right now.'
  : !changed.length ? `Checked ${items.length} accounts. Nothing new since the last check.`
  : `Checked ${items.length} accounts. New at ${names(changed.map((r) => r.account_id)).join(', ')}.` + (queue.length ? ` Researching and drafting ${names(queue).join(', ')} now.` : '') + (changed.length > queue.length ? ' Edited drafts were flagged, not redrafted.' : '');
return [{ json: { source, checked: items.length, baseline: items.filter((r) => r.baseline).length,
  changed: changed.map((r) => ({ account_id: r.account_id, company: r.company, changes: JSON.parse(r.changes || '[]') })),
  account_ids: queue, api_url: base + '/webhook/loopwell-api', passcode, message } }];
"""

JS_PREP_STYLE = r"""
// Saves the writing guide imported on the desk. Empty text resets to the default house style.
const b = $input.first().json.body || {};
const LIMIT = 15000;
const raw = String(b.md || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
const md = raw.slice(0, LIMIT);
const name = String(b.name || 'writing-guide.md').replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || 'writing-guide.md';
const words = md ? md.split(/\s+/).filter(Boolean).length : 0;
const value = md ? JSON.stringify({ name, md, words, truncated: raw.length > LIMIT, updated_at: new Date().toISOString() }) : '';
const message = !md ? 'Writing style reset to the default. It applies to the next run.'
  : raw.length > LIMIT ? `Saved the first ${LIMIT.toLocaleString('en-US')} characters of ${name}. It applies to the next run.`
  : `Saved ${name}. It applies to the next run.`;
return [{ json: { value, message } }];
"""

JS_DECISION = """
// Approve sends at most once: only a draft that is ready for review (or was rejected and is being
// reconsidered) and has a body and an address goes out. Everything else is skipped with a reason.
const req = $('Check passcode').first().json.body;
const want = req.action === 'approve' ? 'approve' : 'reject';
const r = $input.first().json || {};
const route = deliverTo(r, $('Check passcode').first().json.demo_inbox);
const NOW_IS = { queued: 'it is still queued', researching: 'it is still being researched', drafting: 'it is still being drafted',
  reviewing: 'it is still in quality checks', fact_checking: 'its facts are still being checked', rejected: 'it was already rejected', cooling_down: 'it is cooling down',
  cleaned_up: 'it was set aside as not a real prospect', expired: 'it is out of the re-engagement window', needs_review: 'it needs __SENDER__ first' };
let action = 'skip';
let reason = '';
if (!r.account_id) reason = 'that account is not in the CRM';
else if (['sent', 'in_gmail'].includes(r.status)) reason = 'it was already sent';
else if (want === 'reject') {
  if (r.status === 'awaiting_approval') action = 'reject'; else reason = NOW_IS[r.status] || `it is ${r.status}`;
} else if (!['awaiting_approval', 'rejected'].includes(r.status)) reason = NOW_IS[r.status] || `it is ${r.status}`;
else if (!r.draft_body || !r.contact_email) reason = 'the draft or the email address is missing';
else if (!route.to) reason = 'this is a made-up demo contact and no demo inbox is set. In n8n, open Data tables, loopwell_settings, and add a row: key demo_inbox, value your email';
else action = 'send';
const message = action === 'send' ? (route.demo ? `Sent. ${r.contact_name} is a demo contact, so it went to your inbox, ${route.to}.` : `Sent to ${r.contact_name}.`)
  : action === 'reject' ? `Rejected. Nothing was sent to ${r.contact_name}.`
  : `${want === 'reject' ? "Can't reject" : 'Not sent'}: ${reason}.`;
return [{ json: { ...r, send_to: route.to, demo: route.demo, action, message } }];
"""


KIND = {
    "n8n-nodes-base.code": "code", "n8n-nodes-base.dataTable": "table", "n8n-nodes-base.httpRequest": "http",
    "@n8n/n8n-nodes-langchain.chainLlm": "llm", "@n8n/n8n-nodes-langchain.lmChatOpenAi": "model",
    "n8n-nodes-base.if": "branch", "n8n-nodes-base.switch": "branch", "n8n-nodes-base.webhook": "webhook",
    "n8n-nodes-base.respondToWebhook": "respond", "n8n-nodes-base.gmail": "gmail", "n8n-nodes-base.scheduleTrigger": "schedule",
}


def graph_of(data):
    """The workflow as the dashboard draws it: sections (the sticky notes), nodes, connections and named paths."""
    stickies = [n for n in data["nodes"] if n["type"] == "n8n-nodes-base.stickyNote"]
    nodes = [n for n in data["nodes"] if n["type"] != "n8n-nodes-base.stickyNote"]
    secs = []
    for st in stickies:
        num, title = st["name"].split(" · ", 1)
        secs.append({"id": int(num), "title": title, "x": st["position"][0], "y": st["position"][1],
                     "w": st["parameters"]["width"], "h": st["parameters"]["height"]})
    secs.sort(key=lambda x: x["id"])

    def n_out(n):
        if n["type"].endswith(".switch"):
            return n["parameters"].get("numberOutputs", 4)
        if n["type"].endswith(".if") or n.get("onError") == "continueErrorOutput":
            return 2
        return 1

    def section(n):
        cx, cy = n["position"][0] + 50, n["position"][1] + 50
        def dist(x):
            dx = max(x["x"] - cx, 0, cx - x["x"] - x["w"]); dy = max(x["y"] - cy, 0, cy - x["y"] - x["h"])
            return dx * dx + dy * dy
        return min(secs, key=dist)["id"]

    idx = {n["name"]: i for i, n in enumerate(nodes)}
    out = [[n["name"], "gmail" if n["name"] == "Gmail: send email" else KIND.get(n["type"], "other"),
            n["position"][0], n["position"][1], max(100, n_out(n) * 18 + 20) if n["type"].endswith(".switch") else 100,
            0 if n["type"].endswith("lmChatOpenAi") else section(n), n_out(n)] for n in nodes]
    conns = data["connections"]
    edges, ai = [], []
    for src, kinds in conns.items():
        for kind, outs in kinds.items():
            for oi, lst in enumerate(outs):
                for c in lst:
                    (edges.append([idx[src], oi, idx[c["node"]]]) if kind == "main" else ai.append([idx[src], idx[c["node"]]]))

    def walk(starts, stop=()):
        seen, order, q = set(), [], list(starts)
        while q:
            n = q.pop(0)
            if n in seen or n in stop:
                continue
            seen.add(n); order.append(n)
            for lst in conns.get(n, {}).get("main", []):
                q.extend(c["node"] for c in lst)
        return order

    route = lambda i: [c["node"] for c in conns["Route action"]["main"][i]]
    paths = {
        "page": ["Webhook: dashboard page", "Build dashboard page", "Respond: page"],
        "gate": ["Webhook: API", "Settings: passcode", "Check passcode", "Route action"],
        "list": walk(route(0)), "run": walk(route(1), stop={"Fetch homepage"}),
        "edit": walk(route(2), stop={"CRM: load for learning"}), "learn": walk(["CRM: load for learning"]),
        "reset": walk(route(3)), "decide": ["CRM: load for decision", "Decision", "Send or reject?"],
        "sent": ["Gmail: send email", "CRM: mark sent", "Respond: decision"], "rejected": ["CRM: mark rejected", "Respond: decision"],
        "skipped": ["Respond: decision"], "failed": ["Gmail: send email", "Respond: send failed"],
        "style": walk(route(6)), "watch": walk(route(7)), "forget": walk(route(8)), "refuse": route(9),
        "schedule": walk(["Every morning"]),
    }
    return {"sections": secs, "nodes": out, "edges": edges, "ai": ai,
            "paths": {k: [idx[n] for n in v] for k, v in paths.items()}}


def build(test=False, mock="http://127.0.0.1:8765"):
    wf = WF("Loopwell · Re-engagement desk" + (" (local test)" if test else ""))
    seed = copy.deepcopy(SEED)
    if test:
        for a in seed:
            if a["homepage_url"]:
                a["homepage_url"] = f"{mock}/home/{a['account_id']}"
    news_base = f"{mock}/rss" if test else "https://news.google.com/rss/search"
    cred_openai = {"openAiApi": {"id": "loopwelltestcred1", "name": "Mock OpenAI"}} if test else None

    X, Y = 0, 0
    # ---------------- Section 1: dashboard + API
    sticky(wf, "1 · Review desk + API",
           "GET **/webhook/loopwell** serves the dashboard. The page talks to **/webhook/loopwell-api** with nine actions: list, run, edit, reset, approve, reject, style_set, watch, forget_rule. Viewing is open; every change needs the passcode from the loopwell_settings Data Table.",
           (-40, -720), 2040, 1800, 7)
    wf.add("Webhook: dashboard page", "n8n-nodes-base.webhook", 2.1,
           {"path": "loopwell", "responseMode": "responseNode", "options": {}}, (X, -40), webhookId=uid())
    wf.add("Build dashboard page", "n8n-nodes-base.code", 2,
           code(JS_PAGE.replace("__HTML__", json.dumps(DASH.replace("__LIB__", LIB)))), (X + 220, -40))
    wf.add("Respond: page", "n8n-nodes-base.respondToWebhook", 1.1,
           respond("={{ $json.html }}", "text/html; charset=utf-8"), (X + 440, -40))
    wf.chain("Webhook: dashboard page", "Build dashboard page", "Respond: page")

    wf.add("Webhook: API", "n8n-nodes-base.webhook", 2.1,
           {"httpMethod": "POST", "path": "loopwell-api", "responseMode": "responseNode", "options": {}}, (X, 340), webhookId=uid())
    if True:  # same in both builds; the local test build falls back to passcode test-pass
        wf.add("Settings: passcode", "n8n-nodes-base.dataTable", 1.1, {
            "resource": "row", "operation": "get", "dataTableId": {"__rl": True, "mode": "name", "value": SETTINGS},
            "returnAll": True, "matchType": "anyCondition", "filters": {}},
            (X + 160, 340), alwaysOutputData=True, onError="continueRegularOutput")
    wf.add("Check passcode", "n8n-nodes-base.code", 2, code(JS_CHECK_PASS.replace("__TEST_PASS__", "test-pass" if test else "").replace("__TEST_INBOX__", "inbox@loopwell.test" if test else "")), (X + 320, 340))
    wf.add("Route action", "n8n-nodes-base.switch", 3.2,
           {"mode": "expression", "numberOutputs": 10,
            "output": "={{ $json.auth !== 'ok' ? 9 : ({ list: 0, run: 1, edit: 2, reset: 3, approve: 4, reject: 5, style_set: 6, watch: 7, forget_rule: 8 })[$json.body.action] ?? 0 }}"},
           (X + 480, 340))
    wf.chain("Webhook: API", "Settings: passcode", "Check passcode", "Route action")
    wf.add("Respond: passcode needed", "n8n-nodes-base.respondToWebhook", 1.1, respond(
        "={{ JSON.stringify({ ok: false, error: 'passcode', message: $json.auth === 'not_set' "
        "? 'No passcode is set yet. In n8n, open Data tables, loopwell_settings, and add a row: key approve_passcode, value your passcode.' "
        ": 'Wrong passcode.' }) }}"), (X + 700, -120))
    wf.link("Route action", "Respond: passcode needed", out=9)
    # style_set: save an imported writing guide (Markdown) to loopwell_settings
    wf.add("Prepare style", "n8n-nodes-base.code", 2, code(JS_PREP_STYLE), (X + 740, -320))
    wf.add("Settings: create table", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "table", "operation": "create", "tableName": SETTINGS,
        "columns": {"column": [{"name": "key", "type": "string"}, {"name": "value", "type": "string"}]}, "options": {"createIfNotExists": True}},
        (X + 960, -320))
    wf.add("Settings: save style", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "upsert", "dataTableId": {"__rl": True, "mode": "name", "value": SETTINGS},
        "matchType": "allConditions", "filters": {"conditions": [{"keyName": "key", "condition": "eq", "keyValue": "style"}]},
        "columns": {"mappingMode": "defineBelow", "value": {"key": "style", "value": "={{ $('Prepare style').first().json.value }}"},
                    "matchingColumns": [], "attemptToConvertTypes": False, "convertFieldsToString": False,
                    "schema": [{"id": k, "displayName": k, "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True} for k in ("key", "value")]},
        "options": {}}, (X + 1180, -320))
    wf.add("Respond: style saved", "n8n-nodes-base.respondToWebhook", 1.1,
           respond("={{ JSON.stringify({ ok: true, message: $('Prepare style').first().json.message }) }}"), (X + 1400, -320))
    wf.link("Route action", "Prepare style", out=6)
    wf.chain("Prepare style", "Settings: create table", "Settings: save style", "Respond: style saved")
    # list
    wf.add("CRM: read all", "n8n-nodes-base.dataTable", 1.1, dt_get(), (X + 740, 40),
           alwaysOutputData=True, onError="continueRegularOutput")
    wf.add("Shape account list", "n8n-nodes-base.code", 2, code(JS_DEMO + JS_SHAPE_LIST, lib=True), (X + 1180, 40))
    wf.add("Respond: list", "n8n-nodes-base.respondToWebhook", 1.1, respond("={{ JSON.stringify($json) }}"), (X + 1400, 40))
    wf.link("Route action", "CRM: read all", out=0)
    wf.add("Watch: read for list", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "get", "dataTableId": {"__rl": True, "mode": "name", "value": WATCH}, "returnAll": True,
        "matchType": "anyCondition", "filters": {}}, (X + 960, 40), alwaysOutputData=True, onError="continueRegularOutput", executeOnce=True)
    wf.chain("CRM: read all", "Watch: read for list", "Shape account list", "Respond: list")
    # run
    wf.add("Respond: run started", "n8n-nodes-base.respondToWebhook", 1.1, respond('{"ok":true,"started":true}'), (X + 740, 320))
    wf.add("CRM: read for run", "n8n-nodes-base.dataTable", 1.1, dt_get(), (X + 960, 320))
    wf.add("Triage & route", "n8n-nodes-base.code", 2, code(JS_TRIAGE), (X + 1180, 320))
    wf.add("CRM: write triage", "n8n-nodes-base.dataTable", 1.1, dt_update({
        "status": "={{ $json.status }}", "track": "={{ $json.track }}", "triage_note": "={{ $json.triage_note }}",
        "signal": "", "research_json": "", "draft_subject": "", "draft_body": "", "qa_json": "",
        "score": 0, "passes": 0, "edited": False, "gmail_draft_id": "", "updated_at": NOW}),
        (X + 1400, 180), onError="continueRegularOutput")
    wf.add("Eligible accounts", "n8n-nodes-base.code", 2, code(JS_ELIGIBLE), (X + 1400, 320))
    wf.link("Route action", "Respond: run started", out=1)
    wf.chain("Respond: run started", "CRM: read for run", "Triage & route")
    wf.link("Triage & route", "CRM: write triage")
    wf.link("Triage & route", "Eligible accounts")
    # edit
    wf.add("Prepare edit", "n8n-nodes-base.code", 2, code(JS_PREP_EDIT), (X + 740, 540))
    wf.add("CRM: save edit", "n8n-nodes-base.dataTable", 1.1, dt_update({
        "draft_subject": "={{ $json.draft_subject }}", "draft_body": "={{ $json.draft_body }}", "edited": True, "updated_at": NOW}),
        (X + 960, 540))
    wf.add("Respond: edit saved", "n8n-nodes-base.respondToWebhook", 1.1, respond('{"ok":true}'), (X + 1180, 540))
    wf.link("Route action", "Prepare edit", out=2)
    wf.chain("Prepare edit", "CRM: save edit", "Respond: edit saved")
    # reset
    wf.add("CRM: create table", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "table", "operation": "create", "tableName": TABLE,
        "columns": {"column": [{"name": n, "type": t} for n, t in COLUMNS]}, "options": {"createIfNotExists": True}},
        (X + 740, 900))
    wf.add("CRM: clear rows", "n8n-nodes-base.dataTable", 1.1,
           {"resource": "table", "operation": "clear", "dataTableId": dt_rl()}, (X + 960, 900))
    wf.add("Seed demo accounts", "n8n-nodes-base.code", 2, code(JS_SEED.replace("__SEED__", json.dumps(seed, indent=1))), (X + 1180, 900))
    wf.add("CRM: insert rows", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "insert", "dataTableId": dt_rl(),
        "columns": {"mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [], "schema": schema_for([c for c, _ in COLUMNS])},
        "options": {}}, (X + 1400, 900))
    wf.add("Count rows", "n8n-nodes-base.code", 2, code(JS_COUNT), (X + 1620, 900))
    wf.add("Respond: CRM loaded", "n8n-nodes-base.respondToWebhook", 1.1, respond("={{ JSON.stringify($json) }}"), (X + 1840, 900))
    wf.link("Route action", "CRM: create table", out=3)
    wf.chain("CRM: create table", "CRM: clear rows", "Seed demo accounts", "CRM: insert rows", "Count rows", "Respond: CRM loaded")

    # ---------------- Section 2: research agent
    RX = 2120
    sticky(wf, "2 · Research agent",
           "Reads each company's homepage and the last 120 days of Google News. The agent picks one opener signal; code then checks the quote word-for-word in the source and drops anything adverse or unverifiable.",
           (RX - 40, -40), 1140, 560, 5)
    ua = {"parameters": [{"name": "User-Agent", "value": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"},
                         {"name": "Accept-Language", "value": "en-US,en;q=0.9"}]}
    http_opts = {"response": {"response": {"responseFormat": "text", "outputPropertyName": "data"}}, "timeout": 12000,
                 "redirect": {"redirect": {"followRedirects": True, "maxRedirects": 5}}}
    wf.add("Fetch homepage", "n8n-nodes-base.httpRequest", 4.2, {
        "url": "={{ $json.homepage_url }}", "sendHeaders": True, "headerParameters": ua, "options": http_opts},
        (RX, 300), onError="continueRegularOutput")
    wf.add("Fetch news", "n8n-nodes-base.httpRequest", 4.2, {
        "url": "=" + news_base + "?q={{ encodeURIComponent($('Eligible accounts').item.json.news_query + ' when:120d') }}&hl=en-US&gl=US&ceid=US:en",
        "sendHeaders": True, "headerParameters": ua, "options": http_opts}, (RX + 220, 300), onError="continueRegularOutput")
    wf.add("Build sources", "n8n-nodes-base.code", 2, code(JS_SOURCES, lib=True), (RX + 440, 300))
    wf.add("Research agent", "@n8n/n8n-nodes-langchain.chainLlm", 1.7, llm(P["research"], "={{ $json.research_input }}"), (RX + 660, 300))
    wf.add("Verify signal", "n8n-nodes-base.code", 2, code(JS_VERIFY, lib=True), (RX + 880, 300))
    wf.add("CRM: write research", "n8n-nodes-base.dataTable", 1.1, dt_update({
        "status": "drafting", "signal": "={{ $json.signal_text }}", "research_json": "={{ $json.research_json }}", "updated_at": NOW}),
        (RX + 880, 120), onError="continueRegularOutput")
    wf.link("Eligible accounts", "Fetch homepage")
    wf.chain("Fetch homepage", "Fetch news", "Build sources", "Research agent", "Verify signal")
    wf.link("Verify signal", "CRM: write research")

    # ---------------- Section 3: drafting agent
    DX = RX + 1160
    sticky(wf, "3 · Drafting agent",
           "Writes in __SENDER__'s voice using the recovered re-engagement skill: angle by track, loss-reason rules, 3 to 5 short lines, a Friday ask in their timezone.",
           (DX - 40, -40), 480, 560, 6)
    wf.add("Drafting agent", "@n8n/n8n-nodes-langchain.chainLlm", 1.7, llm(P["draft"], "={{ $json.draft_input }}"), (DX, 300))
    wf.add("Rule checks v1", "n8n-nodes-base.code", 2, code(JS_CHECK_V1, lib=True), (DX + 220, 300))
    wf.add("CRM: write first draft", "n8n-nodes-base.dataTable", 1.1, dt_update({
        "status": "reviewing", "draft_subject": "={{ $json.cur.subject }}", "draft_body": "={{ $json.cur.body }}", "updated_at": NOW}),
        (DX + 220, 120), onError="continueRegularOutput")
    wf.link("Verify signal", "Drafting agent")
    wf.link("Drafting agent", "Rule checks v1")
    wf.link("Rule checks v1", "CRM: write first draft")

    # ---------------- Section 4: quality gate
    QX = DX + 480
    sticky(wf, "4 · Quality gate (up to 3 passes)",
           "Each pass = 15 deterministic rule checks in code + an LLM judge for grounding, angle and tone. Failing drafts get rewritten with the exact failures; passing drafts skip ahead untouched.",
           (QX - 40, -40), 2240, 560, 4)
    names = [("Quality judge v1", "llm_j", "judge_input"), ("Score v1", "score", "Rule checks v1"),
             ("Revise v1", "llm_r", "revise_input"), ("Apply revision v1", "apply", "Score v1"),
             ("Quality judge v2", "llm_j", "judge_input"), ("Score v2", "score", "Apply revision v1"),
             ("Revise v2", "llm_r", "revise_input"), ("Apply revision v2", "apply", "Score v2"),
             ("Quality judge v3", "llm_j", "judge_input"), ("Final scoring", "final", None)]
    prev_node = "Rule checks v1"
    for k, (n, kind, arg) in enumerate(names):
        pos = (QX + 220 * k, 300)
        if kind == "llm_j":
            wf.add(n, "@n8n/n8n-nodes-langchain.chainLlm", 1.7, llm(P["judge"], "={{ $json.judge_input }}"), pos)
        elif kind == "llm_r":
            wf.add(n, "@n8n/n8n-nodes-langchain.chainLlm", 1.7, llm(P["draft"] + "\n" + P["revise"], "={{ $json.revise_input }}"), pos)
        elif kind == "score":
            wf.add(n, "n8n-nodes-base.code", 2, code(js_score(arg), lib=True), pos)
        elif kind == "apply":
            wf.add(n, "n8n-nodes-base.code", 2, code(js_apply(arg), lib=True), pos)
        else:
            wf.add(n, "n8n-nodes-base.code", 2, code(JS_FINAL, lib=True), pos)
        wf.link(prev_node, n)
        prev_node = n

    # ---------------- Section 5: hand-off
    HX = QX + 2240
    sticky(wf, "5 · Fact check → ready for review",
           "The fact checker lists every claim in the final draft with its source. Code marks a claim verified only if it finds the evidence word-for-word in the cited CRM field or web quote. Then the draft is saved and marked ready for review.",
           (HX - 40, -40), 760, 520, 3)
    wf.add("Fact-check agent", "@n8n/n8n-nodes-langchain.chainLlm", 1.7, llm(P["factcheck"], "={{ $json.factcheck_input }}"), (HX, 300))
    wf.add("Verify facts", "n8n-nodes-base.code", 2, code(JS_VERIFY_FACTS, lib=True), (HX + 220, 300))
    wf.add("CRM: write final draft", "n8n-nodes-base.dataTable", 1.1, dt_update({
        "status": "awaiting_approval", "draft_subject": "={{ $json.draft_subject }}", "draft_body": "={{ $json.draft_body }}",
        "score": "={{ $json.score }}", "passes": "={{ $json.passes }}", "qa_json": "={{ $json.qa_json }}", "updated_at": NOW}),
        (HX + 440, 300))
    wf.add("CRM: mark fact check", "n8n-nodes-base.dataTable", 1.1, dt_update({"status": "fact_checking", "updated_at": NOW}),
           (HX, 120), onError="continueRegularOutput")
    wf.link("Final scoring", "CRM: mark fact check")
    wf.chain("Final scoring", "Fact-check agent", "Verify facts", "CRM: write final draft")

    # shared model
    # gpt-5-mini via the Responses API works with n8n Cloud Gateway credits (gpt-4.1-mini and JSON mode do not).
    model_params = {"model": {"__rl": True, "mode": "list", "value": "gpt-5-mini", "cachedResultName": "gpt-5-mini"},
                    "options": {"reasoningEffort": "low", "timeout": 90000, "maxRetries": 2}}
    extra = {"credentials": cred_openai} if cred_openai else {}
    wf.add("OpenAI Chat Model", "@n8n/n8n-nodes-langchain.lmChatOpenAi", 1.3, model_params, (DX + 600, 640), **extra)
    for n in ["Research agent", "Drafting agent", "Quality judge v1", "Revise v1", "Quality judge v2", "Revise v2", "Quality judge v3", "Fact-check agent", "Watch: relevance check", "Style learner"]:
        wf.link("OpenAI Chat Model", n, kind="ai_languageModel")

    # ---------------- Section 6: approval on the desk
    AY = 1400
    sticky(wf, "6 · Approve on the desk → send from Gmail",
           "Approve & send re-reads the latest saved draft (so edits count) and sends it from Gmail. Each account is emailed at most once; repeats and accounts that are not ready are skipped. Reject sends nothing.",
           (X + 700, AY - 260), 1560, 700, 2)
    wf.add("CRM: load for decision", "n8n-nodes-base.dataTable", 1.1, dt_get("={{ $json.body.account_id }}"),
           (X + 740, AY), alwaysOutputData=True)
    wf.add("Decision", "n8n-nodes-base.code", 2, code(JS_DEMO + JS_DECISION), (X + 960, AY))
    wf.add("Send or reject?", "n8n-nodes-base.switch", 3.2,
           {"mode": "expression", "numberOutputs": 3, "output": "={{ ({ send: 0, reject: 1, skip: 2 })[$json.action] ?? 2 }}"},
           (X + 1180, AY))
    if test:
        wf.add("Gmail: send email", "n8n-nodes-base.code", 2, code(
            "const r = $input.first().json;\n"
            "if (String(r.draft_subject).includes('[fail]')) throw new Error('Simulated Gmail failure');\n"
            "return [{ json: { id: 'sent-test-to-' + r.send_to, threadId: 't1', labelIds: ['SENT'] } }];"),
            (X + 1400, AY - 100), onError="continueErrorOutput")
    else:
        wf.add("Gmail: send email", "n8n-nodes-base.gmail", 2.1, {
            "resource": "message", "operation": "send", "sendTo": "={{ $json.send_to }}",
            "subject": "={{ $json.draft_subject }}", "emailType": "text", "message": "={{ $json.draft_body }}",
            "options": {"appendAttribution": False}}, (X + 1400, AY - 100), onError="continueErrorOutput")
    # The sent Gmail message id goes in the existing gmail_draft_id column (no table migration needed).
    wf.add("CRM: mark sent", "n8n-nodes-base.dataTable", 1.1, dt_update(
        {"status": "sent", "gmail_draft_id": "={{ $json.id }}", "updated_at": NOW},
        id_expr="={{ $('Decision').first().json.account_id }}"), (X + 1620, AY - 100))
    wf.add("CRM: mark rejected", "n8n-nodes-base.dataTable", 1.1, dt_update(
        {"status": "rejected", "updated_at": NOW}, id_expr="={{ $json.account_id }}"), (X + 1400, AY + 80))
    wf.add("Respond: decision", "n8n-nodes-base.respondToWebhook", 1.1, respond(
        "={{ JSON.stringify({ ok: $('Decision').first().json.action !== 'skip', "
        "result: ({ send: 'sent', reject: 'rejected', skip: 'skipped' })[$('Decision').first().json.action], "
        "message: $('Decision').first().json.message }) }}"), (X + 1840, AY))
    wf.add("Respond: send failed", "n8n-nodes-base.respondToWebhook", 1.1, respond(
        "={{ JSON.stringify({ ok: false, result: 'failed', message: 'Gmail could not send it, so nothing went out: ' "
        "+ (($json.error && ($json.error.message || $json.error)) || 'unknown error') }) }}"), (X + 1620, AY + 240))
    wf.link("Route action", "CRM: load for decision", out=4)
    wf.link("Route action", "CRM: load for decision", out=5)
    wf.chain("CRM: load for decision", "Decision", "Send or reject?")
    wf.link("Send or reject?", "Gmail: send email", out=0)
    wf.link("Send or reject?", "CRM: mark rejected", out=1)
    wf.link("Send or reject?", "Respond: decision", out=2)
    wf.link("Gmail: send email", "CRM: mark sent", out=0)
    wf.link("Gmail: send email", "Respond: send failed", out=1)
    wf.link("CRM: mark sent", "Respond: decision")
    wf.link("CRM: mark rejected", "Respond: decision")



    # ---------- learn from edits: after an edit is saved (and answered), compare it with the AI draft
    wf.add("CRM: load for learning", "n8n-nodes-base.dataTable", 1.1, dt_get("={{ $('Prepare edit').first().json.account_id }}"), (X + 740, 720), alwaysOutputData=True)
    wf.add("Learn: compare", "n8n-nodes-base.code", 2, code(JS_LEARN_INPUT, lib=True), (X + 960, 720))
    wf.add("Edit changed the wording?", "n8n-nodes-base.if", 2.2, {
        "conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                       "conditions": [{"id": uid(), "leftValue": "={{ $json.learn }}", "rightValue": True,
                                       "operator": {"type": "boolean", "operation": "true", "singleValue": True}}], "combinator": "and"}, "options": {}},
        (X + 1180, 720))
    wf.add("Style learner", "@n8n/n8n-nodes-langchain.chainLlm", 1.7, llm(P["learn"], "={{ $json.learn_input }}"), (X + 1400, 720))
    wf.add("Learn: merge rules", "n8n-nodes-base.code", 2, code(JS_LEARN_MERGE, lib=True), (X + 1620, 720))
    wf.add("Settings: save learned", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "upsert", "dataTableId": {"__rl": True, "mode": "name", "value": SETTINGS},
        "matchType": "allConditions", "filters": {"conditions": [{"keyName": "key", "condition": "eq", "keyValue": "learned"}]},
        "columns": {"mappingMode": "defineBelow", "value": {"key": "learned", "value": "={{ $json.value }}"},
                    "matchingColumns": [], "attemptToConvertTypes": False, "convertFieldsToString": False,
                    "schema": [{"id": k, "displayName": k, "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True} for k in ("key", "value")]},
        "options": {}}, (X + 1840, 720))
    wf.chain("Respond: edit saved", "CRM: load for learning", "Learn: compare", "Edit changed the wording?")
    wf.link("Edit changed the wording?", "Style learner", out=0)
    wf.chain("Style learner", "Learn: merge rules", "Settings: save learned")
    # forget one learned rule from the Writing style panel
    wf.add("Prepare forget", "n8n-nodes-base.code", 2, code(JS_FORGET), (X + 740, -520))
    wf.add("Settings: forget rule", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "upsert", "dataTableId": {"__rl": True, "mode": "name", "value": SETTINGS},
        "matchType": "allConditions", "filters": {"conditions": [{"keyName": "key", "condition": "eq", "keyValue": "learned"}]},
        "columns": {"mappingMode": "defineBelow", "value": {"key": "learned", "value": "={{ $('Prepare forget').first().json.value }}"},
                    "matchingColumns": [], "attemptToConvertTypes": False, "convertFieldsToString": False,
                    "schema": [{"id": k, "displayName": k, "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True} for k in ("key", "value")]},
        "options": {}}, (X + 960, -520))
    wf.add("Respond: forgot", "n8n-nodes-base.respondToWebhook", 1.1,
           respond("={{ JSON.stringify({ ok: true, message: $('Prepare forget').first().json.message }) }}"), (X + 1180, -520))
    wf.link("Route action", "Prepare forget", out=8)
    wf.chain("Prepare forget", "Settings: forget rule", "Respond: forgot")

    # ---------- Section 7: signal watcher (daily at 8:03 and on demand from the desk)
    WY = 2280
    sticky(wf, "7 · Signal watcher",
           "Every morning (and when you click Check for new signals) it re-reads each open account's homepage and recent news. New homepage headlines since the last snapshot, or fresh news that an AI relevance check confirms is really about the company, mark the account New signal and send it through research and drafting. Cooldowns still apply; edited drafts are flagged, never overwritten.",
           (-40, WY - 380), 3300, 760, 4)
    wf.add("Every morning", "n8n-nodes-base.scheduleTrigger", 1.2,
           {"rule": {"interval": [{"field": "days", "daysInterval": 1, "triggerAtHour": 8, "triggerAtMinute": 3}]}}, (0, WY))
    wf.add("Watch: read settings", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "get", "dataTableId": {"__rl": True, "mode": "name", "value": SETTINGS}, "returnAll": True,
        "matchType": "anyCondition", "filters": {}}, (220, WY), alwaysOutputData=True, onError="continueRegularOutput", executeOnce=True)
    wf.add("Watch: read CRM", "n8n-nodes-base.dataTable", 1.1, dt_get(), (440, WY), alwaysOutputData=True, onError="continueRegularOutput", executeOnce=True)
    wf.add("Watch: pick accounts", "n8n-nodes-base.code", 2, code(JS_WATCH_PICK), (660, WY), alwaysOutputData=True)
    wf.add("Watch: fetch homepage", "n8n-nodes-base.httpRequest", 4.2, {
        "url": "={{ $json.homepage_url }}", "sendHeaders": True, "headerParameters": ua, "options": http_opts},
        (880, WY), onError="continueRegularOutput")
    wf.add("Watch: fetch news", "n8n-nodes-base.httpRequest", 4.2, {
        "url": "=" + news_base + "?q={{ encodeURIComponent($('Watch: pick accounts').item.json.news_query + ' when:30d') }}&hl=en-US&gl=US&ceid=US:en",
        "sendHeaders": True, "headerParameters": ua, "options": http_opts}, (1100, WY), onError="continueRegularOutput")
    wf.add("Watch: create table", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "table", "operation": "create", "tableName": WATCH,
        "columns": {"column": [{"name": n, "type": "string"} for n in WATCH_COLS]}, "options": {"createIfNotExists": True}},
        (1320, WY), executeOnce=True)
    wf.add("Watch: read snapshots", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "get", "dataTableId": {"__rl": True, "mode": "name", "value": WATCH}, "returnAll": True,
        "matchType": "anyCondition", "filters": {}}, (1540, WY), alwaysOutputData=True, onError="continueRegularOutput", executeOnce=True)
    wf.add("Watch: compare", "n8n-nodes-base.code", 2, code(JS_WATCH_COMPARE), (1760, WY))
    wf.add("Watch: save snapshots", "n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "upsert", "dataTableId": {"__rl": True, "mode": "name", "value": WATCH},
        "matchType": "allConditions", "filters": {"conditions": [{"keyName": "account_id", "condition": "eq", "keyValue": "={{ $json.account_id }}"}]},
        "columns": {"mappingMode": "defineBelow", "value": {n: "={{ $json." + n + " }}" for n in WATCH_COLS}, "matchingColumns": [],
                    "attemptToConvertTypes": False, "convertFieldsToString": False,
                    "schema": [{"id": n, "displayName": n, "required": False, "defaultMatch": False, "display": True, "type": "string", "canBeUsedToMatch": True} for n in WATCH_COLS]},
        "options": {}}, (2860, WY - 260))
    wf.add("Real accounts only", "n8n-nodes-base.if", 2.2, {
        "conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                       "conditions": [{"id": uid(), "leftValue": "={{ $json.account_id }}", "rightValue": "",
                                       "operator": {"type": "string", "operation": "notEmpty", "singleValue": True}}], "combinator": "and"}, "options": {}},
        (2640, WY - 260))
    wf.add("Watch: summary", "n8n-nodes-base.code", 2, code(JS_WATCH_SUMMARY.replace("__TEST_PASS__", "test-pass" if test else "")), (2640, WY), executeOnce=True)
    wf.add("Anything to draft?", "n8n-nodes-base.if", 2.2, {
        "conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                       "conditions": [{"id": uid(), "leftValue": "={{ $json.account_ids.length }}", "rightValue": 0,
                                       "operator": {"type": "number", "operation": "gt"}}], "combinator": "and"}, "options": {}}, (2860, WY - 100))
    wf.add("Watch: queue drafts", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": "={{ $json.api_url }}", "sendBody": True, "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ action: 'run', account_ids: $json.account_ids.join(','), trigger: 'watch', passcode: $json.passcode }) }}",
        "options": {"timeout": 15000}}, (3080, WY - 100), onError="continueRegularOutput")
    wf.add("From the desk?", "n8n-nodes-base.if", 2.2, {
        "conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                       "conditions": [{"id": uid(), "leftValue": "={{ $('Watch: summary').first().json.source }}", "rightValue": "api",
                                       "operator": {"type": "string", "operation": "equals"}}], "combinator": "and"}, "options": {}}, (2860, WY + 100))
    wf.add("Respond: watch", "n8n-nodes-base.respondToWebhook", 1.1, respond(
        "={{ JSON.stringify({ ok: true, checked: $('Watch: summary').first().json.checked, changed: $('Watch: summary').first().json.changed, "
        "drafting: $('Watch: summary').first().json.account_ids, message: $('Watch: summary').first().json.message }) }}"), (3080, WY + 100))
    wf.chain("Every morning", "Watch: read settings", "Watch: read CRM", "Watch: pick accounts", "Watch: fetch homepage", "Watch: fetch news",
             "Watch: create table", "Watch: read snapshots", "Watch: compare")
    wf.add("Watch: relevance input", "n8n-nodes-base.code", 2, code(JS_WATCH_REL_INPUT), (1980, WY + 160), executeOnce=True)
    wf.add("Watch: relevance check", "@n8n/n8n-nodes-langchain.chainLlm", 1.7, llm(P["relevance"], "={{ $json.relevance_input }}"), (2200, WY + 160))
    wf.add("Watch: apply relevance", "n8n-nodes-base.code", 2, code(JS_WATCH_APPLY, lib=True), (2420, WY + 160))
    wf.chain("Watch: compare", "Watch: relevance input", "Watch: relevance check", "Watch: apply relevance")
    wf.link("Watch: apply relevance", "Real accounts only")
    wf.link("Real accounts only", "Watch: save snapshots", out=0)
    wf.link("Watch: apply relevance", "Watch: summary")
    wf.link("Route action", "Watch: read settings", out=7)
    wf.link("Watch: summary", "From the desk?")
    wf.link("Watch: summary", "Anything to draft?")
    wf.link("Anything to draft?", "Watch: queue drafts", out=0)
    wf.link("From the desk?", "Respond: watch", out=0)

    data = wf.json()
    # The desk draws this workflow live, so the page carries its own graph.
    graph = json.dumps(graph_of(data), separators=(",", ":"))
    page = next(n for n in data["nodes"] if n["name"] == "Build dashboard page")
    page["parameters"] = code(JS_PAGE.replace("__HTML__", json.dumps(DASH.replace("__LIB__", LIB).replace("__GRAPH__", graph))))
    if test:
        data["id"] = "loopwellTest0001"
        data["active"] = False
    return data


if __name__ == "__main__":
    (OUT / "loopwell-n8n-workflow.json").write_text(json.dumps(build(False), indent=2))
    (OUT / "loopwell-local-test.json").write_text(json.dumps(build(True), indent=2))
    print("built", [p.name for p in OUT.iterdir()])
