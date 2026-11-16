import http from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT || 5677);
const upstream = process.env.N8N_BASE_URL || 'http://n8n:5678';
const publicUrl = process.env.N8N_PUBLIC_URL || 'http://localhost:5678';
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const routes = new Map([
  ['/api/chat', ['/webhook/mock-interview-chat/chat', 240000]],
  ['/api/transcribe', ['/webhook/interview-voice-transcribe', 100000]],
  ['/api/speak', ['/webhook/interview-voice-speak', 100000]],
]);
function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
http.createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  const host = req.headers.host || '';
  // Loopback-only listener plus host/origin checks prevent other sites from
  // using this local gateway to spend the user's saved model credentials.
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host)) return reply(res, 403, { error: 'Use the localhost portal URL.' });
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return reply(res, 403, { error: 'Cross-site requests are not allowed.' });
  const path = new URL(req.url, `http://${host}`).pathname;
  try {
    if (req.method === 'GET' && path === '/healthz') return reply(res, 200, { ready: true });
    if (req.method === 'GET' && path === '/api/status') {
      const config = JSON.parse(await readFile(new URL('./model-config.json', import.meta.url), 'utf8'));
      let connected = false;
      try { connected = (await fetch(upstream + '/healthz/readiness', { signal: AbortSignal.timeout(4000) })).ok; } catch {}
      return reply(res, 200, { connected, provider: config.provider, model: config.chat_models[config.provider], voiceModels: config.voice_models, materialsUrl: publicUrl + '/form/interview-materials', credentialsUrl: publicUrl + '/home/credentials' });
    }
    if (req.method === 'GET' && files.has(path)) {
      const [name, type] = files.get(path);
      const data = await readFile(new URL('./public/' + name, import.meta.url));
      res.writeHead(200, { 'content-type': type }); res.end(data); return;
    }
    if (req.method !== 'POST' || !routes.has(path)) return reply(res, 404, { error: 'Not found.' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return reply(res, 415, { error: 'Send a JSON request.' });
    let raw = '';
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 14000000) return reply(res, 413, { error: 'Audio must be smaller than 10 MB.' });
      raw += chunk;
    }
    let body;
    try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: 'Invalid JSON request.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400, { error: 'Send a JSON object.' });
    if (path === '/api/chat') {
      if (typeof body.sessionId !== 'string' || !body.sessionId.trim() || body.sessionId.length > 200 || typeof body.chatInput !== 'string' || !body.chatInput.trim() || body.chatInput.length > 12000) return reply(res, 400, { error: 'Enter an answer of 1–12,000 characters with a valid session.' });
      body = { sessionId: body.sessionId, chatInput: body.chatInput, action: 'sendMessage' };
    }
    const [route, timeout] = routes.get(path);
    const result = await fetch(upstream + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    let data;
    try { data = await result.json(); } catch { return reply(res, 502, { error: 'n8n returned an incomplete response. Check that the Interview workflows are published.' }); }
    if (Array.isArray(data)) data = data[0];
    if (!result.ok && !data?.error) return reply(res, 502, { error: 'The n8n workflow could not complete. Please retry.' });
    reply(res, result.status, data);
  } catch (error) {
    reply(res, 502, { error: error.name === 'TimeoutError' ? 'The response took too long. Your draft is preserved; please retry.' : 'Cannot reach n8n. Make sure Docker and the local interview stack are running.' });
  }
}).listen(port, '0.0.0.0', () => console.log(`Interview portal listening on port ${port}`));
