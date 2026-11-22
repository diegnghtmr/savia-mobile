import { getRandomBytesAsync } from "expo-crypto";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { secureStorage } from "./session-store";

const keySlot = "savia.offline.key.v1";
let loadingKey: Promise<string> | undefined;
function databaseKey() {
  return loadingKey ??= (async () => {
    let key = await secureStorage.getItem(keySlot);
    if (key === null) {
      key = Array.from(await getRandomBytesAsync(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
      await secureStorage.setItem(keySlot, key);
    }
    if (!/^[a-f\d]{64}$/.test(key)) throw new Error("Invalid database key");
    return key;
  })().finally(() => { loadingKey = undefined; });
}

const migrations = [
  `CREATE TABLE membership (principal TEXT PRIMARY KEY, profile TEXT NOT NULL, snapshot TEXT NOT NULL);
   CREATE TABLE cache (principal TEXT NOT NULL, profile TEXT NOT NULL, workspace TEXT NOT NULL,
     path TEXT NOT NULL, payload TEXT NOT NULL, saved_at INTEGER NOT NULL,
     PRIMARY KEY (principal, profile, workspace, path));`,
  `CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, profile TEXT NOT NULL, workspace TEXT NOT NULL,
     path TEXT NOT NULL, body TEXT NOT NULL, slot TEXT NOT NULL, key TEXT NOT NULL, queued_at INTEGER NOT NULL,
     record TEXT, issue TEXT, UNIQUE (principal, profile, workspace, slot));`,
  `ALTER TABLE outbox ADD COLUMN legacy_slot TEXT;
   UPDATE outbox SET legacy_slot = slot;
   CREATE UNIQUE INDEX outbox_legacy ON outbox (principal, profile, workspace, legacy_slot);`,
  `CREATE TABLE offline_sequence (value INTEGER NOT NULL);
   INSERT INTO offline_sequence VALUES (0);
   CREATE TABLE revocations (principal TEXT NOT NULL, profile TEXT NOT NULL, workspace TEXT NOT NULL, sequence INTEGER NOT NULL,
     PRIMARY KEY (principal, profile, workspace));`,
];

export class OfflineStorageUnavailable extends Error {}

export async function atomic<T>(db: SQLiteDatabase, operation: () => Promise<T>) {
  await db.execAsync("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    await db.execAsync("COMMIT");
    return result;
  } catch (error) { await db.execAsync("ROLLBACK"); throw error; }
}

export async function nextOfflineSequence(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ value: number }>("UPDATE offline_sequence SET value = value + 1 RETURNING value");
  if (!row || !Number.isSafeInteger(row.value)) throw new Error("Invalid offline sequence");
  return row.value;
}

export function revokedAfter(db: SQLiteDatabase, principal: string, profile: string, workspace: string, sequence: number) {
  return db.getFirstAsync(`SELECT 1 FROM revocations WHERE principal = ? AND profile = ? AND workspace = ? AND sequence > ?`,
    principal, profile, workspace, sequence);
}

export function offlineMembership(db: SQLiteDatabase, principal: string, profile: string, workspace: string) {
  return db.getFirstAsync<{ active: number | null }>(`SELECT json_extract(snapshot, '$.active.id') = ? AS active
    FROM membership WHERE principal = ? AND profile = ? AND EXISTS (
      SELECT 1 FROM json_each(snapshot, '$.items') WHERE json_extract(value, '$.id') = ?
    )`, workspace, principal, profile, workspace);
}

export function purgeOfflineScope(db: SQLiteDatabase, principal: string, profile: string, workspace: string) {
  return atomic(db, async () => {
    for (const table of ["cache", "outbox"]) await db.runAsync(
      `DELETE FROM ${table} WHERE principal = ? AND profile = ? AND workspace = ?`, principal, profile, workspace);
  });
}

async function open() {
  const db = await openDatabaseAsync("savia-offline.db", { useNewConnection: true })
    .catch(() => { throw new OfflineStorageUnavailable("Encrypted offline storage unavailable"); });
  try {
    if (!(await db.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version"))?.cipher_version) throw new Error("SQLCipher unavailable");
    await db.execAsync(`PRAGMA key = "x'${await databaseKey()}'"`);
    await db.execAsync("PRAGMA secure_delete = ON; PRAGMA temp_store = MEMORY");
    await atomic(db, async () => {
      const version = (await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version"))?.user_version;
      if (version === undefined || version < 0 || version > migrations.length) throw new Error("Unsupported offline schema");
      for (let v = version; v < migrations.length; v++) await db.execAsync(`${migrations[v]} PRAGMA user_version = ${v + 1};`);
    });
    return db;
  } catch { await db.closeAsync().catch(() => {}); throw new OfflineStorageUnavailable("Encrypted offline storage unavailable"); }
}

let serial: Promise<unknown> = Promise.resolve();
export function offlineStore() {
  let connection: Promise<SQLiteDatabase> | undefined;
  return <T>(operation: (db: SQLiteDatabase) => Promise<T>) => {
    const result = serial.then(async () => {
      connection ??= open().catch((error) => { connection = undefined; throw error; });
      return operation(await connection);
    });
    serial = result.catch(() => {});
    return result;
  };
}
