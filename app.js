// The HTTP app, built from injected dependencies so tests can run it with a
// stub SSH runner and a temp store file (index.js wires the real ones).
//
// What is here:
//   POST /internal/provision          build a paid-for instance, idempotently
//   GET  /internal/provision/status   what happened to an idempotency key
//   POST /signup, GET /confirm        retired free-trial flow → 410 Gone
//   GET  /health, GET /probe
//
// The caller is coglass-accounts (provision-jobs.js). Its contract, which the
// status codes below are chosen to fit:
//   200 {slug, instanceUrl}         built (or built earlier for this key)
//   409 {state:'in_progress'}       this key is being built right now — ask later
//   4xx (anything else)             refused BEFORE anything was built; accounts
//                                   backs off and retries, then alerts Dean
//   5xx / no answer                 outcome unknown; accounts asks /status and
//                                   never resends blind
//   status → {state: not_found|in_progress|done|failed, slug}; any other state
//   (we send 'unknown' and 'interrupted') parks the job for a human check.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

/**
 * The sale details accounts sends alongside a build (trial / testPlan /
 * amountPence / currency / livemode). Each is kept only if it has the right
 * type, so nothing odd reaches the alert. Returns null when none were sent.
 */
function saleFromBody(body) {
  const b = body || {};
  const sale = {};
  if (typeof b.trial === 'boolean') sale.trial = b.trial;
  if (typeof b.testPlan === 'boolean') sale.testPlan = b.testPlan;
  if (Number.isInteger(b.amountPence) && b.amountPence >= 0 && b.amountPence < 1e9) sale.amountPence = b.amountPence;
  if (typeof b.currency === 'string' && /^[a-z]{3}$/i.test(b.currency)) sale.currency = b.currency.toLowerCase();
  if (typeof b.livemode === 'boolean') sale.livemode = b.livemode;
  return Object.keys(sale).length ? sale : null;
}

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function toSmsId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 11);
}

function slugCandidates(base) {
  // Same reduction + suffixes accounts' slugBelongsToCompany() accepts.
  return [base, ...[2, 3, 4, 5].map((n) => `${base}${n}`)];
}

const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

/** Sliding-window counter: hit(id) → true while under `max` per `windowMs`. */
function createLimiter({ max, windowMs, now }) {
  const hits = new Map();
  function prune(id, t) {
    const arr = (hits.get(id) || []).filter((x) => x > t - windowMs);
    if (arr.length) hits.set(id, arr);
    else hits.delete(id);
    return arr;
  }
  return {
    blocked(id) {
      return prune(id, now()).length >= max;
    },
    hit(id) {
      const t = now();
      const arr = prune(id, t);
      if (arr.length >= max) return false;
      arr.push(t);
      hits.set(id, arr);
      return true;
    },
    sweep() {
      const t = now();
      for (const id of [...hits.keys()]) prune(id, t);
    },
  };
}

/**
 * @param {object} deps
 * @param {import('./provision-store').ProvisionStore|null} deps.store
 * @param {Error|null} [deps.storeError]   why the store could not be opened
 * @param {(args: string) => Promise<{code:number|null, stdout:string, stderr:string}>} deps.runCommand
 *        Runs the create script's args on the box. Rejects with err.phase:
 *        'connect' (nothing was sent) or 'exec' (sent; the connection dropped).
 * @param {(info: object) => void} [deps.onProvisioned]  fire-and-forget follow-ups
 * @param {() => string|undefined} deps.getSecret
 * @param {() => number} [deps.now]
 * @param {object} [deps.limits]
 */
function createApp({ store, storeError = null, runCommand, onProvisioned = () => {}, getSecret, now = () => Date.now(), limits = {}, log = console }) {
  const app = express();
  // Behind Traefik. Trust ONE hop (not `true`): with `true` req.ip is the
  // left-most X-Forwarded-For entry, which the client writes — anyone could
  // then pose as the accounts box and burn its rate-limit / bad-secret budget.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

  // Defensive limits on the internal endpoints. Generous on purpose: the only
  // legitimate caller is accounts, which already retries with back-off, and a
  // 429 is a 4xx so accounts treats it as "nothing built, try later".
  const badAuth = createLimiter({ max: limits.badAuthPerIp ?? 10, windowMs: 15 * 60 * 1000, now });
  const provisionRate = createLimiter({ max: limits.provisionPerIp ?? 30, windowMs: 10 * 60 * 1000, now });
  const statusRate = createLimiter({ max: limits.statusPerIp ?? 300, windowMs: 10 * 60 * 1000, now });
  const sweeper = setInterval(() => [badAuth, provisionRate, statusRate].forEach((l) => l.sweep()), 10 * 60 * 1000);
  sweeper.unref();

  // Keys being built by THIS process right now. The store's 'running' state
  // says the same durably; this set just makes the check obvious.
  const inFlight = new Set();

  app.use(cors());
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Probe a coglass instance — server-side so there are no CORS issues
  app.get('/probe', async (req, res) => {
    const { host } = req.query;
    if (!host || !String(host).match(/^[a-z0-9-]+\.coglass\.app$/)) {
      return res.status(400).json({ up: false, error: 'Invalid host' });
    }
    try {
      const r = await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return res.json({ up: r.ok || r.status === 307 || r.status === 302 || r.status === 301 });
    } catch {
      return res.json({ up: false });
    }
  });

  // ─── Retired: the public free-trial flow ────────────────────────────────
  // Paid signups go through coglass-accounts (Stripe Checkout → durable job →
  // /internal/provision). The old two-step trial flow was still reachable from
  // the internet with the captcha off, put unescaped company names into emails
  // and redirected to a page that no longer exists. Gone for good.
  const gone = (req, res) =>
    res.status(410).json({
      error: 'Free-trial signup has closed. To start with Coglass, see https://coglass.co.uk/pricing',
      url: 'https://coglass.co.uk/pricing',
    });
  app.post('/signup', gone);
  app.get('/signup', gone);
  app.get('/confirm', gone);
  app.post('/confirm', gone);

  // ─── Internal: auth ─────────────────────────────────────────────────────
  function authorise(req, res) {
    if (badAuth.blocked(req.ip)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
      return false;
    }
    const secret = getSecret();
    if (!secret) {
      res.status(501).json({ error: 'Internal provisioning is not configured.' });
      return false;
    }
    // Constant-time compare over hashes: equal length always, so no throw and
    // no length leak.
    const given = String(req.get('x-provision-secret') || '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (!given || !crypto.timingSafeEqual(a, b)) {
      badAuth.hit(req.ip);
      res.status(401).json({ error: 'Bad provisioning secret.' });
      return false;
    }
    if (!store) {
      log.error('Provision store unavailable:', storeError && storeError.message);
      // 503 = "don't know": accounts will ask /status (also 503) and park the
      // job for a human rather than build blind.
      res.status(503).json({ error: 'The provisioning record store is unavailable.' });
      return false;
    }
    return true;
  }

  function publicRecord(rec) {
    return {
      slug: rec.slug || null,
      instanceUrl: rec.state === 'done' && rec.slug ? `https://${rec.slug}.coglass.app` : null,
      attempts: rec.attempts || 0,
      error: rec.state === 'done' ? null : rec.error || null,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      doneAt: rec.doneAt || null,
    };
  }

  // ─── GET /internal/provision/status?key= ────────────────────────────────
  app.get('/internal/provision/status', (req, res) => {
    if (!authorise(req, res)) return;
    if (!statusRate.hit(req.ip)) return res.status(429).json({ error: 'Too many status requests.' });
    const key = String(req.query.key || '');
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'key is required (8-200 chars of A-Z a-z 0-9 _ . : -).' });
    const rec = store.get(key);
    if (!rec) {
      // Never seen. NOT 'not_found': this store did not exist before this
      // release, so a key accounts sent to the old service would also land
      // here — and 'not_found' would tell accounts to build again, which is
      // exactly how `slug2` happened. 'unknown' parks the job for a human.
      return res.json({ state: 'unknown', known: false, slug: null });
    }
    const state =
      rec.state === 'pending' || rec.state === 'running' ? 'in_progress'
      : rec.state === 'done' ? 'done'
      : rec.state === 'failed' ? 'failed'
      : 'interrupted';
    return res.json({ state, known: true, ...publicRecord(rec) });
  });

  // ─── POST /internal/provision ───────────────────────────────────────────
  app.post('/internal/provision', async (req, res) => {
    if (!authorise(req, res)) return;
    if (!provisionRate.hit(req.ip)) return res.status(429).json({ error: 'Too many provisioning requests.' });

    const headerKey = String(req.get('idempotency-key') || '').trim();
    const bodyKey = String(req.body?.idempotencyKey || '').trim();
    if (headerKey && bodyKey && headerKey !== bodyKey) {
      return res.status(400).json({ error: 'Idempotency-Key header and body idempotencyKey differ.' });
    }
    const key = headerKey || bodyKey;
    if (!KEY_RE.test(key)) {
      return res.status(400).json({ error: 'An Idempotency-Key (8-200 chars of A-Z a-z 0-9 _ . : -) is required.' });
    }

    const companyName = String(req.body?.companyName || '').trim();
    const email = String(req.body?.email || '').trim();
    const plan = String(req.body?.plan || '').trim() || 'paid';
    // What was sold — only used to label the team's alert. Absent from an
    // older accounts service, in which case the alert says so rather than guess.
    const sale = saleFromBody(req.body);
    if (!companyName || !email) return res.status(400).json({ error: 'companyName and email are required.' });
    if (companyName.length > 200 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'companyName or email is not valid.' });
    }
    const base = slugify(companyName);
    if (base.length < 2) {
      return res.status(400).json({ error: 'Company name must contain at least two letters or numbers.' });
    }

    let rec = store.get(key);
    if (rec) {
      if (rec.companyName !== companyName || rec.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(422).json({ error: 'This idempotency key was already used for a different company or email.' });
      }
      if (rec.state === 'done') {
        return res.json({ ok: true, slug: rec.slug, instanceUrl: `https://${rec.slug}.coglass.app`, replay: true });
      }
      if (inFlight.has(key) || rec.state === 'running' || rec.state === 'pending') {
        return res.status(409).json({ state: 'in_progress', slug: rec.slug, error: 'This instance is being built right now.' });
      }
      // failed / interrupted → try again on the SAME slug. If the earlier
      // attempt did build it, the box answers "already exists" and, because
      // this key sent that slug, that counts as done.
    }

    // Claim the key synchronously (no await above this point since the get),
    // so a second request for the same key sees it as in progress.
    inFlight.add(key);
    try {
      if (!rec) {
        const slug = pickSlug(base, key);
        if (!slug) {
          return res.status(409).json({
            state: 'slug_taken',
            error: `Every name for "${companyName}" (${base}, ${base}2 … ${base}5) is already taken. Choose one by hand.`,
          });
        }
        rec = store.put(key, { state: 'pending', slug, companyName, email, plan, sale, error: null });
      }
      return await attempt(key, rec, res);
    } catch (err) {
      log.error('Internal provision error:', err);
      return res.status(500).json({ error: 'Provisioning failed unexpectedly; check /internal/provision/status before retrying.' });
    } finally {
      inFlight.delete(key);
    }
  });

  /** First candidate no other key holds and the box isn't known to have. */
  function pickSlug(base, key, after = null) {
    const list = slugCandidates(base);
    const start = after ? list.indexOf(after) + 1 : 0;
    for (const s of list.slice(start)) {
      const owner = store.slugOwner(s);
      if (owner && owner !== key) continue; // another key's instance — refused to this one
      if (store.isForeign(s)) continue;
      return s;
    }
    return null;
  }

  async function attempt(key, rec, res) {
    const password = crypto.randomBytes(24).toString('base64url');
    for (;;) {
      const slug = rec.slug;
      const sentBefore = rec.sentSlugs.includes(slug);
      // Durable BEFORE the command leaves: from here on we assume this slug
      // may exist until the box says otherwise.
      rec = store.put(key, {
        state: 'running',
        sentSlugs: sentBefore ? rec.sentSlugs : [...rec.sentSlugs, slug],
        attempts: (rec.attempts || 0) + 1,
        lastSentAt: new Date(now()).toISOString(),
        error: null,
      });

      const args = [
        slug,
        Buffer.from(rec.email.trim().toLowerCase()).toString('base64'),
        Buffer.from(password).toString('base64'),
        Buffer.from(rec.companyName).toString('base64'),
      ].join(' ');

      let out;
      try {
        out = await runCommand(args);
      } catch (err) {
        if (err.phase === 'connect') {
          // Never reached the box: nothing was built. Undo the "sent" mark
          // unless an earlier attempt had already sent this slug.
          rec = store.put(key, {
            state: 'failed',
            sentSlugs: sentBefore ? rec.sentSlugs : rec.sentSlugs.filter((s) => s !== slug),
            error: `could not reach the instances box: ${err.message}`,
          });
          return res.status(424).json({ state: 'failed', error: rec.error });
        }
        rec = store.put(key, { state: 'interrupted', error: `connection lost while building: ${err.message}` });
        return res.status(502).json({ state: 'interrupted', slug, error: rec.error });
      }

      const text = `${out.stdout || ''}\n${out.stderr || ''}`;
      const errLine = (text.match(/ERR\|([^\n]*)/) || [])[1];

      if (out.code === 0) return finish(key, rec, res, false);

      if (out.code === 3 || /already exists/i.test(errLine || '')) {
        if (sentBefore) {
          // We sent this slug under this key before and lost the answer:
          // the "already exists" is our own earlier build.
          return finish(key, rec, res, true);
        }
        // An instance this store never made (by hand, or before this store
        // existed). Remember it, and move this key to the next free name.
        store.markForeign(slug);
        const nextSlug = pickSlug(slugify(rec.companyName), key, slug);
        if (!nextSlug) {
          rec = store.put(key, {
            state: 'failed',
            sentSlugs: rec.sentSlugs.filter((s) => s !== slug),
            error: `every name for "${rec.companyName}" is already taken on the box`,
          });
          return res.status(409).json({ state: 'slug_taken', error: rec.error });
        }
        rec = store.put(key, { slug: nextSlug, sentSlugs: rec.sentSlugs.filter((s) => s !== slug) });
        continue;
      }

      if (out.code === null || out.code === undefined) {
        rec = store.put(key, { state: 'interrupted', error: 'the build ended without an exit code' });
        return res.status(502).json({ state: 'interrupted', slug, error: rec.error });
      }

      // The script reported a failure (cap reached, compose failed, secrets
      // missing…). It removes anything half-made, so nothing exists: a definite
      // refusal, which accounts backs off and retries.
      rec = store.put(key, { state: 'failed', error: (errLine || text.trim() || `exit ${out.code}`).slice(0, 500) });
      return res.status(422).json({ state: 'failed', slug, error: rec.error });
    }
  }

  function finish(key, rec, res, recovered) {
    rec = store.put(key, { state: 'done', error: null, doneAt: new Date(now()).toISOString() });
    const instanceUrl = `https://${rec.slug}.coglass.app`;
    // Respond first. Branding + the internal alert are best-effort and can take
    // minutes while the new container starts; accounts must not time out on
    // them and think the build failed.
    res.json({ ok: true, slug: rec.slug, instanceUrl, ...(recovered ? { recovered: true } : {}) });
    try {
      onProvisioned({ key, slug: rec.slug, instanceUrl, companyName: rec.companyName, email: rec.email, plan: rec.plan, sale: rec.sale || null, smsSenderId: toSmsId(rec.companyName), recovered });
    } catch (err) {
      log.error('After-provision step failed (non-fatal):', err.message);
    }
  }

  return app;
}

module.exports = { createApp, slugify, toSmsId, slugCandidates, createLimiter, saleFromBody };
