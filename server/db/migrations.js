// Ordered schema migrations. Never edit a shipped migration; add a new one.
// Money is stored as REAL dollars rounded to cents (SQLite has no decimal type); the PostgreSQL port uses numeric(12,2).

const pbTables = ['pb_trades', 'pb_finish_groups', 'pb_tiers', 'pb_modules', 'pb_module_labour', 'pb_options', 'pb_materials'];

const lockTriggers = pbTables.map((t) => `
CREATE TRIGGER ${t}_lock_ins BEFORE INSERT ON ${t}
WHEN (SELECT status FROM price_books WHERE id = NEW.price_book_id) IN ('published','archived')
BEGIN SELECT RAISE(ABORT, 'PRICE_BOOK_LOCKED'); END;
CREATE TRIGGER ${t}_lock_upd BEFORE UPDATE ON ${t}
WHEN (SELECT status FROM price_books WHERE id = OLD.price_book_id) IN ('published','archived')
BEGIN SELECT RAISE(ABORT, 'PRICE_BOOK_LOCKED'); END;
CREATE TRIGGER ${t}_lock_del BEFORE DELETE ON ${t}
WHEN (SELECT status FROM price_books WHERE id = OLD.price_book_id) IN ('published','archived')
BEGIN SELECT RAISE(ABORT, 'PRICE_BOOK_LOCKED'); END;`).join('\n');

export const migrations = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT, abn TEXT, address TEXT, phone TEXT, email TEXT, website TEXT,
  job_prefix TEXT NOT NULL DEFAULT 'JOB',
  gst_rate REAL NOT NULL DEFAULT 0.1,
  floor_margin REAL NOT NULL DEFAULT 0.3,
  quote_validity_days INTEGER NOT NULL DEFAULT 30,
  quote_terms TEXT,
  currency TEXT NOT NULL DEFAULT 'AUD',
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','designer')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT
);

CREATE TABLE price_books (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  based_on_id INTEGER REFERENCES price_books(id),
  effective_from TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_by INTEGER REFERENCES users(id),
  published_at TEXT
);

CREATE TABLE pb_trades (
  id INTEGER PRIMARY KEY,
  price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL,
  rate REAL NOT NULL CHECK (rate >= 0),
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (price_book_id, key)
);

CREATE TABLE pb_finish_groups (
  id INTEGER PRIMARY KEY,
  price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (price_book_id, key)
);

CREATE TABLE pb_tiers (
  id INTEGER PRIMARY KEY,
  price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL,
  markup REAL NOT NULL CHECK (markup >= 0),
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (price_book_id, key)
);

CREATE TABLE pb_modules (
  id INTEGER PRIMARY KEY,
  price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL,
  category TEXT NOT NULL,
  uom TEXT NOT NULL CHECK (uom IN ('LM','EA','M2','JOB','HR')),
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (price_book_id, key)
);

CREATE TABLE pb_module_labour (
  price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL, trade_key TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours >= 0),
  PRIMARY KEY (price_book_id, module_key, trade_key)
);

CREATE TABLE pb_options (
  id INTEGER PRIMARY KEY,
  price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  finish_groups TEXT NOT NULL DEFAULT '',
  material REAL NOT NULL DEFAULT 0 CHECK (material >= 0),
  hardware REAL NOT NULL DEFAULT 0 CHECK (hardware >= 0),
  labour_factor REAL NOT NULL DEFAULT 1 CHECK (labour_factor >= 0),
  available INTEGER NOT NULL DEFAULT 1,
  cost_basis TEXT NOT NULL DEFAULT 'component' CHECK (cost_basis IN ('component','legacy','supplier_quote')),
  note TEXT, source TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (price_book_id, module_key, key)
);

CREATE TABLE pb_materials (
  id INTEGER PRIMARY KEY,
  price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  supplier TEXT NOT NULL, product TEXT NOT NULL,
  thickness TEXT, sheet_size TEXT,
  m2_rate REAL, sheet_rate REAL, note TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

${lockTriggers}

CREATE TRIGGER price_books_no_unpublish BEFORE UPDATE OF status ON price_books
WHEN OLD.status IN ('published','archived') AND NEW.status = 'draft'
BEGIN SELECT RAISE(ABORT, 'PRICE_BOOK_LOCKED'); END;

CREATE TRIGGER price_books_no_delete BEFORE DELETE ON price_books
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PRICE_BOOK_LOCKED'); END;

CREATE TABLE area_templates (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, area_type TEXT NOT NULL,
  default_finish TEXT,
  lines_json TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  job_number TEXT NOT NULL,
  name TEXT NOT NULL,
  client_name TEXT, client_email TEXT, client_phone TEXT, site_address TEXT,
  status TEXT NOT NULL DEFAULT 'quoting' CHECK (status IN ('enquiry','quoting','quoted','won','in_production','installing','complete','lost')),
  tier_key TEXT NOT NULL,
  price_book_id INTEGER NOT NULL REFERENCES price_books(id),
  designer_id INTEGER REFERENCES users(id),
  notes TEXT,
  discount_pct REAL NOT NULL DEFAULT 0,
  discount_reason TEXT,
  discount_approved_by INTEGER REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1,
  total_cost REAL NOT NULL DEFAULT 0,
  total_sell REAL NOT NULL DEFAULT 0,
  total_hours REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (company_id, job_number)
);
CREATE INDEX jobs_company_status ON jobs(company_id, status);

CREATE TABLE job_areas (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  area_type TEXT NOT NULL DEFAULT 'other',
  default_finish TEXT,
  optional INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX job_areas_job ON job_areas(job_id);

CREATE TABLE job_lines (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL REFERENCES job_areas(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  option_key TEXT,
  qty REAL NOT NULL DEFAULT 0,
  description TEXT,
  custom_unit_cost REAL, custom_uom TEXT,
  override_type TEXT CHECK (override_type IS NULL OR override_type IN ('unit_sell','markup','line_sell','unit_cost')),
  override_value REAL, override_reason TEXT,
  override_by INTEGER REFERENCES users(id),
  override_approved_by INTEGER REFERENCES users(id),
  sort INTEGER NOT NULL DEFAULT 0,
  snap_unit_cost REAL, snap_unit_sell REAL, snap_line_cost REAL, snap_line_sell REAL,
  snap_json TEXT
);
CREATE INDEX job_lines_area ON job_lines(area_id);
CREATE INDEX job_lines_job ON job_lines(job_id);

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','accepted','superseded','declined')),
  price_book_id INTEGER NOT NULL REFERENCES price_books(id),
  snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  subtotal REAL NOT NULL, gst REAL NOT NULL, total REAL NOT NULL, cost REAL NOT NULL,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (job_id, rev)
);

CREATE TABLE job_costs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  area_id INTEGER REFERENCES job_areas(id) ON DELETE SET NULL,
  cost_code TEXT NOT NULL,
  description TEXT NOT NULL,
  supplier TEXT,
  amount REAL NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0,
  incurred_on TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX job_costs_job ON job_costs(job_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  company_id INTEGER,
  user_id INTEGER,
  entity TEXT NOT NULL, entity_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);
`,
  },
  {
    version: 2,
    name: 'scheduling: staff, leave, event types, job events',
    sql: `
CREATE TABLE staff (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  category TEXT NOT NULL,
  email TEXT, phone TEXT,
  colour TEXT NOT NULL DEFAULT '#2B6653',
  hours_per_day REAL NOT NULL DEFAULT 7.6,
  user_id INTEGER REFERENCES users(id),
  is_placeholder INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX staff_company ON staff(company_id, active);

CREATE TABLE staff_leave (
  id INTEGER PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX staff_leave_dates ON staff_leave(staff_id, start_date);

-- Workflow event types and the rules that decide when a job needs them.
CREATE TABLE event_types (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  staff_category TEXT NOT NULL,
  staff_count INTEGER NOT NULL DEFAULT 1,
  unit TEXT NOT NULL CHECK (unit IN ('minutes','days')),
  duration REAL NOT NULL,
  anchor TEXT NOT NULL,
  offset_days INTEGER NOT NULL DEFAULT 0,
  rule TEXT NOT NULL DEFAULT 'always',
  reminder_minutes INTEGER NOT NULL DEFAULT 1440,
  colour TEXT NOT NULL,
  default_start TEXT NOT NULL DEFAULT '09:00',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, key)
);

-- Times are local business time: 'YYYY-MM-DDTHH:MM' for timed events, 'YYYY-MM-DD' (inclusive) for all-day events.
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','pending','confirmed','completed','cancelled')),
  included INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  location TEXT, notes TEXT,
  reminder_minutes INTEGER,
  reminder_dismissed_at TEXT,
  completed_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL
);
CREATE INDEX job_events_range ON job_events(company_id, start_at, end_at);
CREATE INDEX job_events_job ON job_events(job_id);

CREATE TABLE job_event_staff (
  event_id INTEGER NOT NULL REFERENCES job_events(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  PRIMARY KEY (event_id, staff_id)
);
CREATE INDEX job_event_staff_staff ON job_event_staff(staff_id);
`,
  },
  {
    version: 3,
    name: 'price book options: labour dollars per trade, full-name items',
    // labour_cost: JSON {"FACTORY": 195, "INSTALL": 50, ...} in dollars per unit, used exactly; NULL = module hours x rates (as before).
    // full_name: 1 when the option name is the complete item description (imported spreadsheet rows).
    sql: `
ALTER TABLE pb_options ADD COLUMN labour_cost TEXT;
ALTER TABLE pb_options ADD COLUMN full_name INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 4,
    name: 'quote template fields, provisional-sum areas, configurable job statuses',
    // Additive only: new nullable columns and one new table. Existing rows and prices are not touched.
    // jobs.status keeps the eight core statuses that reports use; status_detail optionally names a company-defined
    // variation of it (job_statuses.key). job_areas.quote_label: NULL = normal area, 'provisional' = provisional sum.
    sql: `
ALTER TABLE jobs ADD COLUMN builder_name TEXT;
ALTER TABLE jobs ADD COLUMN contact_details TEXT;
ALTER TABLE jobs ADD COLUMN quote_basis TEXT;
ALTER TABLE jobs ADD COLUMN status_detail TEXT;
ALTER TABLE job_areas ADD COLUMN quote_label TEXT;
ALTER TABLE companies ADD COLUMN licence_no TEXT;
ALTER TABLE companies ADD COLUMN quote_inclusions TEXT;
ALTER TABLE companies ADD COLUMN quote_logo TEXT;

CREATE TABLE job_statuses (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  base_status TEXT NOT NULL CHECK (base_status IN ('enquiry','quoting','quoted','won','in_production','installing','complete','lost')),
  builtin INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, key)
);
`,
  },
];
