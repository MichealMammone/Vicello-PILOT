// Minimal client for S3-compatible object storage (Backblaze B2, Cloudflare R2, AWS S3, Wasabi): put, get and list,
// signed with AWS Signature Version 4. Built on Node's own crypto and fetch, so the app still has no dependencies.
import crypto from 'node:crypto';

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p) => p.split('/').map(enc).join('/');

/** Region from the endpoint address when it is not given (B2 and AWS put it in the host name; R2 uses "auto"). */
export function regionOf(endpoint, region) {
  if (region) return region;
  const host = new URL(endpoint).hostname;
  let m = host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/);
  if (m) return m[1];
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'auto';
  m = host.match(/^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/) || host.match(/^s3\.([a-z0-9-]+)\.wasabisys\.com$/);
  return m ? m[1] : 'us-east-1';
}

/**
 * Sign a request (SigV4). Returns the headers to send, including Authorization.
 * `path` is the decoded object path ("/bucket/key"); `query` is an object of query parameters.
 */
export function sign({ method, host, path, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const canonical = [method, encPath(path), canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

async function request(cfg, method, key, { query = {}, body = null, headers = {} } = {}) {
  const base = new URL(cfg.endpoint);
  const path = `/${cfg.bucket}${key ? `/${key}` : ''}`;
  const payload = body ? Buffer.from(body) : Buffer.alloc(0);
  const signed = sign({
    method, host: base.host, path, query, headers, payloadHash: sha256hex(payload),
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: regionOf(cfg.endpoint, cfg.region),
  });
  delete signed.host; // fetch sets Host itself, to the same value that was signed
  const qs = Object.keys(query).length ? `?${Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&')}` : '';
  const res = await fetch(`${base.origin}${encPath(path)}${qs}`, { method, headers: signed, body: body ? payload : undefined, signal: AbortSignal.timeout(cfg.timeoutMs || 120000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1];
    const err = new Error(`Storage ${method} ${key || cfg.bucket} failed: HTTP ${res.status}${code ? ` ${code}` : ''}${msg ? ` – ${msg}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** Upload an object. lockUntil (Date) asks for Object Lock in compliance mode until then. */
export async function putObject(cfg, key, body, { lockUntil = null, contentType = 'application/octet-stream' } = {}) {
  const headers = { 'content-type': contentType, 'content-md5': crypto.createHash('md5').update(body).digest('base64') };
  if (lockUntil) {
    headers['x-amz-object-lock-mode'] = 'COMPLIANCE';
    headers['x-amz-object-lock-retain-until-date'] = lockUntil.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const res = await request(cfg, 'PUT', key, { body, headers });
  return { etag: (res.headers.get('etag') || '').replace(/"/g, '') };
}

export async function getObject(cfg, key) {
  const res = await request(cfg, 'GET', key);
  return Buffer.from(await res.arrayBuffer());
}

const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** List objects under a prefix: [{ key, size, lastModified }]. */
export async function listObjects(cfg, prefix, { max = 5000 } = {}) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix, 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) };
    const xml = await (await request(cfg, 'GET', '', { query })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const get = (tag) => (m[1].match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];
      out.push({ key: xmlText(get('Key') || ''), size: Number(get('Size') || 0), lastModified: get('LastModified') || '' });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText((xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || '') : null;
  } while (token && out.length < max);
  return out;
}
