// Price book versions list.
import { get, post, del, download, pickFile } from '../api.js';
import { h, clear, fill, fmt, formDialog, confirmDialog, toast, showError, popupMenu } from '../ui.js';

const STATUS = { draft: ['Draft', 'warn'], published: ['Published', 'ok'], archived: ['Archived', ''] };

export async function mount(el, _params, app) {
  async function render() {
    const { books, currentId } = await get('/api/price-books');
    fill(el, 
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Price book'), h('p', { class: 'muted' }, 'Each version is a complete price list. Published versions are locked; jobs keep the version they were priced with.')),
        app.isManager() ? h('div', { class: 'actions' },
          h('button', { class: 'btn', on: { click: () => importBook(app) } }, 'Import file…'),
          currentId ? h('button', { class: 'btn primary', on: { click: () => newDraft(app, currentId) } }, '+ New draft from current') : null) : null),
      app.isManager() ? null : h('div', { class: 'banner' }, 'You can view prices. Owners and admins can change them.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table clickable' },
        h('thead', null, h('tr', null, h('th', null, 'Version'), h('th', null, 'Status'), h('th', null, 'Effective'), h('th', null, 'Published'), h('th', { class: 'num' }, 'Jobs using'), h('th', null, 'Last change'), h('th'))),
        h('tbody', null, books.map((b) => h('tr', { on: { click: (e) => { if (!e.target.closest('button')) app.navigate(`#/price-books/${b.id}`); } } },
          h('td', null, h('a', { href: `#/price-books/${b.id}`, class: 'strong' }, b.label), b.id === currentId ? h('span', { class: 'chip ok small' }, 'Current') : null, b.note ? h('div', { class: 'muted small clamp' }, b.note) : null),
          h('td', null, h('span', { class: `chip ${STATUS[b.status][1]}` }, STATUS[b.status][0])),
          h('td', null, fmt.date(b.effective_from)),
          h('td', null, b.published_at ? `${fmt.date(b.published_at)} · ${b.published_by_name || ''}` : '—'),
          h('td', { class: 'num' }, String(b.job_count)),
          h('td', null, fmt.ago(b.updated_at)),
          h('td', null, app.isManager() ? h('button', { class: 'icon-btn', 'aria-label': 'Version actions', on: { click: (e) => popupMenu(e.currentTarget, [
            { label: 'Open', onClick: () => app.navigate(`#/price-books/${b.id}`) },
            { label: 'Save As new draft…', onClick: () => newDraft(app, b.id) },
            { label: 'Export file', onClick: () => download(`/api/price-books/${b.id}/export`).then((n) => toast(`Exported ${n}`, 'success')).catch(showError) },
            '-',
            b.status === 'published' && b.id !== currentId ? { label: 'Archive', onClick: () => archive(b) } : null,
            b.status === 'draft' ? { label: 'Delete draft', danger: true, onClick: () => remove(b) } : null,
          ].filter(Boolean)) } }, '⋯') : null)))))));
  }

  async function archive(b) {
    if (!(await confirmDialog({ title: 'Archive version', message: `Archive "${b.label}"? Jobs that use it keep their prices.`, confirmLabel: 'Archive' }))) return;
    await post(`/api/price-books/${b.id}/archive`);
    render();
  }
  async function remove(b) {
    if (!(await confirmDialog({ title: 'Delete draft', message: `Delete the draft "${b.label}"? This cannot be undone.`, confirmLabel: 'Delete draft', danger: true }))) return;
    try { await del(`/api/price-books/${b.id}`); toast('Draft deleted.', 'success'); render(); } catch (err) { showError(err); }
  }

  await render();
  app.setStatus('');
  return { title: () => 'Price book' };
}

export async function newDraft(app, fromId, pendingChanges) {
  const v = await formDialog({
    title: 'Save As new draft', submitLabel: 'Create draft',
    intro: 'Copies this version into a new editable draft. Nothing changes for customers until you publish it.',
    fields: [{ name: 'label', label: 'Draft name', required: true, autofocus: true, value: `${new Date().toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })} update` }],
  });
  if (!v) return null;
  const { id } = await post(`/api/price-books/${fromId}/clone`, { label: v.label });
  if (pendingChanges && pendingChanges.length) await post(`/api/price-books/${id}/changes`, { changes: pendingChanges });
  toast('Draft created.', 'success');
  app.navigate(`#/price-books/${id}`);
  return id;
}

export async function importBook(app) {
  const f = await pickFile();
  if (!f) return;
  let data;
  try { data = JSON.parse(f.text); } catch { toast('That file is not a valid price book file.', 'error'); return; }
  try {
    const { id } = await post('/api/price-books/import', data);
    toast('Price book imported as a draft. Review it, then publish.', 'success');
    app.navigate(`#/price-books/${id}`);
  } catch (err) { showError(err); }
}
