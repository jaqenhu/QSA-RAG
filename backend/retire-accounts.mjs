// Retire only the former account subsystem, after acquiring the service lease.
// Existing knowledge, models, files, indexes and assessment history are untouched.
export function retireAccounts(store) {
  store.transaction(() => {
    store.db.exec(`
      DROP TABLE IF EXISTS auth_sessions;
      DROP TABLE IF EXISTS auth_audit;
      DROP TABLE IF EXISTS auth_login_limits;
      DROP TABLE IF EXISTS auth_users;
      INSERT OR IGNORE INTO schema_migrations VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
  });
}
