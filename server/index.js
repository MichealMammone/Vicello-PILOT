// Entry point: opens the database, then serves the API and the web app.
import http from 'node:http';
import fs from 'node:fs';
import { autoBackupTick } from './services/backup.service.js';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { HttpError, parseCookies, readJson, readRaw, send, serveStatic } from './http/http.js';
import { sessionFor, needsSetup } from './services/account.service.js';
import { router } from './routes.js';
import { ensureAllDefaults } from './services/schedule.service.js';
import { ensureAllStatusDefaults } from './services/statuses.service.js';
import { offsiteConfigured, offsiteTick } from './services/backup.service.js';
import { emailEnabled } from './services/email.service.js';
import { printSetupBanner } from './services/setupkey.service.js';

const COOKIE = 'jp_session';

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress;
}

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      const match = router.match(req.method, pathname);
      if (!match) {
        if (req.method === 'GET' && !pathname.startsWith('/api/')) {
          const roots = [{ prefix: '/shared/', dir: config.sharedDir }, { prefix: '/', dir: config.publicDir }];
          if (serveStatic(res, roots, pathname)) return;
        }
        throw new HttpError(404, 'Not found.');
      }

      // CSRF defence: state-changing requests must come from this app's own scripts.
      if (req.method !== 'GET') {
        if (req.headers['x-requested-with'] !== 'app') throw new HttpError(403, 'Request blocked.');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Request blocked.');
      }

      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[COOKIE] || null;
      const session = sessionFor(db, token, config.sessionHours);
      const ctx = {
        req, res, db, params: match.params, query: Object.fromEntries(url.searchParams), token,
        ip: clientIp(req),
        user: session?.user || null, company: session?.company || null,
        // Backup files for restore are sent as raw bytes; everything else is JSON.
        rawBody: req.method === 'POST' && /^application\/octet-stream/.test(req.headers['content-type'] || '') ? await readRaw(req) : null,
        body: ['POST', 'PUT', 'PATCH'].includes(req.method) && !/^application\/octet-stream/.test(req.headers['content-type'] || '') ? await readJson(req) : {},
        sent: false,
        setCookie(value) {
          res.setHeader('Set-Cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionHours * 3600}${config.secureCookies ? '; Secure' : ''}`);
        },
        clearCookie() { res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); },
        download(filename, data) {
          ctx.sent = true;
          send(res, 200, JSON.stringify(data, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"` });
        },
        html(markup) {
          ctx.sent = true;
          send(res, 200, markup, { 'Content-Type': 'text/html; charset=utf-8' });
        },
        sendFile(file, filename) {
          ctx.sent = true;
          const size = fs.statSync(file).size;
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          fs.createReadStream(file).pipe(res);
        },
      };
      let result;
      for (const h of match.handlers) result = await h(ctx);
      if (!ctx.sent) send(res, 200, result ?? { ok: true });
    } catch (err) {
      let status = err.status || 500;
      let message = err.message;
      if (/PRICE_BOOK_LOCKED/.test(err.message || '')) { status = 409; message = 'This price book version is published and locked. Use "Save As new draft" to change it.'; }
      if (status >= 500) { console.error(err); message = 'Something went wrong on the server. The error has been logged.'; }
      if (pathname.startsWith('/api/')) send(res, status, { error: message, details: err.details });
      else send(res, status, status === 401 ? 'Please sign in to the app first, then reopen this link.' : message);
    }
  });
}

export function start() {
  const db = openDatabase(config.dbFile);
  ensureAllDefaults(db);
  ensureAllStatusDefaults(db);
  const server = createServer(db);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Is the program already running? Set PORT to use another port.`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`${config.appName} ${config.version}`);
    console.log(`  Open:     http://${shown}:${config.port}`);
    console.log(`  Data:     ${config.dataDir}`);
    if (config.appEnv === 'staging') console.log('  TEST SITE (APP_ENV=staging): separate database; changes here do not affect the live site.');
    console.log(emailEnabled()
      ? `  Email:    ${config.smtp.host}:${config.smtp.port} from ${config.smtp.fromEmail}${config.appUrl ? `; links to ${config.appUrl}` : ' (set APP_URL for links)'}`
      : '  Email:    not set up (optional; see .env.example - SMTP_HOST, SMTP_FROM_EMAIL ...)');
    console.log(offsiteConfigured()
      ? `  Off-site: every ${config.offsite.intervalMinutes} min when data changes, to ${config.offsite.bucket} (${config.offsite.prefix}/)`
      : '  Off-site: not set up (see docs/backup-strategy.md)');
    if (config.diskMissing) {
      console.log('  WARNING:  No disk found at /var/data. Saved data will be LOST when Render restarts or redeploys.');
      console.log('            In Render: your service > Disk > Add disk, mount path /var/data, size 1 GB.');
    }
    if (needsSetup(db)) printSetupBanner();
  });
  let backupTimer = null;
  if (config.autoBackup) {
    const tick = () => { try { const f = autoBackupTick(db); if (f) console.log(`  Backup:   ${f}`); } catch (err) { console.error('Automatic backup failed:', err); } };
    setTimeout(tick, 60e3); // first check a minute after start, then hourly
    backupTimer = setInterval(tick, 3600e3);
  }
  let offsiteTimer = null;
  if (offsiteConfigured()) {
    const run = () => offsiteTick(db).then((r) => { if (r.ok && r.uploaded.length) console.log(`  Off-site backup: ${r.uploaded.join(', ')}`); }).catch((err) => console.error('Off-site backup failed:', err));
    setTimeout(run, 90e3);
    offsiteTimer = setInterval(run, config.offsite.intervalMinutes * 60e3);
  }
  const stop = () => { clearInterval(backupTimer); clearInterval(offsiteTimer); server.close(); db.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

const isMain = process.argv[1] && /server[\\/]index\.js$/.test(process.argv[1]);
if (isMain) start();
