// Dashboard figures. Plain SQL over jobs/quotes/costs so it ports to PostgreSQL unchanged.
import { round2 } from '../../shared/pricing.js';
import { badRequest } from '../http/http.js';

const WON = ['won', 'in_production', 'installing', 'complete'];
const OPEN = ['enquiry', 'quoting', 'quoted'];
const ACTIVE = ['won', 'in_production', 'installing'];
// Wording shown to people (the stored status "lost" is shown as "Missed").
const STATUS_WORDS = { enquiry: 'enquiry', quoting: 'quoting', quoted: 'quoted', won: 'won', in_production: 'in production', installing: 'installing', complete: 'complete', lost: 'missed' };

/**
 * One record per job with what the drill-downs need: staff member, quote values and the dates it was won or lost.
 * Award/loss dates come from the accepted quote or from the job's status changes in the activity log.
 * Only runs when a drill-down is opened.
 */
function jobFacts(db, companyId) {
  const jobs = db.all(`SELECT j.id, j.job_number, j.name, j.client_name, j.status, j.status_detail, j.total_sell, j.total_cost, j.total_hours, j.notes,
                              j.created_at, j.updated_at, j.designer_id, COALESCE(u.name, 'Unassigned') AS staff
                       FROM jobs j LEFT JOIN users u ON u.id = j.designer_id
                       WHERE j.company_id = ? AND j.archived_at IS NULL`, companyId);
  const quotes = db.all(`SELECT q.job_id, q.rev, q.status, q.subtotal, q.cost, q.created_at, q.accepted_at FROM quotes q JOIN jobs j ON j.id = q.job_id
                         WHERE j.company_id = ? ORDER BY q.job_id, q.rev`, companyId);
  const changes = db.all(`SELECT entity_id, action, detail, at FROM audit_log WHERE company_id = ? AND entity = 'job'
                          AND (action IN ('quote_accepted', 'quote_declined') OR (action = 'save' AND detail LIKE '%→%')) ORDER BY id`, companyId);
  const byJob = new Map(jobs.map((j) => [j.id, { ...j, quotes: [], wonAt: null, lostAt: null }]));
  for (const q of quotes) byJob.get(q.job_id)?.quotes.push(q);
  for (const c of changes) {
    const j = byJob.get(Number(c.entity_id));
    if (!j) continue;
    let to = c.action === 'quote_accepted' ? 'won' : c.action === 'quote_declined' ? 'lost' : null;
    if (!to) { try { to = (/→\s*(\w+)/.exec(JSON.parse(c.detail).status || '') || [])[1]; } catch { to = null; } }
    if (WON.includes(to) && !j.wonAt) j.wonAt = c.at;
    if (to === 'lost') j.lostAt = c.at; // latest time it was marked lost
  }
  return [...byJob.values()].map((j) => {
    const accepted = [...j.quotes].reverse().find((q) => q.status === 'accepted');
    const latest = j.quotes[j.quotes.length - 1];
    const quoteValue = accepted ? accepted.subtotal : latest ? latest.subtotal : null;
    const value = quoteValue ?? j.total_sell;
    const awardDate = WON.includes(j.status) ? (accepted?.accepted_at || j.wonAt || j.updated_at) : null;
    const lostDate = j.status === 'lost' ? (j.lostAt || j.updated_at) : null;
    const declined = j.quotes.filter((q) => q.status === 'declined').map((q) => `R${q.rev}`);
    return {
      id: j.id, jobNumber: j.job_number, name: j.name, client: j.client_name || '', staff: j.staff, designerId: j.designer_id, status: j.status, statusDetail: j.status_detail,
      quoteValue, value, sell: j.total_sell, cost: j.total_cost, marginPct: j.total_sell ? (j.total_sell - j.total_cost) / j.total_sell : null,
      hours: j.total_hours, quotes: j.quotes.length, acceptedQuote: accepted ? `R${accepted.rev}` : null,
      awardDate, lostDate, updatedAt: j.updated_at,
      notes: (j.notes || '').slice(0, 300),
      lossReason: j.status === 'lost' ? [declined.length ? `Quote ${declined.join(', ')} declined` : '', (j.notes || '').slice(0, 300)].filter(Boolean).join(' · ') : '',
    };
  });
}

function inPeriod(iso, period) {
  if (!period || period === 'all') return true;
  if (!iso) return false;
  const d = new Date(iso), now = new Date();
  if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (period === 'year') return d.getFullYear() === now.getFullYear();
  if (period === '12m') return d >= new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  return true;
}

/** Win/loss and staff performance. Rates use jobs decided (won or lost) in the period. */
function performance(db, companyId, facts, period) {
  const quoteRows = db.all(`SELECT q.job_id, q.status, q.created_at, j.designer_id FROM quotes q JOIN jobs j ON j.id = q.job_id
                            WHERE j.company_id = ? AND j.archived_at IS NULL`, companyId).filter((q) => inPeriod(q.created_at, period));
  const stats = (list, quotes) => {
    const won = list.filter((j) => j.awardDate && inPeriod(j.awardDate, period));
    const lost = list.filter((j) => j.lostDate && inPeriod(j.lostDate, period));
    const quotedJobs = new Set(quotes.map((q) => q.job_id));
    const live = quotes.filter((q) => q.status !== 'superseded');
    const accepted = live.filter((q) => q.status === 'accepted').length;
    const decided = won.length + lost.length;
    const wonQuoted = won.filter((j) => j.quotes > 0).length;
    return {
      totalQuotes: quotes.length, jobsQuoted: quotedJobs.size, jobsWon: won.length, jobsLost: lost.length,
      winPct: decided ? won.length / decided : null, lossPct: decided ? lost.length / decided : null,
      conversionPct: quotedJobs.size ? Math.min(1, wonQuoted / quotedJobs.size) : null,
      quoteSuccessPct: live.length ? accepted / live.length : null,
      revenueWon: round2(won.reduce((s, j) => s + (j.value || 0), 0)), revenueLost: round2(lost.reduce((s, j) => s + (j.value || 0), 0)),
      avgWonMarginPct: won.length ? won.reduce((s, j) => s + (j.marginPct || 0), 0) / won.length : null,
    };
  };
  const staff = new Map();
  for (const j of facts) if (!staff.has(j.designerId)) staff.set(j.designerId, j.staff);
  return {
    period, team: stats(facts, quoteRows),
    staff: [...staff.entries()].map(([id, name]) => ({ staffId: id, staff: name, ...stats(facts.filter((j) => j.designerId === id), quoteRows.filter((q) => q.designer_id === id)) }))
      .filter((s) => s.totalQuotes || s.jobsWon || s.jobsLost).sort((a, b) => b.revenueWon - a.revenueWon),
  };
}

/** Records behind one dashboard figure. metric: open | quoted | won | won-month | lost | active | stale | status:<s> | staff:<id> | performance */
export function drillDown(db, companyId, metric, { period = 'all' } = {}) {
  const facts = jobFacts(db, companyId);
  const list = (title, rows, kind = 'jobs') => ({ metric, title, kind, rows: rows.sort((a, b) => String(b.awardDate || b.lostDate || b.updatedAt).localeCompare(String(a.awardDate || a.lostDate || a.updatedAt))) });
  if (metric === 'performance') return { metric, title: 'Win rate and staff performance', kind: 'performance', ...performance(db, companyId, facts, period) };
  if (metric === 'open') return list('Open quotes – enquiry, quoting or quoted', facts.filter((j) => OPEN.includes(j.status)));
  if (metric === 'quoted') return list('Quoted jobs – margin', facts.filter((j) => j.status === 'quoted'));
  if (metric === 'active') return list('Active jobs – won, in production or installing', facts.filter((j) => ACTIVE.includes(j.status)));
  if (metric === 'won') return list('Won jobs', facts.filter((j) => j.awardDate && inPeriod(j.awardDate, period)), 'won');
  if (metric === 'lost') return list('Missed jobs', facts.filter((j) => j.lostDate && inPeriod(j.lostDate, period)), 'lost');
  if (metric === 'won-month') {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const ids = new Set(db.all(`SELECT q.job_id FROM quotes q JOIN jobs j ON j.id = q.job_id WHERE j.company_id = ? AND q.status = 'accepted' AND q.accepted_at >= ?`, companyId, monthStart).map((r) => r.job_id));
    return list('Won this month – quotes accepted this month', facts.filter((j) => ids.has(j.id)), 'won');
  }
  if (metric === 'stale') {
    const book = db.get(`SELECT id FROM price_books WHERE company_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`, companyId);
    const ids = new Set(book ? db.all(`SELECT id FROM jobs WHERE company_id = ? AND archived_at IS NULL AND status IN ('enquiry','quoting','quoted') AND price_book_id <> ?`, companyId, book.id).map((r) => r.id) : []);
    return list('Open jobs on older prices', facts.filter((j) => ids.has(j.id)));
  }
  let m = /^status:(\w+)$/.exec(metric);
  if (m) return list(`Pipeline – ${STATUS_WORDS[m[1]] || m[1]}`, facts.filter((j) => j.status === m[1]), m[1] === 'lost' ? 'lost' : WON.includes(m[1]) ? 'won' : 'jobs');
  m = /^staff:(\d+|none)$/.exec(metric);
  if (m) {
    const id = m[1] === 'none' ? null : Number(m[1]);
    const rows = facts.filter((j) => j.designerId === id && j.status !== 'lost');
    return list(`Pipeline – ${rows[0]?.staff || 'Unassigned'}`, rows);
  }
  throw badRequest('Unknown dashboard figure.');
}

export function dashboard(db, companyId) {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const pipeline = db.all(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total_sell), 0) AS sell, COALESCE(SUM(total_cost), 0) AS cost, COALESCE(SUM(total_hours), 0) AS hours
                           FROM jobs WHERE company_id = ? AND archived_at IS NULL GROUP BY status`, companyId);
  const by = Object.fromEntries(pipeline.map((p) => [p.status, p]));
  const sum = (keys, f) => keys.reduce((s, k) => s + (by[k]?.[f] || 0), 0);
  const openKeys = ['enquiry', 'quoting', 'quoted'];
  const activeKeys = ['won', 'in_production', 'installing'];
  const quotedSell = sum(['quoted'], 'sell'), quotedCost = sum(['quoted'], 'cost');
  const wonMonth = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(q.subtotal), 0) AS sell FROM quotes q JOIN jobs j ON j.id = q.job_id
                           WHERE j.company_id = ? AND q.status = 'accepted' AND q.accepted_at >= ?`, companyId, monthStart);
  const decided = db.get(`SELECT SUM(CASE WHEN status IN ('won','in_production','installing','complete') THEN 1 ELSE 0 END) AS won,
                                 SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS lost FROM jobs WHERE company_id = ? AND archived_at IS NULL`, companyId);
  const recent = db.all(`SELECT j.id, j.job_number, j.name, j.client_name, j.status, j.status_detail, j.total_sell, j.total_cost, j.updated_at, u.name AS updated_by_name
                         FROM jobs j LEFT JOIN users u ON u.id = j.updated_by WHERE j.company_id = ? AND j.archived_at IS NULL ORDER BY j.updated_at DESC LIMIT 8`, companyId);
  const watch = db.all(`SELECT j.id, j.job_number, j.name, j.status, q.cost AS budget, q.subtotal AS sell,
                               (SELECT COALESCE(SUM(amount), 0) FROM job_costs c WHERE c.job_id = j.id) AS actual
                        FROM jobs j JOIN quotes q ON q.job_id = j.id AND q.status = 'accepted'
                        WHERE j.company_id = ? AND j.archived_at IS NULL AND j.status IN ('won','in_production','installing','complete')`, companyId)
    .map((r) => ({ ...r, burn: r.budget ? r.actual / r.budget : 0, marginPct: r.sell ? (r.sell - r.actual) / r.sell : 0 }))
    .sort((a, b) => b.burn - a.burn).slice(0, 8);
  const byDesigner = db.all(`SELECT j.designer_id, COALESCE(u.name, 'Unassigned') AS designer, COUNT(*) AS n, COALESCE(SUM(j.total_sell), 0) AS sell, COALESCE(SUM(j.total_cost), 0) AS cost
                             FROM jobs j LEFT JOIN users u ON u.id = j.designer_id WHERE j.company_id = ? AND j.archived_at IS NULL AND j.status <> 'lost'
                             GROUP BY j.designer_id, u.name ORDER BY sell DESC`, companyId);
  const book = db.get(`SELECT id, label, published_at FROM price_books WHERE company_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`, companyId);
  const drafts = db.get(`SELECT COUNT(*) AS n FROM price_books WHERE company_id = ? AND status = 'draft'`, companyId).n;
  const staleJobs = book ? db.get(`SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND archived_at IS NULL AND status IN ('enquiry','quoting','quoted') AND price_book_id <> ?`, companyId, book.id).n : 0;
  return {
    kpis: {
      openCount: sum(openKeys, 'n'), openSell: round2(sum(openKeys, 'sell')),
      quotedMarginPct: quotedSell ? (quotedSell - quotedCost) / quotedSell : 0,
      wonMonthCount: wonMonth.n, wonMonthSell: round2(wonMonth.sell),
      activeCount: sum(activeKeys, 'n'), activeHours: sum(activeKeys, 'hours'),
      winRate: (decided.won || 0) + (decided.lost || 0) ? (decided.won || 0) / ((decided.won || 0) + (decided.lost || 0)) : null,
    },
    pipeline: ['enquiry', 'quoting', 'quoted', 'won', 'in_production', 'installing', 'complete', 'lost'].map((s) => ({ status: s, n: by[s]?.n || 0, sell: round2(by[s]?.sell || 0) })),
    recent, watch, byDesigner,
    priceBook: { current: book, drafts, staleJobs },
  };
}
