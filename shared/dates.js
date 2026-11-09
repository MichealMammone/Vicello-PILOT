// Local-date helpers shared by browser and server. Scheduling uses local business time as plain strings:
//   all-day:  'YYYY-MM-DD'          (end date inclusive)
//   timed:    'YYYY-MM-DDTHH:MM'
// Comparisons go through minute numbers (day number × 1440 + minutes), so no time-zone maths is involved.

const pad = (n) => String(n).padStart(2, '0');

export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const nowLocal = () => { const d = new Date(); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
export const isDateTime = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s || '');
export const dateOf = (s) => String(s).slice(0, 10);
export const timeOf = (s) => (String(s).length > 10 ? String(s).slice(11, 16) : null);

export function parseDate(s) {
  const [y, m, d] = dateOf(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const dayNum = (s) => { const [y, m, d] = dateOf(s).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
export const fromDayNum = (n) => { const d = new Date(n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const addDays = (s, n) => fromDayNum(dayNum(s) + n);
export const weekday = (s) => (dayNum(s) + 4) % 7; // 0 = Sunday … 6 = Saturday
export const isWeekend = (s) => { const w = weekday(s); return w === 0 || w === 6; };
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);

export function nextBusinessDay(s) {
  let d = dateOf(s);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}
/** Add n business days (n >= 0). Starting on a weekend first rolls to Monday. */
export function addBusinessDays(s, n) {
  let d = nextBusinessDay(s);
  let left = n;
  while (left > 0) { d = addDays(d, 1); if (!isWeekend(d)) left--; }
  return d;
}
export const weekStart = (s) => addDays(dateOf(s), -((weekday(s) + 6) % 7)); // Monday
export const monthStart = (s) => `${dateOf(s).slice(0, 7)}-01`;

export const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const at = (date, hhmm) => `${dateOf(date)}T${hhmm}`;

/** Absolute minute of a timestamp string ('YYYY-MM-DD' = start of that day). */
export const absMin = (s) => dayNum(s) * 1440 + (timeOf(s) ? toMin(timeOf(s)) : 0);
export function addMinutes(s, mins) {
  const m = absMin(s) + mins;
  return `${fromDayNum(Math.floor(m / 1440))}T${fromMin(((m % 1440) + 1440) % 1440)}`;
}

/** [start, end) in absolute minutes for an event { allDay, start, end }. */
export function span(ev) {
  if (ev.allDay) return [dayNum(ev.start) * 1440, (dayNum(ev.end) + 1) * 1440];
  return [absMin(ev.start), absMin(ev.end)];
}
export const overlaps = (a, b) => { const [a0, a1] = span(a), [b0, b1] = span(b); return a0 < b1 && b0 < a1; };

/** Dates an event touches (inclusive). */
export function eventDates(ev) {
  const out = [];
  const end = ev.allDay ? dateOf(ev.end) : dateOf(addMinutes(ev.end, -1));
  for (let d = dateOf(ev.start); dayNum(d) <= dayNum(end); d = addDays(d, 1)) out.push(d);
  return out.length ? out : [dateOf(ev.start)];
}

/** Hours an event occupies on a given date for a staff member (all-day = full working day). */
export function hoursOnDate(ev, date, workHours = 7.6) {
  if (ev.allDay) return dayNum(date) >= dayNum(ev.start) && dayNum(date) <= dayNum(ev.end) && !isWeekend(date) ? workHours : 0;
  const d0 = dayNum(date) * 1440, d1 = d0 + 1440;
  const [s, e] = span(ev);
  return Math.max(0, Math.min(e, d1) - Math.max(s, d0)) / 60;
}
