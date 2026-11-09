// API client: JSON in/out, CSRF header, typed errors, file download/upload helpers.

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that the program is running.');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) onUnauthorized();
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status}).`, data && data.details);
  }
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);

/** Download a server file (uses Content-Disposition for the name). */
export async function download(url) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'app' }, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `Download failed (${res.status}).`;
    try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
    throw new ApiError(res.status, msg);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || 'download.json';
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return name;
}

/** Send a file's bytes (a backup for restore). Extra headers carry the setup key / backup key / file name. */
export async function postFile(url, file, headers = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'app', 'X-File-Name': encodeURIComponent(file.name || ''), ...headers }, body: file, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that the program is running.');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status}).`, data && data.details);
  return data;
}

/** Ask the user for a file and return the File object (for binary uploads). Resolves null if cancelled. */
export function pickRawFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.addEventListener('change', () => resolve((input.files && input.files[0]) || null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Ask the user for a file and return its text. Resolves null if cancelled. */
export function pickFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, text: await f.text() });
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
