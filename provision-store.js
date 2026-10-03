// Durable record of every provisioning request, keyed by the caller's
// idempotency key. One small JSON file, rewritten atomically (write a temp
// file, fsync, rename) on every change, so a crash or a container restart
// leaves either the old file or the new one — never half of each.
//
// Writes are synchronous on purpose. Node runs one JS thread, so a
// read-modify-write done without an `await` in the middle can't interleave
// with another request's — that is the whole concurrency story, and it is why
// a record is marked 'running' and saved BEFORE the SSH command leaves.
//
// Record shape (per key):
//   { key, state, slug, companyName, email, plan,
//     sentSlugs: [],      slugs a create was actually SENT for under this key
//     attempts, error, createdAt, updatedAt, lastSentAt, doneAt }
// state: pending | running | done | failed | interrupted
//   interrupted = a create was sent and we never learned how it ended
//   (the connection dropped, or this process died while waiting).
//
// The file also keeps `foreignSlugs`: slugs the box said already exist that no
// key here ever created (instances made by hand or before this store existed),
// so later requests skip them instead of tripping over them again.

const fs = require('fs');
const path = require('path');

const VERSION = 1;

class ProvisionStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.data = { version: VERSION, createdAt: new Date().toISOString(), records: {}, foreignSlugs: [] };
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // First run (or a fresh volume): create the file now, so a misconfigured
      // read-only mount fails loudly at boot instead of on the first paid signup.
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.save();
      return;
    }
    // A corrupt file must NOT be replaced with an empty one: that would forget
    // which keys already built an instance. Throwing makes the caller refuse
    // provisioning until a human looks.
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object') {
      throw new Error(`provision store ${this.filePath} is not a valid store file`);
    }
    this.data = {
      version: parsed.version || VERSION,
      createdAt: parsed.createdAt || new Date().toISOString(),
      records: parsed.records || {},
      foreignSlugs: Array.isArray(parsed.foreignSlugs) ? parsed.foreignSlugs : [],
    };
  }

  save() {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }

  get(key) {
    const r = this.data.records[key];
    return r ? { ...r, sentSlugs: [...(r.sentSlugs || [])] } : null;
  }

  /** Create or update a record and persist it before returning. */
  put(key, fields) {
    const now = new Date().toISOString();
    const prev = this.data.records[key];
    const next = { ...(prev || { key, createdAt: now, sentSlugs: [], attempts: 0 }), ...fields, updatedAt: now };
    this.data.records[key] = next;
    try {
      this.save();
    } catch (err) {
      // Keep memory and disk in step: if the write failed, undo it in memory.
      if (prev) this.data.records[key] = prev;
      else delete this.data.records[key];
      throw err;
    }
    return this.get(key);
  }

  /** The key that holds `slug` (asked for or sent for), or null. */
  slugOwner(slug) {
    for (const r of Object.values(this.data.records)) {
      if (r.slug === slug || (r.sentSlugs || []).includes(slug)) return r.key;
    }
    return null;
  }

  isForeign(slug) {
    return this.data.foreignSlugs.includes(slug);
  }

  markForeign(slug) {
    if (this.isForeign(slug)) return;
    this.data.foreignSlugs.push(slug);
    try {
      this.save();
    } catch (err) {
      this.data.foreignSlugs = this.data.foreignSlugs.filter((s) => s !== slug);
      throw err;
    }
  }

  /**
   * After a restart nothing is in flight in THIS process. A record still
   * 'running' was waiting on the box when the process died, so its outcome is
   * unknown; a 'pending' one never sent anything.
   */
  recoverAfterRestart() {
    let changed = 0;
    for (const r of Object.values(this.data.records)) {
      if (r.state === 'running') {
        r.state = 'interrupted';
        r.error = 'the signup API restarted while this build was running; its outcome is unknown';
        r.updatedAt = new Date().toISOString();
        changed++;
      } else if (r.state === 'pending') {
        r.state = 'failed';
        r.error = 'the signup API restarted before this build was sent; nothing was built';
        r.updatedAt = new Date().toISOString();
        changed++;
      }
    }
    if (changed) this.save();
    return changed;
  }
}

module.exports = { ProvisionStore };
