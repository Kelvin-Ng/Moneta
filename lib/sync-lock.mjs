import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// A process identity prevents a reused Linux PID from keeping a stale lock alive.
function processIdentity(pid) {
  try {
    const boot=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();
    const stat=readFileSync(`/proc/${pid}/stat`,"utf8");
    const started=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/)[19];
    return `${boot}:${started}`;
  } catch { return null; }
}

function ownerIsAlive(lock) {
  try { process.kill(lock.pid,0); }
  catch(error) { return error.code!=="ESRCH"; }
  const identity=processIdentity(lock.pid);
  return !lock.process_identity||!identity||identity===lock.process_identity;
}

export function createSyncLock(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS plaid_sync_locks (
    plaid_item_id INTEGER PRIMARY KEY REFERENCES plaid_items(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    pid INTEGER NOT NULL,
    process_identity TEXT,
    acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const get=db.prepare("SELECT * FROM plaid_sync_locks WHERE plaid_item_id=?");
  const claim=db.prepare(`INSERT INTO plaid_sync_locks(plaid_item_id,owner,pid,process_identity)
    VALUES(?,?,?,?) ON CONFLICT(plaid_item_id) DO UPDATE SET owner=excluded.owner,
    pid=excluded.pid,process_identity=excluded.process_identity,acquired_at=CURRENT_TIMESTAMP`);
  const release=db.prepare("DELETE FROM plaid_sync_locks WHERE plaid_item_id=? AND owner=?");
  const identity=processIdentity(process.pid);

  return async function withSyncLock(itemId,operation) {
    const owner=randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing=get.get(itemId);
      if(existing&&ownerIsAlive(existing)) {
        const error=new Error("This connection is already being synced by another job.");
        error.code="SYNC_IN_PROGRESS";
        throw error;
      }
      claim.run(itemId,owner,process.pid,identity);
      db.exec("COMMIT");
    } catch(error) { db.exec("ROLLBACK"); throw error; }
    try { return await operation(); }
    finally { release.run(itemId,owner); }
  };
}
