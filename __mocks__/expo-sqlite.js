const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const files = new Map();
let cipher = true;

exports.openDatabaseAsync = jest.fn(async (name) => {
  if (!files.has(name)) files.set(name, { db: new DatabaseSync(":memory:"), key: null });
  const file = files.get(name);
  let unlocked = false;
  function db() { if (!unlocked) throw new Error("Database not keyed"); return file.db; }
  return {
    async execAsync(sql) {
      const key = /^PRAGMA key = "x'([\da-f]{64})'";?$/i.exec(sql);
      if (!key) return db().exec(sql);
      if (!cipher || (file.key && file.key !== key[1])) throw new Error("Database not keyed");
      file.key = key[1]; unlocked = true;
    },
    async getFirstAsync(sql, ...args) {
      if (sql === "PRAGMA cipher_version") return cipher ? { cipher_version: "test" } : null;
      return db().prepare(sql).get(...args) ?? null;
    },
    async getAllAsync(sql, ...args) { return db().prepare(sql).all(...args); },
    async runAsync(sql, ...args) { return db().prepare(sql).run(...args); },
    async closeAsync() { unlocked = false; },
  };
});
exports.resetSQLite = () => { for (const { db } of files.values()) db.close(); files.clear(); cipher = true; };
exports.disableCipher = () => { cipher = false; };
