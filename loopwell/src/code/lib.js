// ---- Loopwell shared helpers (inlined into each Code node that needs them) ----
// Who the emails come from. build.py also writes this name into every prompt.
const SENDER = 'Jayden';
// LLM chain nodes return {text: "..."} or, when the model answers in JSON mode, the parsed object itself.
function llmOut(item) {
  const j = (item && item.json) || {};
  if (typeof j.text === 'string' && Object.keys(j).length === 1) return parseJSON(j.text);
  if (j.output !== undefined) return parseJSON(j.output);
  return Object.keys(j).length ? j : null;
}

function parseJSON(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  const candidates = [s];
  if (a >= 0 && b > a) candidates.push(s.slice(a, b + 1));
  for (const c of candidates) { try { return JSON.parse(c); } catch (e) {} }
  for (const c of candidates) { try { return JSON.parse(repairJSON(c)); } catch (e) {} }
  return null;
}

// Models sometimes break JSON in two ways: a raw line break inside a string, or a stray
// unescaped quote mid-sentence (e.g. `\n"You'd made...`). Walk the text and escape both.
// A quote only closes a string when what follows is JSON structure (: , } ]), never prose.
const CLOSES_STRING = /\s*(?:[:}\]]|$|,\s*(?:"|\{|\[|\}|\]|-?\d|true\b|false\b|null\b))/y;
function repairJSON(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) { out += c; if (c === '"') inStr = true; continue; }
    if (c === '\\') { out += c + (s[i + 1] === undefined ? '' : s[i + 1]); i++; continue; }
    if (c === '\n') { out += '\\n'; continue; }
    if (c === '\r') continue;
    if (c === '\t') { out += '\\t'; continue; }
    if (c === '"') {
      CLOSES_STRING.lastIndex = i + 1;
      if (CLOSES_STRING.test(s)) { out += c; inStr = false; } else out += '\\"';
      continue;
    }
    out += c;
  }
  return out;
}

// True when a draft body is really a leaked JSON object instead of the email text.
function looksLikeJSON(body) {
  const b = String(body || '').trim();
  return /^[{[]/.test(b) || /"(subject|body|angle|notes)"\s*:/.test(b);
}

const BANNED = [
  'hope this finds you well', "hope you're well", 'hope you are well', 'circling back', 'circle back',
  'touching base', 'just checking in', 'i wanted to reach out', 'reaching out', 'quick question',
  'per my last email', 'hop on a call', 'pick your brain', 'synergy', 'leverage', 'game-changer',
  'game changer', 'ai-native', 'at your earliest convenience', 'no worries if not',
];

function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

function acctBrief(st) {
  return {
    company: st.company, contact_name: st.contact_name, contact_title: st.contact_title,
    timezone: st.timezone || null, deal_stage: st.deal_stage, loss_reason: st.loss_reason,
    loss_details: st.loss_details, close_date: st.close_date, original_ask: st.original_ask,
    call_notes: st.call_notes,
  };
}

function signalBrief(st) {
  const s = st.signal;
  if (!s || !s.verified) return null;
  return { signal: s.signal, type: s.type, evidence_quote: s.evidence_quote, source_title: s.source_title, source_date: s.source_date };
}

function normalizeDraft(d) {
  d = d || {};
  return {
    subject: String(d.subject || '').trim(),
    body: String(d.body || '').replace(/\r/g, '').replace(/\\n/g, '\n').replace(/\n{3,}/g, '\n\n')
      // A line with exactly one straight quote at its start or end is a leftover from broken JSON.
      .split('\n').map((l) => ((l.match(/"/g) || []).length === 1 ? l.replace(/^(\s*)"/, '$1').replace(/"(\s*)$/, '$1') : l)).join('\n')
      .trim(),
    angle: String(d.angle || ''),
    notes: Array.isArray(d.notes) ? d.notes.map(String) : [],
  };
}

function splitBody(body) {
  const nonEmpty = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return { greeting: nonEmpty[0] || '', signoff: nonEmpty.length > 1 ? nonEmpty[nonEmpty.length - 1] : '', middle: nonEmpty.slice(1, -1) };
}

function checkDraft(cur, st) {
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: ok ? '' : detail });
  const { greeting, signoff, middle } = splitBody(cur.body);
  const fn = firstName(st.contact_name);
  const text = middle.join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  add('greeting', 'Greeting has no dash', /^(Hi [^,\-–—]+,|Hey [^,\-–—!.]+[!.])$/.test(greeting),
    `Greeting "${greeting}" must be "Hi ${fn}," or "Hey ${fn}!" with no dash.`);
  add('name', 'Uses their first name', fn && greeting.includes(fn), `Greeting should use "${fn}".`);
  const valediction = /^(best|thanks|thank you|cheers|regards|best regards|warmly|talk soon)[,!.]?$/i.test(middle[middle.length - 1] || '');
  add('signoff', `Signed just "${SENDER}"`, signoff === SENDER && !valediction, valediction ? `Drop "${middle[middle.length - 1]}". Sign off with just "${SENDER}".` : `Sign off with just "${SENDER}" (found "${signoff}").`);
  add('length', 'Under 90 words', words > 0 && words <= 90, `Body is ${words} words. Cut it to under 90.`);
  add('lines', '3 to 5 short lines', middle.length >= 3 && middle.length <= 5, `Body has ${middle.length} lines. Use 3 to 5 short lines.`);
  const excl = (cur.body.match(/!/g) || []).length;
  add('exclaim', 'At most 2 exclamation points', excl <= 2, `${excl} exclamation points. Use 2 at most.`);
  const hasEmoji = /\p{Extended_Pictographic}/u.test(cur.body);
  const hasMd = /(\*\*|__|^#|^\s*[-*•]\s)/m.test(cur.body) || /https?:\/\//i.test(cur.body);
  const leaked = looksLikeJSON(cur.body);
  add('plain', 'Plain text only', !hasEmoji && !hasMd && !leaked,
    leaked ? 'The draft came back as raw JSON. Rewrite it as the plain email body only.' : 'Remove emoji, markdown, bullets or links.');
  const lower = cur.body.toLowerCase();
  const hit = BANNED.filter((p) => lower.includes(p));
  add('banned', 'No banned phrases', hit.length === 0, `Remove banned phrase(s): ${hit.join(', ')}.`);
  const expectedSubject = `${st.company} <> Northfold`;
  add('subject', 'Subject is "Company <> Northfold"', cur.subject === expectedSubject, `Subject must be exactly "${expectedSubject}".`);
  const reason = String(st.loss_reason || '').toLowerCase();
  if (st.track === 'check-in') {
    const m = text.match(/\b(switch(ing)? back|instead of|better than|compared|other agency|their agency|pricing|price)\b/i);
    add('loss', 'Neutral about the competitor', !m, `Check-in track: drop "${m && m[0]}". No comparison and no pitch.`);
  } else if (/(budget|price)/.test(reason)) {
    const m = text.match(/\b(budget|budgets|price|pricing|cost|costs|discount|afford|spend)\b/i);
    add('loss', 'Budget loss not re-raised', !m, `This deal was lost on budget: don't mention "${m && m[0]}".`);
  } else {
    add('loss', 'Loss reason handled', true, '');
  }
  const allowed = [(st.signal && st.signal.evidence_quote) || '', st.call_notes || '', st.loss_details || '', st.original_ask || ''].join(' ');
  const nums = (text.match(/(?<![A-Za-z])\$?\d[\d,.]*%?/g) || [])
    .map((n) => n.replace(/[.,]$/, ''))
    .filter((n) => !/^20(2[5-9]|3\d)$/.test(n));
  const bad = nums.filter((n) => !allowed.includes(n));
  add('numbers', 'No invented numbers', bad.length === 0, `Number(s) not found in the evidence: ${bad.join(', ')}.`);
  const selfRefs = (text.match(/\b(we|we've|we're|our|us|northfold)\b/gi) || []).length;
  add('about', 'About them, not us', selfRefs <= 3, `${selfRefs} references to Northfold/we/our. Keep it about them.`);
  const last = middle[middle.length - 1] || '';
  const askOk = /\?\s*$/.test(last) && /(friday|fridays|next week|this week|catch up|catch-up|chat)/i.test(last);
  add('ask', 'Ends with a warm day-ask', askOk, 'Close with a warm, specific day-ask question, e.g. "Catch up one of these upcoming Fridays?"');
  if (st.timezone && /friday/i.test(last)) {
    add('tz', `Timezone labeled (${st.timezone})`, last.includes(st.timezone), `Label the Friday ask with their timezone (${st.timezone}).`);
  }
  add('no_calendly', 'No Calendly link', !/calendly/i.test(cur.body), 'Remove the Calendly mention.');
  const failures = checks.filter((c) => !c.ok).map((c) => c.detail);
  return { checks, failures, passed: checks.length - failures.length, total: checks.length, words, lines: middle.length };
}

function judgeInput(st, cur) {
  return JSON.stringify({ account: acctBrief(st), track: st.track, signal: signalBrief(st), draft: { subject: cur.subject, body: cur.body }, style_guide: st.style_guide || undefined });
}

function reviseInput(st, cur, ruleFailures, judgeFailures) {
  return JSON.stringify({
    account: acctBrief(st), track: st.track, signal: signalBrief(st), today: st.today, style_guide: st.style_guide || undefined,
    current_draft: { subject: cur.subject, body: cur.body },
    failures: [
      ...ruleFailures.map((d) => ({ check: 'rules', detail: d })),
      ...(judgeFailures || []).map((f) => ({ check: f.check || 'judge', detail: f.detail || String(f) })),
    ],
  });
}

// ---- Fact check: a claim counts as verified only if code finds the claim in the draft AND the
// quoted evidence in the source it cites. The model proposes; code decides.
const FACT_SOURCES = {
  crm_call_notes: 'CRM call notes',
  crm_loss_details: 'CRM loss details',
  crm_original_ask: 'CRM original ask',
  crm_loss_reason: 'CRM loss reason',
  crm_deal: 'CRM deal record',
};

function factSources(st) {
  const src = {
    crm_call_notes: st.call_notes || '',
    crm_loss_details: st.loss_details || '',
    crm_original_ask: st.original_ask || '',
    crm_loss_reason: st.loss_reason || '',
    crm_deal: `Deal stage: ${st.deal_stage || ''}. Closed: ${st.close_date || ''}. Contact: ${st.contact_name || ''}, ${st.contact_title || ''}.`,
  };
  if (st.signal && st.signal.verified) src.web_signal = st.signal.evidence_quote || '';
  return src;
}

function normText(t) {
  return String(t || '').toLowerCase()
    .replace(/[‘’‛`´]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^a-z0-9'%$ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Is `needle` in `hay`, ignoring case, punctuation and spacing? For longer quotes, a copy slip of a word
// or two is tolerated: 90% of the needle's words must appear in order within a short window.
function foundIn(needle, hay) {
  const n = normText(needle);
  const h = normText(hay);
  if (!n || !h) return false;
  if (h.includes(n)) return true;
  const nw = n.split(' ');
  const hw = h.split(' ');
  if (nw.length < 5) return false;
  let best = 0;
  for (let s = 0; s < hw.length && best < nw.length; s++) {
    if (hw[s] !== nw[0] && hw[s] !== nw[1]) continue;
    let j = 0;
    let matched = 0;
    for (let k = s; k < hw.length && j < nw.length && k < s + nw.length + 4; k++) {
      if (hw[k] === nw[j]) { matched++; j++; }
      else if (j + 1 < nw.length && hw[k] === nw[j + 1]) { matched++; j += 2; } // needle word j is missing here
    }
    best = Math.max(best, matched);
  }
  return best / nw.length >= 0.9;
}

function verifyClaims(raw, st, body) {
  const src = factSources(st);
  const sig = st.signal && st.signal.verified ? st.signal : null;
  const list = raw && Array.isArray(raw.claims) ? raw.claims : null;
  if (!list) return { claims: [], verified: 0, total: 0, error: 'The fact checker could not run on this draft.' };
  const claims = [];
  for (const c of list.slice(0, 8)) {
    const draft_quote = String((c && c.draft_quote) || '').trim();
    const claim = String((c && c.claim) || '').trim();
    if (!claim || !draft_quote || !foundIn(draft_quote, body)) continue; // the checker may not invent text
    if (/^(hi|hey|hello) [a-z'-]+$/.test(normText(draft_quote))) continue; // the greeting is not a fact
    const id = String(c.source || 'none');
    const evidence = String(c.evidence || '').trim();
    let status = 'verified';
    let why = '';
    if (id === 'none' || !(id in src)) { status = 'unsupported'; why = 'No source in the CRM or on the web says this.'; }
    else if (!evidence || !foundIn(evidence, src[id])) { status = 'unsupported'; why = `The quoted evidence is not in the ${id === 'web_signal' ? 'web source' : FACT_SOURCES[id]}.`; }
    const source = id === 'web_signal' && sig
      ? { id, kind: 'web', label: sig.source_type === 'homepage' ? 'Their homepage' : 'News', title: sig.source_title || '', url: sig.source_url || '', date: sig.source_date || '' }
      : FACT_SOURCES[id]
        ? { id, kind: 'crm', label: FACT_SOURCES[id], title: '', url: '', date: id === 'crm_deal' ? st.close_date || '' : '' }
        : { id: 'none', kind: 'none', label: 'No source', title: '', url: '', date: '' };
    claims.push({ claim, draft_quote, source, evidence: status === 'verified' ? evidence : '', status, why, at: normText(body).indexOf(normText(draft_quote)) });
  }
  // Number the facts in reading order, so marker 1 is the first fact in the email.
  claims.sort((x, y) => (x.at < 0) - (y.at < 0) || x.at - y.at);
  claims.forEach((c, i) => { c.n = i + 1; delete c.at; });
  return { claims, verified: claims.filter((c) => c.status === 'verified').length, total: claims.length };
}

function scoreOf(judgeScore, ruleFailureCount) {
  const j = Number.isFinite(Number(judgeScore)) ? Number(judgeScore) : 5;
  return Math.max(0, Math.min(10, Math.round((j - ruleFailureCount) * 10) / 10));
}
// ---- end helpers ----
