// Unit tests for src/code/lib.js. Run: node test/test_lib.js
// Fixtures are real gpt-5-mini outputs captured from an n8n Cloud run.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const libSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'code', 'lib.js'), 'utf8');
const lib = new Function(libSrc + '\nreturn { parseJSON, repairJSON, llmOut, normalizeDraft, checkDraft, looksLikeJSON, verifyClaims, foundIn };')();
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'llm-outputs.json'), 'utf8'));

const ramp = {
  company: 'Ramp', contact_name: 'Dana Whitfield', timezone: 'ET', track: 'standard', loss_reason: 'Tabled',
  loss_details: 'Liked the AEO plan but wanted to pause new content spend until after H2 planning.',
  call_notes: '', original_ask: '', signal: { evidence_quote: 'Introducing Stack by Ramp.' },
};

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok', name); }

t('stray unescaped quote in the body is repaired (the Ramp v1 bug)', () => {
  const r = lib.llmOut({ json: { text: fx.ramp_draft_v1_stray_quote } });
  assert(r, 'parse returned null');
  assert.strictEqual(r.subject, 'Ramp <> Northfold');
  assert(r.body.startsWith('Hi Dana,'));
  assert(r.body.trim().endsWith('Sam'));
  assert.strictEqual(r.notes.length, 2);
  assert(r.angle.startsWith('Standard track'));
});

t('after normalizing, the repaired draft has no leftover quote and no JSON', () => {
  const d = lib.normalizeDraft(lib.llmOut({ json: { text: fx.ramp_draft_v1_stray_quote } }));
  d.body = d.body.replace(/Sam$/, 'Jayden'); // fixture was captured when the sender was still "Sam"
  assert(!d.body.includes('\n"You'), 'stray quote survived');
  assert(d.body.includes('\nYou\'d made showing up'));
  assert(d.body.includes('"Stack by Ramp"'), 'real quotes must survive');
  assert(!lib.looksLikeJSON(d.body));
  const det = lib.checkDraft(d, ramp);
  assert(!det.failures.some((f) => /Greeting|Subject must|Sign off/.test(f)), det.failures.join(' | '));
});

t('valid outputs still parse unchanged', () => {
  for (const k of ['vercel_revise_v1_ok', 'ramp_research_ok', 'keep']) {
    assert.deepStrictEqual(lib.parseJSON(fx[k]), JSON.parse(fx[k]), k);
  }
});

t('raw line breaks inside strings are repaired', () => {
  const r = lib.parseJSON('{"subject":"A <> Northfold","body":"Hi Al,\n\nLine one.\nJayden"}');
  assert.strictEqual(r.body, 'Hi Al,\n\nLine one.\nJayden');
});

t('code fences and chatter around the JSON are tolerated', () => {
  const r = lib.parseJSON('Here you go:\n```json\n{"keep": true}\n```');
  assert.deepStrictEqual(r, { keep: true });
});

t('a body that is leaked JSON fails the plain-text rule', () => {
  const d = lib.normalizeDraft({ subject: '', body: fx.ramp_draft_v1_stray_quote });
  const det = lib.checkDraft(d, ramp);
  const plain = det.checks.find((c) => c.id === 'plain');
  assert(!plain.ok);
  assert(/raw JSON/.test(plain.detail));
});

t('a normal draft with quotes passes the plain-text rule', () => {
  const d = lib.normalizeDraft(JSON.parse(fx.vercel_revise_v1_ok));
  const det = lib.checkDraft(d, { ...ramp, company: 'Vercel', contact_name: 'Marcus Lee', timezone: 'PT', track: 'check-in' });
  assert(det.checks.find((c) => c.id === 'plain').ok);
});

const rampFull = {
  ...ramp, deal_stage: 'Closed Lost', close_date: '2026-06-18', contact_title: 'Head of Content',
  call_notes: "Discovery (Apr 2026): Dana's priority order was 1) show up in ChatGPT and Perplexity answers for corporate card and expense management queries, 2) refresh the comparison pages, 3) one flagship report per quarter. Worried agency writers would miss finance nuance. Final call (Jun 2026): 'Love the plan, timing is wrong. Come back in Q4 when we plan 2027.'",
  original_ask: 'AEO-first content program: get Ramp cited in AI answers for spend-management queries, plus one flagship campaign asset per quarter.',
  signal: { verified: true, evidence_quote: 'Introducing Stack by Ramp. The AI operating system built for today’s top finance teams.', source_type: 'homepage', source_title: 'Ramp', source_url: 'https://ramp.com', source_date: '2026-11-15' },
};
const rampBody = 'Hi Dana,\n\nCalling "Stack by Ramp" an "AI operating system" on the homepage stood out.\nYou\'d prioritized showing up in ChatGPT/Perplexity answers, refreshing comparisons, and quarterly flagship reports.\nYou tabled new content spend until 2027 planning — should we sync before you lock priorities?\nCatch up one of these upcoming Fridays, ET?\n\nJayden';

t('fact check: claims backed by the web quote and the CRM notes are verified', () => {
  const r = lib.verifyClaims({ claims: [
    { draft_quote: 'Calling "Stack by Ramp" an "AI operating system"', claim: 'Ramp calls Stack an AI operating system.', source: 'web_signal', evidence: 'The AI operating system built for today\'s top finance teams.' },
    { draft_quote: 'You\'d prioritized showing up in ChatGPT/Perplexity answers', claim: 'Dana prioritized showing up in AI answers.', source: 'crm_call_notes', evidence: 'show up in ChatGPT and Perplexity answers for corporate card and expense management queries' },
    { draft_quote: 'tabled new content spend until 2027 planning', claim: 'Ramp paused until 2027 planning.', source: 'crm_call_notes', evidence: 'Come back in Q4 when we plan 2027.' },
  ] }, rampFull, rampBody);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.verified, 3, JSON.stringify(r.claims.map((c) => c.why)));
  assert.strictEqual(r.claims[0].source.kind, 'web');
  assert.strictEqual(r.claims[0].source.url, 'https://ramp.com');
  assert.strictEqual(r.claims[1].source.label, 'CRM call notes');
});

t('fact check: invented evidence, "none" and wrong-source claims are not verified', () => {
  const r = lib.verifyClaims({ claims: [
    { draft_quote: 'tabled new content spend until 2027 planning', claim: 'x', source: 'crm_call_notes', evidence: 'We will freeze all content spend until 2027.' },
    { draft_quote: 'refreshing comparisons', claim: 'y', source: 'none', evidence: '' },
    { draft_quote: 'quarterly flagship reports', claim: 'z', source: 'web_signal', evidence: 'one flagship report per quarter' },
  ] }, rampFull, rampBody);
  assert.deepStrictEqual(r.claims.map((c) => c.status), ['unsupported', 'unsupported', 'unsupported']);
  assert(r.claims.every((c) => c.evidence === ''), 'unverified claims must not show evidence');
});

t('fact check: a claim whose quote is not in the draft is dropped', () => {
  const r = lib.verifyClaims({ claims: [{ draft_quote: 'You raised a Series D last month', claim: 'q', source: 'none', evidence: '' }] }, rampFull, rampBody);
  assert.strictEqual(r.total, 0);
});

t('fact check: facts are numbered in reading order and the greeting is skipped', () => {
  const r = lib.verifyClaims({ claims: [
    { draft_quote: 'tabled new content spend until 2027 planning', claim: 'c', source: 'crm_call_notes', evidence: 'Come back in Q4 when we plan 2027.' },
    { draft_quote: 'Hi Dana', claim: 'Contact is Dana.', source: 'crm_deal', evidence: 'Contact: Dana Whitfield, Head of Content.' },
    { draft_quote: 'Calling "Stack by Ramp" an "AI operating system"', claim: 'a', source: 'web_signal', evidence: 'The AI operating system built for' },
  ] }, rampFull, rampBody);
  assert.deepStrictEqual(r.claims.map((c) => [c.n, c.claim]), [[1, 'a'], [2, 'c']]);
});

t('fact check: unreadable checker output is reported, not hidden', () => {
  const r = lib.verifyClaims(null, rampFull, rampBody);
  assert.strictEqual(r.total, 0);
  assert(/could not run/.test(r.error));
});

t('garbage still returns null instead of throwing', () => {
  assert.strictEqual(lib.parseJSON('not json at all'), null);
  assert.strictEqual(lib.parseJSON(''), null);
});

console.log(`\n${n} tests passed`);
