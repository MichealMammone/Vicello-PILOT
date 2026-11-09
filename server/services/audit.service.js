export function audit(db, { companyId, userId, entity, entityId, action, detail }) {
  db.run(
    'INSERT INTO audit_log (company_id, user_id, entity, entity_id, action, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    companyId ?? null, userId ?? null, entity, entityId == null ? null : String(entityId), action,
    detail == null ? null : JSON.stringify(detail), new Date().toISOString(),
  );
}

export function listAudit(db, companyId, { entity, entityId, limit = 100 } = {}) {
  const rows = entity
    ? db.all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
              WHERE a.company_id = ? AND a.entity = ? AND a.entity_id = ? ORDER BY a.id DESC LIMIT ?`, companyId, entity, String(entityId), limit)
    : db.all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
              WHERE a.company_id = ? ORDER BY a.id DESC LIMIT ?`, companyId, limit);
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
