import http from 'node:http';
import { pipeline, env } from '@huggingface/transformers';
import mammoth from 'mammoth';

// Model assets are downloaded once. Uploaded text is processed locally.
env.cacheDir = process.env.MODEL_CACHE_DIR || '/models';
const modelId = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const apiModel = 'local-multilingual-minilm';
let ready = false;
let loadingError;
let extractor;
let queue = Promise.resolve();
const pending = pipeline('feature-extraction', modelId, { dtype: 'q8', device: 'cpu' })
  .then(p => { extractor = p; ready = true; console.log('Local multilingual embedding model ready (384 dimensions).'); })
  .catch(e => { loadingError = e; console.error('Embedding model could not load:', e.message); });

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      return send(res, ready ? 200 : 503, { ready, model: apiModel, dimensions: 384, ...(loadingError ? { error: 'Model could not load' } : {}) });
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: apiModel, object: 'model', owned_by: 'local' }] });
    }
    const extractDocx = req.method === 'POST' && req.url === '/v1/extract-docx';
    if (!extractDocx && (req.method !== 'POST' || req.url !== '/v1/embeddings')) return send(res, 404, { error: { message: 'Not found' } });
    if (!extractDocx && !ready) return send(res, 503, { error: { message: 'Local embedding model is still loading. Retry in a moment.' } });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > (extractDocx ? 15_000_000 : 2_000_000)) return send(res, 413, { error: { message: 'Request is too large' } });
    }
    const body = JSON.parse(raw);
    if (extractDocx) {
      if (typeof body.data !== 'string') return send(res, 400, { error: { message: 'DOCX file data is required' } });
      const buffer = Buffer.from(body.data, 'base64');
      if (buffer.length > 10_000_000 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return send(res, 400, { error: { message: 'Upload a valid DOCX file smaller than 10 MB' } });
      const result = await mammoth.extractRawText({ buffer });
      return send(res, 200, { text: result.value });
    }
    if (body.model !== apiModel) return send(res, 400, { error: { message: 'Use model ' + apiModel } });
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (!inputs.length || inputs.length > 128 || inputs.some(s => typeof s !== 'string' || !s.trim())) {
      return send(res, 400, { error: { message: 'input must contain 1–128 nonempty strings' } });
    }
    const task = async () => {
      const vectors = [];
      // Keep CPU/memory use bounded even for long resumes with many chunks.
      for (let start = 0; start < inputs.length; start += 8) {
        const result = await extractor(inputs.slice(start, start + 8), { pooling: 'mean', normalize: true });
        for (const vector of result.tolist()) {
          if (vector.length !== 384 || vector.some(n => !Number.isFinite(n))) throw new Error('Invalid local embedding');
          vectors.push(vector);
        }
      }
      return vectors;
    };
    const result = queue.then(task);
    queue = result.catch(() => {});
    const vectors = await result;
    const data = vectors.map((vector, index) => ({
      object: 'embedding', index,
      embedding: body.encoding_format === 'base64'
        ? Buffer.from(new Float32Array(vector).buffer).toString('base64')
        : vector,
    }));
    send(res, 200, { object: 'list', model: apiModel, data, usage: { prompt_tokens: 0, total_tokens: 0 } });
  } catch (e) {
    send(res, 500, { error: { message: 'Local embedding request failed: ' + e.message } });
  }
}).listen(Number(process.env.PORT || 8000), '0.0.0.0');

await pending;
