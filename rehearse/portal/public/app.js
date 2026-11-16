const $ = id => document.getElementById(id);
const storageKey = 'interview-practice-v1';
let saved;
try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch {}
let sessionId = typeof saved?.sessionId === 'string' ? saved.sessionId : crypto.randomUUID();
let messages = Array.isArray(saved?.messages) ? saved.messages.filter(m => ['user','assistant'].includes(m.role) && typeof m.text === 'string').slice(-100) : [];
let busy = false;
let recorder, stream, timer, chunks = [], recording, recordingUrl, playing;
let recordingBaseDraft = '', lastTranscriptDraft = null, speechRequestId = 0;
const speechCache = new Map();
$('auto-speak').checked = saved?.autoSpeak === true;
if (['Kore','Puck','Aoede','Charon','Fenrir'].includes(saved?.voice)) $('voice').value = saved.voice;
$('answer').value = typeof saved?.draft === 'string' ? saved.draft : '';
function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify({ sessionId, messages: messages.slice(-100), draft: $('answer').value, voice: $('voice').value, autoSpeak: $('auto-speak').checked })); } catch {}
}
function notice(text = '', error = false) {
  $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error);
}
function updateSessionState() {
  const activity = document.body.dataset.activity;
  const activeLabels = { thinking: 'Preparing your response…', transcribing: 'Transcribing your voice…', recording: 'Recording your answer' };
  const lastReply = messages.findLast(message => message.role === 'assistant');
  $('session-state').textContent = activeLabels[activity] || (lastReply?.kind === 'follow_up' ? `Follow-up · Question ${lastReply.number}` : lastReply?.kind === 'primary' ? `Question ${lastReply.number}` : messages.length ? 'Practice session' : 'Ready to practice');
}
function showWelcome() {
  $('messages').replaceChildren($('welcome-template').content.cloneNode(true));
  $('messages').scrollTop = 0;
}
function lock(value, activity = 'thinking') {
  busy = value;
  document.body.dataset.activity = value ? activity : 'ready';
  $('messages').setAttribute('aria-busy', String(value));
  updateSessionState();
  for (const id of ['send','start','next','end','progress','review','new-chat','audio-file','transcribe','discard']) $(id).disabled = value;
  $('record').disabled = value;
  $('answer').readOnly = value;
}
async function api(path, body) {
  const response = await fetch('/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let result;
  try { result = await response.json(); } catch { throw new Error('The server returned an incomplete response. Your draft is preserved; please retry.'); }
  if (!response.ok || result.error) throw new Error(typeof result.error === 'string' ? result.error : 'This request could not complete. Please retry.');
  return result;
}
function scrollToLatest() { $('messages').scrollTop = $('messages').scrollHeight; }
// Render the debrief's basic Markdown with DOM nodes. Model output never
// becomes HTML, so uploaded stories and model replies cannot inject markup.
function appendInline(parent, value) {
  for (const part of value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); parent.append(strong);
    } else if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code'); code.textContent = part.slice(1, -1); parent.append(code);
    } else parent.append(document.createTextNode(part));
  }
}
function renderReply(parent, value) {
  let list = null, paragraph = null;
  for (const line of value.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
    if (!line.trim()) { list = paragraph = null; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { parent.append(document.createElement('hr')); list = paragraph = null; continue; }
    if (heading) {
      const h = document.createElement('h4'); appendInline(h, heading[1]); parent.append(h); list = paragraph = null;
    } else if (bullet) {
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.localName !== type) { list = document.createElement(type); parent.append(list); }
      const item = document.createElement('li'); appendInline(item, bullet[1]); list.append(item); paragraph = null;
    } else {
      list = null;
      if (!paragraph) { paragraph = document.createElement('p'); parent.append(paragraph); }
      else paragraph.append(document.createElement('br'));
      appendInline(paragraph, line);
    }
  }
}
function renderMessage(message) {
  const article = document.createElement('article'); article.className = 'message ' + message.role;
  if (['primary', 'follow_up'].includes(message.kind)) article.dataset.kind = message.kind;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = message.role === 'user' ? 'You' : message.kind === 'follow_up' ? `Follow-up to question ${message.number}` : message.kind === 'primary' ? `Question ${message.number}` : 'Interviewer';
  if (message.role === 'assistant') {
    const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = 'r.'; label.prepend(avatar);
  }
  const text = document.createElement('div'); text.className = 'message-text';
  if (message.role === 'assistant') renderReply(text, message.text);
  else text.textContent = message.text;
  article.append(label, text);
  if (message.kind === 'follow_up' && message.quote) {
    const anchor = document.createElement('blockquote'); anchor.className = 'answer-anchor'; anchor.textContent = 'Based on your answer: “' + message.quote + '”'; article.append(anchor);
  }
  if (message.role === 'assistant') {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'play'; button.textContent = '▶ Play reply';
    button.addEventListener('click', () => speak(message, button, article)); article.append(button);
  }
  $('messages').append(article); return article;
}
if (messages.length) { $('messages').replaceChildren(); messages.forEach(renderMessage); scrollToLatest(); }
else showWelcome();
updateSessionState();
function addMessage(role, text, metadata = {}) {
  if (!messages.length) $('messages').replaceChildren();
  const message = { id: crypto.randomUUID(), role, text, ...metadata }; messages.push(message);
  const article = renderMessage(message); persist(); scrollToLatest(); return { message, article };
}
async function send(text, command = false) {
  if (busy || recorder?.state === 'recording' || !text.trim()) return;
  text = text.trim();
  if (text.length > 12000) { notice('Split your answer into messages of at most 12,000 characters.', true); return; }
  lock(true); notice('Preparing your next response…');
  speechRequestId++;
  if (playing) playing.pause();
  try {
    const result = await api('chat', { sessionId, chatInput: text });
    if (typeof result.output !== 'string' || !result.output.trim()) throw new Error('No interview response was returned. Please retry.');
    // Failed model turns leave the server transcript unchanged; keep the draft
    // available for retry instead of falsely displaying it as accepted.
    const failed = result.retryable === true;
    if (!failed && !command) addMessage('user', text);
    const { message, article } = addMessage('assistant', result.output, {kind:result.question_kind,number:result.primary_question_number,quote:result.answer_quote});
    if (!failed && !command) { $('answer').value = ''; discardRecording(); }
    persist(); notice(failed ? result.output : '', failed);
    if ($('auto-speak').checked && !failed) speak(message, article.querySelector('.play'), article);
  } catch (error) { notice(error.message, true); }
  finally { lock(false); $('answer').focus(); }
}
async function speak(message, button, article) {
  if (button.disabled) return;
  const voice = $('voice').value;
  const key = message.id + ':' + voice;
  const requestId = ++speechRequestId;
  if (playing) playing.pause();
  button.disabled = true; button.textContent = 'Generating speech…';
  try {
    let url = speechCache.get(key);
    if (!url) {
      const result = await api('speak', { text: message.text, voice });
      if (typeof result.audioBase64 !== 'string' || !['audio/wav','audio/mpeg'].includes(result.mimeType)) throw new Error('No playable audio was returned.');
      const bytes = Uint8Array.from(atob(result.audioBase64), c => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType })); speechCache.set(key, url);
    }
    if (requestId !== speechRequestId || recorder?.state === 'recording') return;
    let audio = article.querySelector('audio');
    if (!audio) { audio = document.createElement('audio'); audio.controls = true; audio.setAttribute('aria-label', 'Spoken interviewer reply'); article.append(audio); }
    audio.src = url; playing = audio;
    try { await audio.play(); notice(''); } catch { notice('Speech is ready. Press Play on the audio player to listen.'); }
    scrollToLatest();
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; button.textContent = '▶ Play reply'; }
}
function discardRecording() {
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recording = null; recordingUrl = null; $('recording-audio').removeAttribute('src'); $('recording-preview').hidden = true; $('audio-file').value = '';
  lastTranscriptDraft = null;
}
function previewRecording(blob) {
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recording = blob; recordingUrl = URL.createObjectURL(blob);
  recordingBaseDraft = $('answer').value.trim(); lastTranscriptDraft = null;
  $('recording-audio').src = recordingUrl; $('recording-preview').hidden = false;
}
async function transcribe() {
  if (busy || !recording) return;
  if (lastTranscriptDraft !== null && $('answer').value !== lastTranscriptDraft) { notice('Your transcript has been edited. Send the edited answer, or record a new answer.', true); return; }
  if (recording.size > 10000000) { notice('Audio must be smaller than 10 MB. Record a shorter answer.', true); return; }
  lock(true, 'transcribing'); notice('Transcribing your answer with Gemini…');
  try {
    const audioBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(recording); });
    const result = await api('transcribe', { audioBase64, mimeType: recording.type || 'audio/wav' });
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('No speech was recognized. Try recording again.');
    $('answer').value = [recordingBaseDraft, result.text].filter(Boolean).join('\n\n'); lastTranscriptDraft = $('answer').value;
    persist(); notice('Transcript ready. Check the wording, then send your answer.');
  } catch (error) { notice(error.message, true); }
  finally { lock(false); $('answer').focus(); }
}
async function toggleRecording() {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  if (busy) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { notice('Microphone recording is unavailable in this browser. Try Chrome on localhost, or upload an audio file.', true); return; }
  try {
    if (playing) playing.pause();
    speechRequestId++;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { notice('The microphone recording failed. Try again or upload audio.', true); if (recorder.state === 'recording') recorder.stop(); };
    recorder.onstop = async () => {
      clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      $('record').setAttribute('aria-pressed', 'false'); $('record-label').textContent = 'Record answer'; $('recording-time').textContent = ''; lock(false);
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (!blob.size) { notice('No audio was recorded. Try again.', true); return; }
      previewRecording(blob); await transcribe();
    };
    recorder.start(1000); lock(true, 'recording'); $('record').disabled = false;
    $('record').setAttribute('aria-pressed', 'true'); $('record-label').textContent = 'Stop recording'; notice('Recording your answer. Press Stop when you are finished.');
    const started = Date.now();
    timer = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); $('recording-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')} / 3:00`; if (seconds >= 180 && recorder.state === 'recording') recorder.stop(); }, 500);
  } catch (error) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    lock(false);
    notice(error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser’s site settings, or upload an audio file.' : 'Cannot open the microphone. Check your input device or upload an audio file.', true);
  }
}
$('answer-form').addEventListener('submit', event => { event.preventDefault(); send($('answer').value); });
$('answer').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send($('answer').value); } });
$('answer').addEventListener('input', persist);
$('record').addEventListener('click', toggleRecording);
$('transcribe').addEventListener('click', transcribe);
$('discard').addEventListener('click', discardRecording);
$('audio-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  if (file.size > 10000000) { notice('Audio must be smaller than 10 MB.', true); return; }
  const fallback = { wav:'audio/wav', webm:'audio/webm', m4a:'audio/mp4', mp3:'audio/mpeg', ogg:'audio/ogg', flac:'audio/flac', aac:'audio/aac' };
  previewRecording(new Blob([file], { type: file.type || fallback[file.name.split('.').pop().toLowerCase()] || 'application/octet-stream' })); await transcribe();
});
for (const [id, command] of [['start','/start'],['next','/next'],['end','/end'],['progress','/progress'],['review','/review']]) $(id).addEventListener('click', () => send(command, true));
$('auto-speak').addEventListener('change', persist); $('voice').addEventListener('change', persist);
$('sidebar-toggle').addEventListener('click', () => {
  const expanded = $('sidebar-toggle').getAttribute('aria-expanded') !== 'true';
  $('sidebar-toggle').setAttribute('aria-expanded', String(expanded));
  $('sidebar').dataset.expanded = String(expanded);
});
$('new-chat').addEventListener('click', () => {
  if (busy) return;
  sessionId = crypto.randomUUID(); messages = []; showWelcome(); $('answer').value = ''; discardRecording();
  speechRequestId++;
  if (playing) playing.pause(); for (const url of speechCache.values()) URL.revokeObjectURL(url); speechCache.clear();
  persist(); updateSessionState(); notice('New chat ready. Your saved topic progress is kept. Press Start to begin.');
});
window.addEventListener('pagehide', () => { clearInterval(timer); if (stream) stream.getTracks().forEach(track => track.stop()); });
fetch('/api/status').then(r => r.json()).then(status => {
  $('connection').textContent = status.connected ? 'Connected to local n8n' : 'Local n8n is unavailable'; $('connection-dot').classList.toggle('ready', status.connected);
  if (status.materialsUrl) $('materials').href = status.materialsUrl;
}).catch(() => { $('connection').textContent = 'Cannot reach the local portal'; });
