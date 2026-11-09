// First-run setup, sign in, change password.
import { post, postFile, pickRawFile } from '../api.js';
import { h, clear, fill, formDialog, toast, showError } from '../ui.js';
import { runRestore } from './restore.js';

function screen(root, ...content) {
  fill(root, h('div', { class: 'center-screen' }, h('div', { class: 'card narrow auth' }, ...content)));
}

function field(label, attrs) {
  const id = `a-${attrs.name}`;
  return h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, ...attrs }));
}

export function renderLogin(root, app, done) {
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'form', on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('button');
    btn.disabled = true;
    err.hidden = true;
    try {
      await post('/api/login', { email: fd.get('email'), password: fd.get('password') });
      done();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      form.password.select();
    }
  } } },
  field('Email', { name: 'email', type: 'email', autocomplete: 'username', required: true, autofocus: true }),
  field('Password', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
  err,
  h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in'));
  // Forgotten password: an emailed reset link when email is set up; otherwise an owner resets it.
  async function forgot() {
    const v = await formDialog({ title: 'Forgotten password', submitLabel: 'Email me a reset link',
      intro: 'Enter the email you sign in with. If it has an account, a link to choose a new password is emailed to it (valid for 60 minutes).',
      fields: [{ name: 'email', label: 'Email', type: 'email', required: true, autofocus: true, value: form.email.value }] });
    if (!v) return;
    try { await post('/api/password/forgot', { email: v.email }); toast('If that email has an account, a reset link is on its way. Check your inbox (and junk folder).', 'success', 8000); } catch (ex) { showError(ex); }
  }
  screen(root,
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg', 'aria-hidden': 'true' }), h('div', null, h('div', { class: 'eyebrow' }, app.state.info?.name || ''), h('h1', null, 'Sign in'))),
    form,
    app.state.info?.emailEnabled
      ? h('p', { class: 'small' }, h('button', { class: 'link', type: 'button', on: { click: forgot } }, 'Forgotten your password?'))
      : h('p', { class: 'muted small' }, 'Forgotten your password? Ask an owner to reset it from Settings → Users & access.'));
  setTimeout(() => form.email.focus(), 0);
}

/** Page opened from a password-reset email: choose a new password. */
export function renderReset(root, app, token, done) {
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'form', on: { submit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    const pw = form.password.value, again = form.confirm.value;
    if (pw !== again) { err.textContent = 'The two passwords do not match.'; err.hidden = false; return; }
    try {
      const r = await post('/api/password/reset', { token, password: pw });
      history.replaceState(null, '', location.pathname);
      await post('/api/login', { email: r.email, password: pw });
      toast('Password changed. You are signed in.', 'success', 5000);
      done();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  } } },
  field('New password', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, autofocus: true }),
  h('small', { class: 'muted' }, 'At least 10 characters, including a letter and a number.'),
  field('Type it again', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true }),
  err,
  h('button', { class: 'btn primary block', type: 'submit' }, 'Set new password and sign in'));
  screen(root,
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg', 'aria-hidden': 'true' }), h('div', null, h('div', { class: 'eyebrow' }, app.state.info?.name || ''), h('h1', null, 'Choose a new password'))),
    form,
    h('p', { class: 'small' }, h('a', { href: '#', on: { click: (e) => { e.preventDefault(); history.replaceState(null, '', location.pathname); done(); } } }, 'Back to sign in')));
  setTimeout(() => form.password.focus(), 0);
}

// First-time setup: one screen, checked as you go. The setup key (hosted installs only) is confirmed on its own first,
// so a wrong key is caught before anything else is typed.
export function renderSetup(root, app, done) {
  const keyNeeded = !!app.state.setupKeyRequired;
  let keyOk = !keyNeeded;
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const fieldError = (name) => h('small', { class: 'field-error', id: `e-${name}`, role: 'alert', hidden: true });
  const errs = { setupKey: fieldError('setupKey'), companyName: fieldError('companyName'), name: fieldError('name'), email: fieldError('email'), password: fieldError('password') };
  const showFieldError = (name, message) => {
    const el = errs[name];
    if (!el) return false;
    el.textContent = message;
    el.hidden = false;
    form.elements[name]?.setAttribute('aria-invalid', 'true');
    form.elements[name]?.focus();
    return true;
  };
  const clearErrors = () => {
    err.hidden = true;
    for (const [name, el] of Object.entries(errs)) { el.hidden = true; form.elements[name]?.removeAttribute('aria-invalid'); }
  };

  // ---- step 1: setup key ----
  const keyStatus = h('small', { class: 'muted' });
  const checkBtn = h('button', { class: 'btn', type: 'button', on: { click: () => checkKey() } }, 'Check key');
  async function checkKey() {
    clearErrors();
    const value = form.elements.setupKey.value.trim();
    if (!value) { showFieldError('setupKey', 'Type or paste the setup key first.'); return false; }
    checkBtn.disabled = true;
    try {
      await post('/api/setup/check-key', { setupKey: value });
      keyOk = true;
      fill(keyStatus, h('span', { class: 'ok' }, '✓ Key accepted. Now fill in the rest of the form.'));
      form.elements.companyName.focus();
      return true;
    } catch (ex) {
      keyOk = false;
      fill(keyStatus, '');
      showFieldError('setupKey', ex.message);
      return false;
    } finally { checkBtn.disabled = false; }
  }
  const keyStep = keyNeeded ? h('fieldset', null, h('legend', null, '1. Setup key'),
    h('div', { class: 'field' }, h('label', { for: 'a-setupKey' }, 'Setup key'),
      h('div', { class: 'inline-fields' },
        h('input', { id: 'a-setupKey', name: 'setupKey', required: true, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'e.g. 7KQM-2HXP-9DWR', class: 'grow', 'aria-describedby': 'e-setupKey', on: { input: () => { keyOk = false; fill(keyStatus, ''); }, keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); checkKey(); } } } }),
        checkBtn),
      errs.setupKey, keyStatus),
    h('details', { class: 'help' }, h('summary', null, 'Where do I find the setup key?'),
      h('ol', null,
        h('li', null, 'Sign in at dashboard.render.com.'),
        h('li', null, 'Click your service (vicello-platform).'),
        h('li', null, 'Click Logs in the left menu.'),
        h('li', null, 'Find the line FIRST-TIME SETUP KEY and copy the code after it.')),
      h('small', { class: 'muted' }, 'The key stays the same until setup is finished. Capitals and dashes do not matter.'))) : null;
  const n = (i) => (keyNeeded ? i + 1 : i);

  // ---- steps 2–4 ----
  const prefixIn = h('input', { id: 'a-jobPrefix', name: 'jobPrefix', maxlength: 6, placeholder: 'e.g. VIC', autocapitalize: 'characters' });
  let prefixTouched = false;
  prefixIn.addEventListener('input', () => { prefixTouched = true; });
  const companyIn = h('input', { id: 'a-companyName', name: 'companyName', required: true, autocomplete: 'organization', 'aria-describedby': 'e-companyName',
    on: { input: (e) => { if (!prefixTouched) prefixIn.value = e.target.value.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(); } } });
  const pwIn = h('input', { id: 'a-password', name: 'password', type: 'password', class: 'grow', required: true, autocomplete: 'new-password', minlength: 10, 'aria-describedby': 'e-password a-pw-rule' });
  const pwRule = h('small', { class: 'muted', id: 'a-pw-rule' }, 'At least 10 characters, including a letter and a number.');
  pwIn.addEventListener('input', () => {
    const v = pwIn.value;
    const ok = v.length >= 10 && /[a-zA-Z]/.test(v) && /[0-9]/.test(v);
    pwRule.className = ok ? 'ok small' : 'muted small';
    pwRule.textContent = ok ? '✓ Password is strong enough.' : 'At least 10 characters, including a letter and a number.';
  });

  const submitBtn = h('button', { class: 'btn primary block', type: 'submit' }, 'Create company and sign in');
  const form = h('form', { class: 'form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    clearErrors();
    if (keyNeeded && !keyOk && !(await checkKey())) return;
    const fd = new FormData(form);
    if (!String(fd.get('companyName') || '').trim()) { showFieldError('companyName', 'Enter your company name.'); return; }
    if (!String(fd.get('name') || '').trim()) { showFieldError('name', 'Enter your name.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(fd.get('email') || '').trim())) { showFieldError('email', 'Enter a valid email address, for example alex@vicello.com.au.'); return; }
    const pw = String(fd.get('password') || '');
    if (pw.length < 10 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) { showFieldError('password', 'Use at least 10 characters, including a letter and a number.'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Setting up… (about 10 seconds)';
    try {
      await post('/api/setup', {
        setupKey: fd.get('setupKey') || undefined,
        companyName: fd.get('companyName'), jobPrefix: fd.get('jobPrefix'), name: fd.get('name'), email: fd.get('email'),
        password: pw, priceBook: fd.get('priceBook'),
      });
      await post('/api/login', { email: fd.get('email'), password: pw });
      toast(`All set. Welcome, ${String(fd.get('name')).trim().split(' ')[0]}! Next: add your team in Settings → Users & access.`, 'success', 7000);
      done();
    } catch (ex) {
      if (!showFieldError(ex.details?.field, ex.message)) { err.textContent = ex.message; err.hidden = false; }
      if (ex.details?.field === 'setupKey') { keyOk = false; fill(keyStatus, ''); }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create company and sign in';
    }
  } } },
  keyStep,
  h('fieldset', null, h('legend', null, `${n(1)}. Your company`),
    h('div', { class: 'field' }, h('label', { for: 'a-companyName' }, 'Company name'), companyIn, errs.companyName),
    h('div', { class: 'field' }, h('label', { for: 'a-jobPrefix' }, 'Job number prefix'), prefixIn, h('small', { class: 'muted' }, 'Filled in for you. Job numbers will look like VIC-2026-0001.'))),
  h('fieldset', null, h('legend', null, `${n(2)}. Your owner login`),
    h('div', { class: 'field' }, h('label', { for: 'a-name' }, 'Your name'), h('input', { id: 'a-name', name: 'name', required: true, autocomplete: 'name', 'aria-describedby': 'e-name' }), errs.name),
    h('div', { class: 'field' }, h('label', { for: 'a-email' }, 'Email (you sign in with this)'), h('input', { id: 'a-email', name: 'email', type: 'email', required: true, autocomplete: 'username', 'aria-describedby': 'e-email' }), errs.email),
    h('div', { class: 'field' }, h('label', { for: 'a-password' }, 'Password'),
      h('div', { class: 'inline-fields' }, pwIn, h('button', { class: 'btn ghost small', type: 'button', on: { click: (e) => { const show = pwIn.type === 'password'; pwIn.type = show ? 'text' : 'password'; e.currentTarget.textContent = show ? 'Hide' : 'Show'; } } }, 'Show')),
      pwRule, errs.password)),
  h('fieldset', null, h('legend', null, `${n(3)}. Starting price book`),
    h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'priceBook', value: 'material-labour', checked: true }),
      h('span', null, h('strong', null, 'Material + Labour cost book (October 2026)'), h('small', { class: 'muted' }, 'Every item from the new spreadsheet, with material, hardware and labour costs exactly as listed. Recommended.'))),
    h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'priceBook', value: 'legacy' }),
      h('span', null, h('strong', null, 'The older V0.1 Excel price book'), h('small', { class: 'muted' }, '137 modules and 419 options from the V0.1 workbook.'))),
    h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'priceBook', value: 'starter' }),
      h('span', null, h('strong', null, 'A small example'), h('small', { class: 'muted' }, 'A few sample items to replace with your own.')))),
  err,
  submitBtn);
  // ---- or: start this new site from a backup (recovery, moving host, a test copy of live data) ----
  async function restoreFrom(source) {
    clearErrors();
    if (keyNeeded && !keyOk && !(await checkKey())) return;
    const setupKey = keyNeeded ? form.elements.setupKey.value.trim() : '';
    let file = null;
    if (source === 'file') { file = await pickRawFile('.db,.vbak'); if (!file) return; }
    try {
      const done2 = await runRestore({
        needPassword: false,
        warning: 'This new site will start from the backup: the company, users, price books, jobs and quotes in it. Sign in afterwards with an email and password from the backup.',
        check: (backupKey) => (file
          ? postFile('/api/setup/restore/check', file, { 'X-Setup-Key': setupKey, ...(backupKey ? { 'X-Backup-Key': backupKey } : {}) })
          : post('/api/setup/restore/check', { setupKey, offsiteLatest: true, backupKey })),
        apply: (token) => post('/api/setup/restore/apply', { token, setupKey }),
      });
      if (done2) { toast('Backup restored. Sign in with your usual email and password.', 'success', 7000); done(); }
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  }
  const restoreBox = h('details', { class: 'help restore-box' },
    h('summary', null, 'Recovering the system or moving it? Start from a backup instead'),
    h('p', { class: 'small' }, 'Use this instead of the form above when this new site should carry on from existing data: after a disaster, when moving to a new host, or to make a test site from a copy of the live data.'),
    h('div', { class: 'row-actions left' },
      h('button', { class: 'btn', type: 'button', on: { click: () => restoreFrom('file') } }, 'Choose a backup file (.db or .vbak)…'),
      h('button', { class: 'btn ghost', type: 'button', on: { click: () => restoreFrom('offsite') } }, 'Use the latest off-site backup')),
    h('small', { class: 'muted' }, 'The latest off-site backup needs the off-site storage settings on this site (see docs/disaster-recovery.md). Encrypted backups ask for the backup encryption key.'));
  screen(root,
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg', 'aria-hidden': 'true' }), h('div', null, h('div', { class: 'eyebrow' }, app.state.info?.name || ''), h('h1', null, 'Set up your company'))),
    h('p', { class: 'muted' }, `One-time setup, about 2 minutes. You will be signed in straight away and can then add your team.`),
    form,
    restoreBox);
  setTimeout(() => (keyNeeded ? form.elements.setupKey : companyIn).focus(), 0);
}

export async function changePasswordDialog(forced = false) {
  const values = await formDialog({
    title: forced ? 'Choose a new password' : 'Change my password',
    intro: forced ? 'Your password was set by an administrator. Choose your own before continuing.' : null,
    fields: [
      { name: 'currentPassword', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'newPassword', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', help: 'At least 10 characters, including a letter and a number.' },
      { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    validate: (v) => (v.newPassword !== v.confirm ? 'The new passwords do not match.' : null),
    submitLabel: 'Change password',
  });
  if (!values) return;
  try {
    await post('/api/account/password', values);
    toast('Password changed.', 'success');
  } catch (err) { showError(err); }
}
