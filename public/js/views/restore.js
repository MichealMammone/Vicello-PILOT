// Restore steps shared by Settings → Backups & restore and the first-time setup screen:
// 1. check the backup (nothing changes yet) → 2. show what is in it → 3. confirm → restore.
import { h, fmt, modal, formDialog } from '../ui.js';

const COUNT_LABELS = { jobs: 'Jobs', quotes: 'Quotes', users: 'Users', price_books: 'Price book versions', job_lines: 'Job items', job_events: 'Schedule events', job_costs: 'Recorded costs', audit_log: 'History entries' };

/** What a checked backup contains, so a person can see it is the right one before restoring. */
export function restoreSummary(s) {
  return h('div', { class: 'restore-summary' },
    h('p', { class: 'ok' }, '✓ Backup checked: database integrity, record links and version are all correct.'),
    h('dl', { class: 'facts' },
      h('dt', null, 'Company'), h('dd', { class: 'strong' }, s.company),
      h('dt', null, 'Last activity in it'), h('dd', null, s.lastActivity ? fmt.datetime(s.lastActivity) : '—'),
      s.createdAt ? [h('dt', null, 'Backup made'), h('dd', null, fmt.datetime(s.createdAt))] : null,
      h('dt', null, 'From'), h('dd', { class: 'small' }, s.source || '—'),
      h('dt', null, 'Size'), h('dd', null, `${(s.bytes / 1024 / 1024).toFixed(2)} MB${s.encrypted ? ' · was encrypted' : ''}`)),
    h('table', { class: 'table compact' }, h('tbody', null, Object.entries(COUNT_LABELS).map(([k, l]) => h('tr', null, h('td', null, l), h('td', { class: 'num' }, String(s.counts?.[k] ?? 0)))))));
}

/** Ask for the backup encryption key (only needed for encrypted .vbak backups). */
export async function askBackupKey(message) {
  const v = await formDialog({
    title: 'Backup encryption key', submitLabel: 'Use this key',
    intro: message || 'This backup is encrypted. Enter the backup encryption key (kept in your password manager, and in the sealed copy in the office).',
    fields: [{ name: 'key', label: 'Backup encryption key', type: 'password', required: true, autofocus: true, autocomplete: 'off' }],
  });
  return v ? v.key : null;
}

/**
 * Run a restore: `check(key)` stages the backup and returns { token, summary }; `apply(token, extra)` restores it.
 * Asks for the encryption key when needed, shows the summary, and (when needPassword) asks for the owner's password.
 */
export async function runRestore({ check, apply, needPassword, warning }) {
  let key = '';
  let staged = null;
  for (let tries = 0; tries < 4 && !staged; tries++) {
    try { staged = await check(key); } catch (err) {
      if (err.details?.field === 'backupKey') { key = await askBackupKey(key ? 'That key did not open the backup. Try again.' : null); if (!key) return false; continue; }
      throw err;
    }
  }
  if (!staged) return false;
  const pw = needPassword ? h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Your password' }) : null;
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  return new Promise((resolve) => {
    modal({
      title: 'Restore this backup?', width: 560,
      body: h('div', null, restoreSummary(staged.summary),
        h('p', { class: 'banner warn' }, warning),
        pw ? h('label', { class: 'field' }, h('span', null, 'Your password (to confirm)'), pw) : null, err),
      actions: [{ label: 'Cancel', value: false }, { label: 'Restore now', kind: 'danger', onClick: async () => {
        try { await apply(staged.token, { password: pw?.value || '' }); return true; } catch (e) { err.hidden = false; err.textContent = e.message; return false; }
      } }],
      onClose: (r) => resolve(!!r),
    });
  });
}
