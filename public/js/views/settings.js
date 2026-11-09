// Admin area: company, users, templates, backups, activity log.
import { get, put, post, del, download, postFile, pickRawFile } from '../api.js';
import { scheduleMeta, invalidateMeta } from './event-dialog.js';
import { h, clear, fill, fmt, formDialog, confirmDialog, modal, toast, showError, STATUS_LABELS } from '../ui.js';
import { runRestore } from './restore.js';

const SECTIONS = [['company', 'Company & quotes', 'manager'], ['users', 'Users & access', 'owner'], ['statuses', 'Job statuses', 'manager'], ['staff', 'Staff & resources', 'manager'], ['workflow', 'Workflow events', 'manager'], ['templates', 'Area templates', 'manager'], ['backups', 'Backups & restore', 'owner'], ['activity', 'Activity log', 'manager']];

export async function mount(el, params, app) {
  if (!app.isManager()) throw Object.assign(new Error('Only owners and admins can open settings.'), { status: 403 });
  const allowed = SECTIONS.filter(([, , r]) => r === 'manager' || app.isOwner());
  let section = allowed.some(([k]) => k === params[0]) ? params[0] : 'company';
  let dirty = false;
  const body = h('div', { class: 'settings-body' });
  const nav = h('nav', { class: 'settings-nav' });
  fill(el, h('div', { class: 'page-head' }, h('h1', null, 'Settings')), h('div', { class: 'settings' }, nav, body));

  async function render() {
    fill(nav, ...allowed.map(([k, label]) => h('a', { href: `#/settings/${k}`, class: k === section ? 'on' : '' }, label)));
    fill(body, h('div', { class: 'loading' }, 'Loading…'));
    try {
      const view = await ({ company, users, statuses, staff, workflow, templates, backups, activity })[section]();
      fill(body, view);
    } catch (err) { fill(body, h('p', { class: 'form-error' }, err.message)); }
  }

  // ---------- company ----------
  async function company() {
    const c = await get('/api/company');
    const form = h('form', { class: 'form', on: { input: () => { dirty = true; app.updateTitle(); }, submit: async (e) => { e.preventDefault(); await saveCompany(); } } });
    const fld = (label, name, attrs = {}, help) => h('label', { class: 'field' }, h('span', null, label), h('input', { name, value: c[name] ?? '', ...attrs }), help ? h('small', { class: 'muted' }, help) : null);
    form.append(
      h('div', { class: 'grid-2 tight' },
        h('fieldset', null, h('legend', null, 'Business details (printed on quotes)'),
          fld('Trading name', 'name', { required: true }), fld('Legal name', 'legalName'), fld('ABN', 'abn'), fld('Licence number', 'licenceNo', { placeholder: 'e.g. 339569C' }), fld('Address', 'address'),
          fld('Phone', 'phone'), fld('Email', 'email', { type: 'email' }), fld('Website', 'website'),
          logoField()),
        h('fieldset', null, h('legend', null, 'Pricing rules'),
          fld('Job number prefix', 'jobPrefix', { maxlength: 6 }, 'Job numbers look like PREFIX-2026-0001.'),
          h('label', { class: 'field' }, h('span', null, 'GST %'), h('input', { name: 'gstRate', type: 'number', step: 'any', min: 0, value: fmt.dec2(Math.round(c.gstRate * 100 * 1e6) / 1e6) })),
          h('label', { class: 'field' }, h('span', null, 'Margin floor %'), h('input', { name: 'floorMargin', type: 'number', step: 'any', min: 0, value: fmt.dec2(Math.round(c.floorMargin * 100 * 1e6) / 1e6) }), h('small', { class: 'muted' }, 'Items or jobs priced below this margin need owner/admin approval before quoting.')),
          h('label', { class: 'field' }, h('span', null, 'Quote valid for (days)'), h('input', { name: 'quoteValidityDays', type: 'number', min: 1, value: c.quoteValidityDays })))),
      h('label', { class: 'field' }, h('span', null, 'Standard inclusions (first row of every quote, priced "Included")'), h('textarea', { name: 'quoteInclusions', rows: 8 }, c.quoteInclusions || '')),
      h('label', { class: 'field' }, h('span', null, 'Quote terms and conditions (printed after the totals)'), h('textarea', { name: 'quoteTerms', rows: 14 }, c.quoteTerms || ''),
        h('small', { class: 'muted' }, 'Formatting: a line in CAPITALS ending with ":" is a heading; "- " starts a bullet, "  - " a sub-bullet; **bold**. Changes apply to quotes created from now on; issued quotes never change.')),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings')));
    // Quote logo: shown centred at the top of every quote page (otherwise the company name is printed as a wordmark).
    let logoValue; // undefined = unchanged, '' = remove, data URL = new picture
    function logoField() {
      const preview = h('div', { class: 'logo-preview' });
      const show = (src) => fill(preview, src ? h('img', { src, alt: 'Quote logo' }) : h('span', { class: 'muted small' }, `No logo: the quote shows "${(c.name || '').toUpperCase()}" in large letters.`));
      show(c.quoteLogo);
      return h('div', { class: 'field' }, h('span', null, 'Quote logo'), preview,
        h('div', { class: 'row-actions left' },
          h('button', { type: 'button', class: 'btn small', on: { click: async () => {
            const f = await pickRawFile('image/png,image/jpeg,image/webp');
            if (!f) return;
            if (f.size > 600 * 1024) { toast('Choose a picture under 600 KB.', 'error'); return; }
            logoValue = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
            show(logoValue); dirty = true; app.updateTitle();
          } } }, 'Choose picture…'),
          h('button', { type: 'button', class: 'btn small ghost', on: { click: () => { logoValue = ''; show(''); dirty = true; app.updateTitle(); } } }, 'Remove')),
        h('small', { class: 'muted' }, 'PNG, JPEG or WebP, wide format, under 600 KB.'));
    }
    async function saveCompany() {
      const fd = Object.fromEntries(new FormData(form));
      try {
        const saved = await put('/api/company', { ...fd, gstRate: Number(fd.gstRate) / 100, floorMargin: Number(fd.floorMargin) / 100, quoteValidityDays: Number(fd.quoteValidityDays), ...(logoValue !== undefined ? { quoteLogo: logoValue } : {}) });
        logoValue = undefined;
        await app.reloadState();
        dirty = false;
        app.updateTitle();
        document.querySelector('.brand span:last-child').textContent = saved.name;
        toast('Settings saved.', 'success');
        return true;
      } catch (err) { showError(err); return false; }
    }
    companySave = saveCompany;
    return h('section', { class: 'panel' }, h('h2', null, 'Company & quotes'), form);
  }
  let companySave = null;

  // ---------- users ----------
  async function users() {
    const [list, mailPanel] = await Promise.all([get('/api/users'), emailPanel()]);
    const roleText = { owner: 'Owner – everything, including users and backups', admin: 'Admin – pricing, settings, approvals', designer: 'Designer – jobs and quotes' };
    return h('div', null, h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Users & access'), h('button', { class: 'btn primary', on: { click: addUser } }, '+ Add user')),
      h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Email'), h('th', null, 'Role'), h('th', null, 'Last sign-in'), h('th', null, 'Status'), h('th'))),
        h('tbody', null, list.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
          h('td', { class: 'strong' }, u.name, u.id === app.state.user.id ? h('span', { class: 'chip small' }, 'You') : null),
          h('td', null, u.email),
          h('td', null, h('select', { 'aria-label': `Role for ${u.name}`, disabled: u.id === app.state.user.id, on: { change: (e) => updateUser(u, { role: e.target.value }) } }, Object.keys(roleText).map((r) => h('option', { value: r, selected: r === u.role }, r[0].toUpperCase() + r.slice(1))))),
          h('td', null, fmt.ago(u.lastLoginAt)),
          h('td', null, u.active ? h('span', { class: 'chip ok' }, 'Active') : h('span', { class: 'chip' }, 'Disabled'), u.mustChangePassword ? h('span', { class: 'chip warn small' }, 'Temp password') : null),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn small', on: { click: () => resetPassword(u) } }, 'Reset password'),
            u.id !== app.state.user.id ? h('button', { class: 'btn small ghost', on: { click: () => updateUser(u, { active: !u.active }) } }, u.active ? 'Disable' : 'Enable') : null))))),
      h('ul', { class: 'muted small' }, Object.values(roleText).map((t) => h('li', null, t)))), mailPanel);
  }
  async function addUser() {
    const v = await formDialog({
      title: 'Add user', submitLabel: 'Add user',
      fields: [
        { name: 'name', label: 'Name', required: true, autofocus: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'role', label: 'Role', type: 'select', value: 'designer', options: [{ value: 'designer', label: 'Designer' }, { value: 'admin', label: 'Admin' }, { value: 'owner', label: 'Owner' }] },
        { name: 'password', label: 'Temporary password', type: 'password', required: true, autocomplete: 'new-password', help: `At least 10 characters with a letter and a number. They must change it when they first sign in.${app.state.info?.emailEnabled ? ' It is emailed to them with the sign-in link.' : ''}` },
      ],
    });
    if (!v) return;
    try {
      const u = await post('/api/users', v);
      toast(u.emailSent ? `${v.name} can now sign in. Their login details were emailed to ${v.email}.`
        : `${v.name} can now sign in. ${app.state.info?.emailEnabled ? `The email could not be sent (${u.emailError}), so` : 'Email is not set up, so'} give them their temporary password yourself.`, u.emailSent ? 'success' : 'info', 8000);
      render();
    } catch (err) { showError(err); }
  }
  async function updateUser(u, patch) {
    try {
      const r = await put(`/api/users/${u.id}`, patch);
      toast(patch.password ? (r.emailSent ? `Password reset. The temporary password was emailed to ${u.email}.` : 'Password reset. Give them the temporary password yourself (it was not emailed).') : 'User updated.', 'success', patch.password ? 7000 : 3000);
    } catch (err) { showError(err); }
    render();
  }
  // Email status and a test button (owner only), shown under Users & access.
  async function emailPanel() {
    const e = await get('/api/admin/email');
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Email'),
        e.enabled ? h('button', { class: 'btn', on: { click: async (ev) => {
          const btn = ev.currentTarget;
          const v = await formDialog({ title: 'Send a test email', submitLabel: 'Send', fields: [{ name: 'to', label: 'Send to', type: 'email', value: app.state.user.email, required: true }] });
          if (!v) return;
          btn.disabled = true;
          try { const r = await post('/api/admin/email/test', v); toast(`Test email sent to ${r.to}. Check the inbox (and junk folder).`, 'success', 7000); } catch (err) { showError(err); } finally { btn.disabled = false; }
        } } }, 'Send test email') : null),
      e.enabled
        ? h('dl', { class: 'facts' },
          h('dt', null, 'Mail server'), h('dd', { class: 'small' }, `${e.host}:${e.port}`),
          h('dt', null, 'Sent from'), h('dd', { class: 'small' }, e.from),
          h('dt', null, 'Links in emails go to'), h('dd', { class: 'small' }, e.appUrl || '— set APP_URL'),
          h('dt', null, 'System notices go to'), h('dd', { class: 'small' }, e.notify))
        : h('p', { class: 'banner warn' }, 'Email is not set up. New users and password resets are not emailed, and "Forgotten your password?" is not offered. To turn it on, add the SMTP settings under Render → Environment (see DEPLOY_TO_RENDER.md).'),
      h('p', { class: 'muted small' }, 'Emails are sent when a user is added (their login), when an owner resets a password, when someone asks for a reset link, and to owners when backups fail or a backup is restored.'));
  }
  async function resetPassword(u) {
    const v = await formDialog({ title: `Reset password for ${u.name}`, fields: [{ name: 'password', label: 'New temporary password', type: 'password', required: true, autocomplete: 'new-password' }], submitLabel: 'Reset', intro: 'They will be signed out and asked to choose their own password at next sign-in.' });
    if (v) updateUser(u, { password: v.password });
  }

  // ---------- job statuses ----------
  async function statuses() {
    const list = await get('/api/statuses?all=1');
    const core = list.filter((s) => s.builtin);
    const refresh = async () => { await app.reloadState(); render(); };
    const run = async (fn, msg) => { try { await fn(); toast(msg, 'success'); await refresh(); } catch (err) { showError(err); } };
    async function rename(s) {
      const v = await formDialog({ title: `Rename "${s.label}"`, fields: [{ name: 'label', label: 'Name', value: s.label, required: true, autofocus: true }], submitLabel: 'Save',
        intro: s.builtin ? 'This is a main status. Renaming it changes how it is shown; reports keep counting it the same way.' : null });
      if (v) run(() => put(`/api/statuses/${s.key}`, { label: v.label, active: s.active }), 'Status renamed.');
    }
    async function add() {
      const v = await formDialog({
        title: 'Add a status', submitLabel: 'Add status',
        intro: 'A new status is a variation of one of the main statuses, for example "Quoted – awaiting builder" under Quoted. Reports and price locking count it as that main status.',
        fields: [
          { name: 'label', label: 'Name', required: true, autofocus: true, placeholder: 'e.g. Awaiting builder' },
          { name: 'baseStatus', label: 'Counts as', type: 'select', value: 'quoted', options: core.map((s) => ({ value: s.key, label: s.label })) },
        ],
      });
      if (v) run(() => post('/api/statuses', v), `"${v.label}" added.`);
    }
    async function remove(s) {
      if (!(await confirmDialog({ title: 'Delete status', message: `Delete "${s.label}"?\n\nIt can only be deleted if no job uses it. If jobs use it, turn it off instead: those jobs keep it, and it is no longer offered for other jobs.`, confirmLabel: 'Delete', danger: true }))) return;
      try { await del(`/api/statuses/${s.key}`); toast('Status deleted.', 'success'); await refresh(); } catch (err) {
        if (err.status === 409 && err.details?.used && (await confirmDialog({ title: 'Status in use', message: `${err.message}\n\nTurn "${s.label}" off now?`, confirmLabel: 'Turn off' }))) run(() => put(`/api/statuses/${s.key}`, { label: s.label, active: false }), 'Status turned off.');
        else if (err.status !== 409 || !err.details?.used) showError(err);
      }
    }
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Job statuses'), h('button', { class: 'btn primary', on: { click: add } }, '+ Add status')),
      h('p', { class: 'muted small' }, 'The eight main statuses drive reports (Jobs won, Jobs missed…), price locking (Won and later) and the schedule; they can be renamed but not removed. Add your own statuses under any of them. Moving a job out of Complete or Missed (reopening it) always asks for a reason.'),
      h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Counts as'), h('th', null, 'Offered'), h('th'))),
        h('tbody', null, list.map((s) => h('tr', { class: s.active ? '' : 'inactive' },
          h('td', null, s.builtin ? h('strong', null, s.label) : h('span', null, '   – ', s.label)),
          h('td', { class: 'small' }, s.builtin ? h('span', { class: 'chip small' }, 'Main status') : STATUS_LABELS[s.baseStatus] || s.baseStatus),
          h('td', null, s.builtin ? h('span', { class: 'chip ok' }, 'Always') : h('label', { class: 'check inline' }, h('input', { type: 'checkbox', checked: s.active, on: { change: (e) => run(() => put(`/api/statuses/${s.key}`, { label: s.label, active: e.target.checked }), e.target.checked ? 'Status turned on.' : 'Status turned off. Jobs that have it keep it.') } }), h('span', null, s.active ? 'On' : 'Off'))),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn small', on: { click: () => rename(s) } }, 'Rename'),
            s.builtin ? null : h('button', { class: 'btn small ghost', on: { click: () => remove(s) } }, 'Delete')))))));
  }

  // ---------- staff & leave ----------
  async function staff() {
    const meta = await scheduleMeta(true);
    const list = await get('/api/staff?all=1');
    const today = new Date().toISOString().slice(0, 10);
    const leave = await get(`/api/leave?from=${today}`);
    const catOptions = Object.entries(meta.categories).map(([v, l]) => ({ value: v, label: l }));
    async function editStaff(s) {
      const v = await formDialog({
        title: s ? `Edit ${s.name}` : 'Add staff member', submitLabel: s ? 'Save' : 'Add',
        intro: s?.placeholder ? 'This is a system-generated sample person. Rename them to a real staff member or disable them.' : null,
        fields: [
          { name: 'name', label: 'Name', value: s?.name || '', required: true, autofocus: true },
          { name: 'position', label: 'Position', value: s?.position || '', required: true, placeholder: 'e.g. Lead Installer' },
          { name: 'category', label: 'Category (what work they can be booked for)', type: 'select', value: s?.category || 'installer', options: catOptions },
          { name: 'hoursPerDay', label: 'Working hours per day', type: 'number', step: 'any', value: s?.hoursPerDay ?? 7.6 },
          { name: 'email', label: 'Email', type: 'email', value: s?.email || '' },
          { name: 'phone', label: 'Phone', value: s?.phone || '' },
          { name: 'colour', label: 'Calendar colour', type: 'color', value: s?.colour || '#2B6653' },
          ...(s ? [{ name: 'active', label: 'Active (can be booked)', type: 'checkbox', value: s.active }] : []),
        ],
      });
      if (!v) return;
      try {
        if (s) await put(`/api/staff/${s.id}`, v); else await post('/api/staff', v);
        invalidateMeta(); toast('Saved.', 'success'); render();
      } catch (err) { showError(err); }
    }
    async function addLeave() {
      const v = await formDialog({
        title: 'Record leave', submitLabel: 'Save',
        fields: [
          { name: 'staffId', label: 'Staff member', type: 'select', options: list.filter((s) => s.active).map((s) => ({ value: s.id, label: `${s.name} – ${s.position}` })) },
          { name: 'start', label: 'From', type: 'date', value: today, required: true },
          { name: 'end', label: 'To (inclusive)', type: 'date', value: today, required: true },
          { name: 'reason', label: 'Reason', placeholder: 'Annual leave, training…' },
        ],
        validate: (x) => (x.end < x.start ? 'The end date is before the start date.' : null),
      });
      if (!v) return;
      try { await post('/api/leave', { ...v, staffId: Number(v.staffId) }); toast('Leave recorded. The calendar shows them as unavailable.', 'success'); render(); } catch (err) { showError(err); }
    }
    return h('div', null,
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Resource pool'), h('button', { class: 'btn primary', on: { click: () => editStaff(null) } }, '+ Add staff')),
        h('p', { class: 'muted small' }, 'People who can be booked on job events. The category decides which events the system suggests them for. Staff marked "Sample" were generated as placeholders; replace them with your real team.'),
        h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Position'), h('th', null, 'Category'), h('th', { class: 'num' }, 'Hours/day'), h('th', null, 'Status'), h('th'))),
          h('tbody', null, list.map((s) => h('tr', { class: s.active ? '' : 'inactive' },
            h('td', null, h('span', { class: 'staff-chip', style: { '--c': s.colour } }, s.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('')), ' ', h('span', { class: 'strong' }, s.name), s.placeholder ? h('span', { class: 'chip small' }, 'Sample') : null),
            h('td', null, s.position), h('td', null, s.categoryName), h('td', { class: 'num' }, String(s.hoursPerDay)),
            h('td', null, s.active ? h('span', { class: 'chip ok' }, 'Active') : h('span', { class: 'chip' }, 'Inactive')),
            h('td', null, h('button', { class: 'btn small', on: { click: () => editStaff(s) } }, 'Edit'))))))),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Leave & unavailability'), h('button', { class: 'btn', on: { click: addLeave } }, '+ Record leave')),
        leave.length ? h('table', { class: 'table compact' }, h('tbody', null, leave.map((l) => h('tr', null,
          h('td', { class: 'strong' }, l.staffName), h('td', null, `${fmt.date(l.start)} – ${fmt.date(l.end)}`), h('td', { class: 'muted' }, l.reason),
          h('td', null, h('button', { class: 'btn small ghost', on: { click: async () => { await del(`/api/leave/${l.id}`); render(); } } }, 'Remove'))))))
          : h('p', { class: 'muted' }, 'No current or upcoming leave.')));
  }

  // ---------- workflow event types ----------
  async function workflow() {
    const meta = await scheduleMeta(true);
    const anchors = [['job_created', 'Job created'], ...meta.types.flatMap((t) => [[t.key, `${t.name} (start)`], [`${t.key}:end`, `${t.name} (end)`]])];
    const reminderOpts = [[0, 'None'], [60, '1 hour'], [1440, '1 day'], [2880, '2 days'], [10080, '1 week']];
    const rows = meta.types.map((t) => {
      const f = {};
      const sel = (name, value, options) => (f[name] = h('select', { class: 'small-select' }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l))));
      const num = (name, value, step = '1') => (f[name] = h('input', { type: 'number', class: 'num-in', step, min: 0, value }));
      const save = h('button', { class: 'btn small', on: { click: async () => {
        const body = {
          name: f.name.value, staffCategory: f.staffCategory.value, staffCount: Number(f.staffCount.value), unit: f.unit.value, duration: Number(f.duration.value),
          anchor: f.anchor.value, offsetDays: Number(f.offsetDays.value), rule: f.rule.value, reminderMinutes: Number(f.reminderMinutes.value), defaultStart: f.defaultStart.value, active: f.active.checked,
        };
        try { await put(`/api/event-types/${t.key}`, body); invalidateMeta(); toast(`${body.name} saved. New proposals use it.`, 'success'); } catch (err) { showError(err); }
      } } }, 'Save');
      f.name = h('input', { value: t.name, 'aria-label': 'Name' });
      f.defaultStart = h('input', { type: 'time', value: t.defaultStart, 'aria-label': 'Default start' });
      f.active = h('input', { type: 'checkbox', checked: t.active, 'aria-label': 'Active' });
      return h('tr', null,
        h('td', null, h('span', { class: 'type-dot', style: { background: t.colour } }), f.name),
        h('td', null, sel('rule', t.rule, Object.entries(meta.rules)), h('div', { class: 'muted small' }, meta.rules[t.rule])),
        h('td', null, sel('staffCategory', t.staffCategory, Object.entries(meta.categories)), ' × ', num('staffCount', t.staffCount)),
        h('td', { class: 'nowrap' }, num('duration', t.duration, '0.5'), ' ', sel('unit', t.unit, [['minutes', 'min'], ['days', 'days']])),
        h('td', { class: 'nowrap' }, num('offsetDays', t.offsetDays), ' days after ', sel('anchor', t.anchor, anchors.filter(([k]) => !k.startsWith(t.key)))),
        h('td', null, f.defaultStart),
        h('td', null, sel('reminderMinutes', t.reminderMinutes, reminderOpts)),
        h('td', null, f.active),
        h('td', { class: 'row-actions' }, save, h('button', { class: 'btn small ghost', title: 'Delete this milestone', on: { click: () => removeType(t) } }, 'Delete')));
    });
    async function addType() {
      const v = await formDialog({
        title: 'Add workflow milestone', submitLabel: 'Add milestone', width: 560,
        intro: 'New jobs get this milestone in their proposed schedule (and existing jobs when you press Recalculate on their Schedule tab), according to the rule.',
        fields: [
          { name: 'name', label: 'Name', required: true, autofocus: true, placeholder: 'e.g. Pre-production plan review' },
          { name: 'rule', label: 'Required when', type: 'select', value: 'always', options: Object.entries(meta.rules).map(([value, label]) => ({ value, label })) },
          { name: 'staffCategory', label: 'Staff category', type: 'select', value: 'designer', options: Object.entries(meta.categories).map(([value, label]) => ({ value, label })) },
          { name: 'staffCount', label: 'Number of staff', type: 'number', value: 1, min: 0, step: '1' },
          { name: 'duration', label: 'Duration', type: 'number', value: 60, min: 0, step: 'any' },
          { name: 'unit', label: 'Duration unit', type: 'select', value: 'minutes', options: [{ value: 'minutes', label: 'Minutes' }, { value: 'days', label: 'Days' }] },
          { name: 'anchor', label: 'Scheduled after', type: 'select', value: meta.types.length ? `${meta.types[meta.types.length - 1].key}:end` : 'job_created', options: anchors.map(([value, label]) => ({ value, label })) },
          { name: 'offsetDays', label: 'Days after that', type: 'number', value: 2, min: 0, step: '1' },
          { name: 'defaultStart', label: 'Starts at', type: 'time', value: '09:00' },
          { name: 'reminderMinutes', label: 'Reminder', type: 'select', value: '1440', options: reminderOpts.map(([value, label]) => ({ value: String(value), label })) },
        ],
      });
      if (!v) return;
      try {
        await post('/api/event-types', { ...v, staffCount: Number(v.staffCount), duration: Number(v.duration), offsetDays: Number(v.offsetDays), reminderMinutes: Number(v.reminderMinutes) });
        invalidateMeta(); toast(`"${v.name}" added. New schedule proposals include it.`, 'success'); render();
      } catch (err) { showError(err); }
    }
    async function removeType(t) {
      const ok = await confirmDialog({ title: 'Delete milestone', danger: true, confirmLabel: 'Delete milestone',
        message: `Delete "${t.name}"?\n\nIt will no longer be proposed for any job. Milestones timed from it will be timed from what it was timed from instead.\n\nA milestone already on any job's schedule cannot be deleted (those jobs keep it). Untick "On" instead to stop proposing it. This cannot be undone.` });
      if (!ok) return;
      try {
        const out = await del(`/api/event-types/${t.key}`);
        invalidateMeta();
        toast(`"${t.name}" deleted.${out.retimed.length ? ` Now timed from its starting point: ${out.retimed.join(', ')}.` : ''}`, 'success', 6000);
        render();
      } catch (err) {
        if (err.status === 409 && err.details?.used && (await confirmDialog({ title: 'Milestone in use', message: `${err.message}\n\nTurn "${t.name}" off now?`, confirmLabel: 'Turn off' }))) {
          try { await put(`/api/event-types/${t.key}`, { active: false }); invalidateMeta(); toast(`"${t.name}" turned off. Jobs that have it keep it.`, 'success'); render(); } catch (e2) { showError(e2); }
        } else if (err.status !== 409 || !err.details?.used) showError(err);
      }
    }
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Workflow events'), h('button', { class: 'btn primary', on: { click: addType } }, '+ Add milestone')),
      h('p', { class: 'muted small' }, 'When a job is created, the system checks each event\'s rule against the job and proposes the ones it needs, with dates from these lead times and staff from the matching category. Install length is sized from the job\'s estimated install hours, and check measures grow with the number of areas. Designers review and confirm the proposal on the job\'s Schedule tab. Changes here apply to new proposals and to "Recalculate".'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table compact workflow-table' },
        h('thead', null, h('tr', null, h('th', null, 'Event'), h('th', null, 'Required when'), h('th', null, 'Staff'), h('th', null, 'Duration'), h('th', null, 'Scheduled'), h('th', null, 'Starts'), h('th', null, 'Reminder'), h('th', null, 'On'), h('th'))),
        h('tbody', null, rows))));
  }

  // ---------- templates ----------
  async function templates() {
    const [list, pbs] = await Promise.all([get('/api/templates'), get('/api/price-books')]);
    const book = pbs.currentId ? await get(`/api/price-books/${pbs.currentId}`) : { modules: [] };
    const name = (k) => book.modules.find((m) => m.key === k)?.name || `${k} (not in current price book)`;
    return h('section', { class: 'panel' },
      h('h2', null, 'Area templates'),
      h('p', { class: 'muted' }, 'Templates pre-fill a new area with typical items. To create one, build an area in any job and choose ⋯ → Save as template.'),
      list.length ? h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Template'), h('th', null, 'Items'), h('th'))),
        h('tbody', null, list.map((t) => h('tr', null,
          h('td', { class: 'strong' }, t.name, h('div', { class: 'muted small' }, `${t.areaType}${t.defaultFinish ? ` · finish ${t.defaultFinish}` : ''}`)),
          h('td', { class: 'small' }, t.lines.map((l) => name(l.moduleKey)).join(', ')),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn small', on: { click: async () => { const v = await formDialog({ title: 'Rename template', fields: [{ name: 'name', label: 'Name', value: t.name, required: true }], submitLabel: 'Save' }); if (v) { await post('/api/templates', { ...t, name: v.name }); render(); } } } }, 'Rename'),
            h('button', { class: 'btn small ghost', on: { click: async () => { if (await confirmDialog({ title: 'Delete template', message: `Delete "${t.name}"?`, confirmLabel: 'Delete', danger: true })) { await del(`/api/templates/${t.id}`); render(); } } } }, 'Delete'))))))
        : h('p', null, 'No templates yet.'));
  }

  // ---------- backups ----------
  async function backups() {
    const [b, info, off] = await Promise.all([get('/api/admin/backups'), get('/api/admin/info'), get('/api/admin/offsite')]);
    const KIND = { auto: 'Automatic (daily)', manual: 'Manual', 'pre-upgrade': 'Before an upgrade', 'pre-restore': 'Before a restore' };
    const warning = 'Restoring replaces ALL current data on this site with the backup. A safety copy of the current data is made first (listed below as "Before a restore"). Everyone is signed out and signs in again with the passwords in the backup.';
    const restoreWith = (body, file) => runRestore({
      needPassword: true, warning,
      check: (key) => (file ? postFile('/api/admin/restore/check', file, key ? { 'X-Backup-Key': key } : {}) : post('/api/admin/restore/check', { ...body, backupKey: key })),
      apply: (token, { password }) => post('/api/admin/restore/apply', { token, password }),
    }).then((done) => { if (done) { toast('Backup restored. Please sign in again.', 'success', 4000); setTimeout(() => location.reload(), 1500); } }).catch(showError);
    const offsiteRows = h('div');
    const ago = (iso) => (iso ? `${fmt.datetime(iso)} (${fmt.ago(iso)})` : 'never');
    const offStatus = !off.configured
      ? h('div', { class: 'banner warn' }, h('strong', null, 'Off-site backup is not set up. '), `Until it is, every copy of the data is on this server. Settings still needed on the hosting service: ${off.missing.join(', ')}. See docs/backup-strategy.md.`)
      : h('div', null,
        off.lastError ? h('div', { class: 'banner bad' }, h('strong', null, 'The last off-site backup failed: '), off.lastError, ` (${ago(off.lastErrorAt)}).`) : null,
        h('dl', { class: 'facts' },
          h('dt', null, 'Storage'), h('dd', { class: 'small' }, `${off.bucket} · ${off.prefix}/ · ${off.endpoint}`),
          h('dt', null, 'Schedule'), h('dd', { class: 'small' }, `Every ${off.intervalMinutes} min when data has changed; a daily copy (kept 13 months) and a monthly copy (kept ${off.monthlyYears} years)${off.objectLock ? `; locked against deletion for ${off.lockDays} days (monthly: ${off.monthlyYears} years)` : ''}.`),
          h('dt', null, 'Last check'), h('dd', null, ago(off.lastOkAt)),
          h('dt', null, 'Last upload'), h('dd', null, ago(off.lastUploadAt), off.lastBytes ? h('span', { class: 'muted small' }, ` · ${(off.lastBytes / 1024 / 1024).toFixed(2)} MB encrypted`) : null),
          h('dt', null, 'Last daily / monthly'), h('dd', null, `${off.lastDailyDate || '—'} / ${off.lastMonthly || '—'}`),
          h('dt', null, 'Missed-backup alert'), h('dd', null, off.heartbeat ? 'On (BACKUP_HEARTBEAT_URL)' : 'Off – set BACKUP_HEARTBEAT_URL so someone is told if backups stop')));
    return h('div', null,
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Off-site backups'),
          off.configured ? h('button', { class: 'btn primary', on: { click: async (e) => { e.currentTarget.disabled = true; try { await post('/api/admin/offsite/run'); toast('Off-site backup uploaded and confirmed.', 'success'); } catch (err) { showError(err); } render(); } } }, 'Back up off-site now') : null),
        h('p', { class: 'muted small' }, 'Encrypted copies kept with a different company from the hosting service, so the data survives even if this server, its disk or the hosting account is lost.'),
        offStatus,
        off.canRead ? h('div', null,
          h('div', { class: 'row-actions left' },
            h('button', { class: 'btn', on: { click: () => restoreWith({ offsiteLatest: true }) } }, 'Restore the latest off-site backup…'),
            h('button', { class: 'btn ghost', on: { click: async () => {
              try {
                const list = await get('/api/admin/offsite/list');
                fill(offsiteRows, list.length ? h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Off-site backup'), h('th', null, 'Kind'), h('th', null, 'Uploaded'), h('th', { class: 'num' }, 'Size'), h('th'))),
                  h('tbody', null, list.map((o) => h('tr', null, h('td', { class: 'mono small' }, o.key.split('/').pop()), h('td', { class: 'small' }, o.kind), h('td', null, fmt.datetime(o.at)), h('td', { class: 'num' }, `${(o.size / 1024 / 1024).toFixed(2)} MB`),
                    h('td', null, h('button', { class: 'btn small', on: { click: () => restoreWith({ offsiteKey: o.key }) } }, 'Restore…'))))))
                  : h('p', { class: 'muted' }, 'No off-site backups found yet.'));
              } catch (err) { showError(err); }
            } } }, 'Show off-site backups')),
          offsiteRows) : null),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Backups on this server'), h('button', { class: 'btn primary', on: { click: async (e) => { e.currentTarget.disabled = true; try { await post('/api/admin/backups'); toast('Backup created and checked.', 'success'); } catch (err) { showError(err); } render(); } } }, 'Back up now')),
        h('p', null, 'A backup is a complete copy of the database: price books, jobs, quotes, costs, schedules and users. Every copy is checked as soon as it is made.'),
        h('ul', { class: 'small' },
          h('li', null, b.auto ? `An automatic backup is made once a day. The newest ${b.keep} automatic backups are kept; copies made before an upgrade or a restore are kept 90 days; backups you make with "Back up now" are never deleted automatically.` : 'Automatic daily backups are turned off on this installation.'),
          h('li', null, h('strong', null, 'Keep your own copy: '), 'once a quarter, click Download on the newest backup and save it on a USB drive kept in the office.')),
        h('dl', { class: 'facts' },
          h('dt', null, 'Database'), h('dd', { class: 'mono small' }, info.dbFile),
          h('dt', null, 'Backup folder'), h('dd', { class: 'mono small' }, b.dir),
          h('dt', null, 'Server'), h('dd', { class: 'small' }, `${info.host}:${info.port} · Node ${info.node} · v${info.version}${info.environment === 'staging' ? ' · TEST SITE' : ''}`)),
        b.files.length ? h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Type'), h('th', null, 'Created'), h('th', { class: 'num' }, 'Size'), h('th', null, 'Check'), h('th'))),
          h('tbody', null, b.files.map((f) => h('tr', null, h('td', { class: 'mono small' }, f.name), h('td', { class: 'small' }, KIND[f.kind] || f.kind), h('td', null, fmt.datetime(f.at)), h('td', { class: 'num' }, `${(f.size / 1024 / 1024).toFixed(2)} MB`),
            h('td', null, f.checked === true ? h('span', { class: 'chip ok' }, 'Checked ✓') : f.checked === false ? h('span', { class: 'chip bad', title: f.problems.join(' ') }, 'Failed') : h('span', { class: 'chip' }, 'Not checked')),
            h('td', { class: 'row-actions' },
              h('button', { class: 'btn small', on: { click: async () => { try { await download(`/api/admin/backups/${encodeURIComponent(f.name)}`); toast('Backup downloaded. Keep it somewhere safe.', 'success'); } catch (err) { showError(err); } } } }, 'Download'),
              h('button', { class: 'btn small ghost', on: { click: () => restoreWith({ serverBackup: f.name }) } }, 'Restore…'))))))
          : h('p', { class: 'muted' }, 'No backups yet.')),
      h('section', { class: 'panel' },
        h('h2', null, 'Restore from a backup file'),
        h('p', { class: 'small' }, 'Use a backup downloaded from here (.db) or an encrypted off-site backup (.vbak). The file is checked first and you see what is in it before anything changes.'),
        h('button', { class: 'btn', on: { click: async () => { const f = await pickRawFile('.db,.vbak'); if (f) restoreWith(null, f); } } }, 'Choose a backup file…'),
        h('p', { class: 'muted small' }, 'Other ways back: Render → your service → Disks → a daily snapshot from the last 7 days → Restore. On a PC with the program stopped: double-click "Restore From Backup.cmd". The full steps are in docs/disaster-recovery.md.')));
  }

  // ---------- activity ----------
  async function activity() {
    const rows = await get('/api/audit');
    return h('section', { class: 'panel' }, h('h2', null, 'Activity log'), h('p', { class: 'muted small' }, 'Sign-ins, price book changes, job saves, quotes and settings changes. Most recent first.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Record'), h('th', null, 'Detail'))),
        h('tbody', null, rows.map((r) => h('tr', null, h('td', { class: 'small nowrap' }, fmt.datetime(r.at)), h('td', null, r.user_name || '—'), h('td', null, r.action.replace(/_/g, ' ')),
          h('td', { class: 'small' }, r.entity === 'job' ? h('a', { href: `#/jobs/${r.entity_id}` }, `job ${r.entity_id}`) : r.entity === 'price_book' ? h('a', { href: `#/price-books/${r.entity_id}` }, `price book ${r.entity_id}`) : r.entity),
          h('td', { class: `small muted ${r.action === 'apply_new_prices' ? '' : 'clamp'}` }, describeAudit(r))))))));
  }
  // Readable detail for publishing with chosen jobs; other entries as before.
  function describeAudit(r) {
    const d = r.detail;
    if (!d) return '';
    if (r.action === 'apply_new_prices') return `"${d.label}" effective ${fmt.date(d.effectiveFrom)}. Updated: ${d.applied.length ? d.applied.join(', ') : 'none'}. Kept existing prices: ${d.kept.length ? d.kept.join(', ') : 'none'}.`;
    if (r.action === 'job_reopened') return `${d.fromLabel || d.from} → ${d.toLabel || d.to}. Reason: ${d.reason}`;
    if (r.action === 'restore') return `Restored from ${d.source} by ${d.by}${d.safetyCopy ? `; safety copy ${d.safetyCopy}` : ''}`;
    if (Array.isArray(d.changes)) {
      const shown = d.changes.filter((c) => c.field).slice(0, 4).map((c) => `${c.area ? `${c.area} › ` : ''}${c.item ? `${c.item} › ` : ''}${c.field}: ${String(c.from ?? '').slice(0, 30)} → ${String(c.to ?? '').slice(0, 30)}`);
      const added = d.changes.filter((c) => c.action).length;
      return `${d.name ? `${d.name}: ` : ''}${d.changes.length} change${d.changes.length === 1 ? '' : 's'}${shown.length ? ` – ${shown.join('; ')}` : ''}${added ? ` (${added} added/deleted)` : ''}`;
    }
    return JSON.stringify(d).slice(0, 140);
  }

  await render();
  app.setStatus('');
  return {
    title: () => 'Settings',
    isDirty: () => dirty,
    save: async () => (companySave ? companySave() : true),
    handlesHash: (hash) => !dirty && /^#\/settings(\/\w+)?$/.test(hash),
    onHash: (hash) => { const m = hash.match(/^#\/settings\/(\w+)$/); section = m && allowed.some(([k]) => k === m[1]) ? m[1] : 'company'; dirty = false; app.updateTitle(); render(); },
    commands: { 'file.save': { label: 'Save settings', run: () => companySave && companySave(), when: () => section === 'company' } },
  };
}
