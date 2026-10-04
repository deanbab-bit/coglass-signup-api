// Tests for idempotent /internal/provision + /internal/provision/status.
// No network beyond 127.0.0.1: the SSH runner is a stub that simulates the
// instances box (a set of existing slugs + scripted behaviours).
//   node scripts/test-idempotent-provision.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../app');
const { ProvisionStore } = require('../provision-store');
const { escapeHtml, internalAlertHtml, internalAlertSubject, oneLine } = require('../index');
const { saleFromBody } = require('../app');

const SECRET = 'test-secret-value';
let passed = 0;
const quiet = { error() {}, warn() {}, log() {} };

function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signup-api-test-'));
  return path.join(dir, 'provision-store.json');
}

/** A fake box. `existing` = slugs that already have an instance. */
function fakeBox({ existing = [], behaviour = () => null, delayMs = 0 } = {}) {
  const box = { existing: new Set(existing), creates: [], calls: 0 };
  box.run = async (args) => {
    box.calls++;
    const slug = args.split(' ')[0];
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const special = behaviour(slug, box);
    if (special) {
      if (special.throw) {
        const e = new Error(special.throw);
        e.phase = special.phase;
        if (special.buildAnyway) {
          box.existing.add(slug);
          box.creates.push(slug);
        }
        throw e;
      }
      return special;
    }
    if (box.existing.has(slug)) return { code: 3, stdout: `ERR|an instance named '${slug}' already exists\n`, stderr: '' };
    box.existing.add(slug);
    box.creates.push(slug);
    return { code: 0, stdout: `OK|https://${slug}.coglass.app\n`, stderr: '' };
  };
  return box;
}

async function withServer({ box, storePath = tmpStorePath(), limits, onProvisioned }, fn) {
  const store = new ProvisionStore(storePath);
  const provisioned = [];
  const app = createApp({
    store,
    runCommand: box.run,
    getSecret: () => SECRET,
    onProvisioned: onProvisioned || ((i) => provisioned.push(i)),
    limits,
    log: quiet,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = {
    provision(body, { key = body.idempotencyKey, secret = SECRET } = {}) {
      return fetch(`${base}/internal/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-provision-secret': secret, ...(key ? { 'Idempotency-Key': key } : {}) },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    },
    status(key, { secret = SECRET } = {}) {
      return fetch(`${base}/internal/provision/status?key=${encodeURIComponent(key)}`, {
        headers: { 'x-provision-secret': secret },
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    },
    raw(method, p) {
      return fetch(`${base}${p}`, { method, redirect: 'manual' }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    },
  };
  try {
    await fn(api, { store, storePath, provisioned });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

const acme = (key) => ({ companyName: 'Acme Glass', email: 'owner@acme.test', plan: 'growth', idempotencyKey: key });

(async () => {
  await test('replay of a done key returns the same instance and never creates twice', async () => {
    const box = fakeBox();
    await withServer({ box }, async (api, { provisioned }) => {
      const a = await api.provision(acme('prov_cs_aaaa1111'));
      assert.strictEqual(a.status, 200);
      assert.strictEqual(a.body.slug, 'acmeglass');
      const b = await api.provision(acme('prov_cs_aaaa1111'));
      assert.strictEqual(b.status, 200);
      assert.strictEqual(b.body.slug, 'acmeglass');
      assert.strictEqual(b.body.replay, true);
      assert.deepStrictEqual(box.creates, ['acmeglass']);
      assert.strictEqual(box.calls, 1);
      assert.strictEqual(provisioned.length, 1, 'follow-ups run once');
    });
  });

  await test('concurrent requests with the same key → one create, the rest 409 in_progress', async () => {
    const box = fakeBox({ delayMs: 150 });
    await withServer({ box }, async (api) => {
      const results = await Promise.all([1, 2, 3, 4].map(() => api.provision(acme('prov_cs_conc0001'))));
      const ok = results.filter((r) => r.status === 200);
      const busy = results.filter((r) => r.status === 409);
      assert.strictEqual(ok.length, 1);
      assert.strictEqual(busy.length, 3);
      busy.forEach((r) => assert.strictEqual(r.body.state, 'in_progress'));
      assert.deepStrictEqual(box.creates, ['acmeglass']);
      assert.strictEqual(box.calls, 1);
    });
  });

  await test('key can come from the body alone; header and body that differ are refused', async () => {
    const box = fakeBox();
    await withServer({ box }, async (api) => {
      const r = await api.provision(acme('prov_cs_bodyonly'), { key: null });
      assert.strictEqual(r.status, 200);
      const bad = await api.provision(acme('prov_cs_bodyonly'), { key: 'prov_cs_other000' });
      assert.strictEqual(bad.status, 400);
      const none = await api.provision({ companyName: 'X Co', email: 'a@b.test' }, { key: null });
      assert.strictEqual(none.status, 400);
      assert.strictEqual(box.calls, 1);
    });
  });

  await test('status: unknown / in_progress / done / failed / interrupted', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const box = fakeBox({
      behaviour: (slug) => {
        if (slug === 'capco') return { code: 5, stdout: 'ERR|instance cap reached (40/40)\n', stderr: '' };
        if (slug === 'dropco') return { throw: 'Connection reset', phase: 'exec' };
        return null;
      },
    });
    const slowRun = box.run;
    box.run = async (args) => {
      if (args.startsWith('slowco ')) await gate;
      return slowRun(args);
    };
    await withServer({ box }, async (api) => {
      const unknown = await api.status('prov_never_seen_1');
      assert.strictEqual(unknown.status, 200);
      assert.strictEqual(unknown.body.state, 'unknown');
      assert.strictEqual(unknown.body.known, false);

      const slow = api.provision({ companyName: 'Slow Co', email: 's@slow.test', idempotencyKey: 'prov_cs_slow0001' });
      await new Promise((r) => setTimeout(r, 50));
      const running = await api.status('prov_cs_slow0001');
      assert.strictEqual(running.body.state, 'in_progress');
      assert.strictEqual(running.body.slug, 'slowco');
      release();
      assert.strictEqual((await slow).status, 200);
      const done = await api.status('prov_cs_slow0001');
      assert.strictEqual(done.body.state, 'done');
      assert.strictEqual(done.body.slug, 'slowco');
      assert.strictEqual(done.body.instanceUrl, 'https://slowco.coglass.app');

      const cap = await api.provision({ companyName: 'Cap Co', email: 'c@cap.test', idempotencyKey: 'prov_cs_cap00001' });
      assert.strictEqual(cap.status, 422, 'a script refusal is a definite 4xx');
      const failed = await api.status('prov_cs_cap00001');
      assert.strictEqual(failed.body.state, 'failed');
      assert.match(failed.body.error, /instance cap/);

      const drop = await api.provision({ companyName: 'Drop Co', email: 'd@drop.test', idempotencyKey: 'prov_cs_drop0001' });
      assert.strictEqual(drop.status, 502, 'a dropped connection is not definite');
      const interrupted = await api.status('prov_cs_drop0001');
      assert.strictEqual(interrupted.body.state, 'interrupted');

      const noAuth = await api.status('prov_cs_slow0001', { secret: 'wrong' });
      assert.strictEqual(noAuth.status, 401);
    });
  });

  await test('"already exists" after a lost response is done, not failed', async () => {
    // First attempt: the box builds it but the connection drops before we hear back.
    let first = true;
    const box = fakeBox({
      behaviour: () => {
        if (first) {
          first = false;
          return { throw: 'Connection lost', phase: 'exec', buildAnyway: true };
        }
        return null;
      },
    });
    await withServer({ box }, async (api, { provisioned }) => {
      const lost = await api.provision(acme('prov_cs_lost0001'));
      assert.strictEqual(lost.status, 502);
      assert.strictEqual((await api.status('prov_cs_lost0001')).body.state, 'interrupted');
      const retry = await api.provision(acme('prov_cs_lost0001'));
      assert.strictEqual(retry.status, 200);
      assert.strictEqual(retry.body.slug, 'acmeglass', 'same slug, never acmeglass2');
      assert.strictEqual(retry.body.recovered, true);
      assert.deepStrictEqual(box.creates, ['acmeglass']);
      assert.strictEqual((await api.status('prov_cs_lost0001')).body.state, 'done');
      assert.strictEqual(provisioned.length, 1);
    });
  });

  await test('a crash mid-build is recovered as interrupted, and a replay finishes on the same slug', async () => {
    const storePath = tmpStorePath();
    const s1 = new ProvisionStore(storePath);
    s1.put('prov_cs_crash001', { state: 'running', slug: 'acmeglass', companyName: 'Acme Glass', email: 'owner@acme.test', plan: 'growth', sentSlugs: ['acmeglass'], attempts: 1 });
    s1.put('prov_cs_pend0001', { state: 'pending', slug: 'otherco', companyName: 'Other Co', email: 'o@other.test', plan: 'growth' });
    const s2 = new ProvisionStore(storePath);
    assert.strictEqual(s2.recoverAfterRestart(), 2);
    assert.strictEqual(s2.get('prov_cs_crash001').state, 'interrupted');
    assert.strictEqual(s2.get('prov_cs_pend0001').state, 'failed');
    const box = fakeBox({ existing: ['acmeglass'] }); // the box finished it while we were down
    await withServer({ box, storePath }, async (api) => {
      assert.strictEqual((await api.status('prov_cs_crash001')).body.state, 'interrupted');
      const r = await api.provision(acme('prov_cs_crash001'));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.slug, 'acmeglass');
      assert.deepStrictEqual(box.creates, []);
    });
  });

  await test('a different key with the same slug is refused that slug (never handed another key\'s instance)', async () => {
    const box = fakeBox();
    await withServer({ box }, async (api, { store }) => {
      const a = await api.provision(acme('prov_cs_keyA0001'));
      assert.strictEqual(a.body.slug, 'acmeglass');
      // Key B, same company: must NOT be told "done → acmeglass".
      const b = await api.provision({ ...acme('prov_cs_keyB0001'), email: 'second@acme.test' });
      assert.strictEqual(b.status, 200);
      assert.notStrictEqual(b.body.slug, 'acmeglass');
      assert.strictEqual(b.body.slug, 'acmeglass2');
      assert.strictEqual(store.slugOwner('acmeglass'), 'prov_cs_keyA0001');
      assert.deepStrictEqual(box.creates, ['acmeglass', 'acmeglass2']);
    });
  });

  await test('a slug held by another key in flight is refused too (concurrent different keys)', async () => {
    const box = fakeBox({ delayMs: 100 });
    await withServer({ box }, async (api) => {
      const [a, b] = await Promise.all([
        api.provision(acme('prov_cs_parA0001')),
        api.provision({ ...acme('prov_cs_parB0001'), email: 'b@acme.test' }),
      ]);
      assert.deepStrictEqual([a.body.slug, b.body.slug].sort(), ['acmeglass', 'acmeglass2']);
      assert.strictEqual(box.creates.length, 2);
    });
  });

  await test('an instance the store never made ("already exists" on first send) moves to the next name', async () => {
    const box = fakeBox({ existing: ['acmeglass'] });
    await withServer({ box }, async (api, { store }) => {
      const r = await api.provision(acme('prov_cs_forn0001'));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.slug, 'acmeglass2');
      assert.ok(store.isForeign('acmeglass'));
      assert.deepStrictEqual(store.get('prov_cs_forn0001').sentSlugs, ['acmeglass2']);
    });
  });

  await test('every candidate name taken → 409 slug_taken, nothing built', async () => {
    const box = fakeBox({ existing: ['acmeglass', 'acmeglass2', 'acmeglass3', 'acmeglass4', 'acmeglass5'] });
    await withServer({ box }, async (api) => {
      const r = await api.provision(acme('prov_cs_full0001'));
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.state, 'slug_taken');
      assert.strictEqual((await api.status('prov_cs_full0001')).body.state, 'failed');
      assert.deepStrictEqual(box.creates, []);
    });
  });

  await test('a failed (refused) key retries on the same slug and then succeeds', async () => {
    let refuse = true;
    const box = fakeBox({ behaviour: () => (refuse ? { code: 5, stdout: 'ERR|instance cap reached (40/40)\n', stderr: '' } : null) });
    await withServer({ box }, async (api) => {
      assert.strictEqual((await api.provision(acme('prov_cs_retry001'))).status, 422);
      refuse = false;
      const r = await api.provision(acme('prov_cs_retry001'));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.slug, 'acmeglass');
    });
  });

  await test('could not reach the box → 424 failed, slug not marked as sent', async () => {
    const box = fakeBox({ behaviour: () => ({ throw: 'ECONNREFUSED', phase: 'connect' }) });
    await withServer({ box }, async (api, { store }) => {
      const r = await api.provision(acme('prov_cs_conn0001'));
      assert.strictEqual(r.status, 424);
      assert.strictEqual(store.get('prov_cs_conn0001').state, 'failed');
      assert.deepStrictEqual(store.get('prov_cs_conn0001').sentSlugs, []);
    });
  });

  await test('the same key for a different company is refused', async () => {
    const box = fakeBox();
    await withServer({ box }, async (api) => {
      await api.provision(acme('prov_cs_same0001'));
      const r = await api.provision({ companyName: 'Other Glass', email: 'x@other.test', idempotencyKey: 'prov_cs_same0001' });
      assert.strictEqual(r.status, 422);
      assert.strictEqual(box.calls, 1);
    });
  });

  await test('records survive a restart (store reloaded from disk)', async () => {
    const storePath = tmpStorePath();
    const box = fakeBox();
    await withServer({ box, storePath }, async (api) => {
      await api.provision(acme('prov_cs_persist1'));
    });
    await withServer({ box, storePath }, async (api) => {
      const r = await api.provision(acme('prov_cs_persist1'));
      assert.strictEqual(r.body.replay, true);
      assert.strictEqual(box.calls, 1);
    });
    assert.ok(!fs.readdirSync(path.dirname(storePath)).some((f) => f.endsWith('.tmp')), 'no temp files left');
  });

  await test('a corrupt store file is never silently replaced', async () => {
    const storePath = tmpStorePath();
    fs.writeFileSync(storePath, '{not json');
    assert.throws(() => new ProvisionStore(storePath));
    assert.strictEqual(fs.readFileSync(storePath, 'utf8'), '{not json');
    // and the app answers 503, not "unknown"
    const app = createApp({ store: null, storeError: new Error('corrupt'), runCommand: async () => ({}), getSecret: () => SECRET, log: quiet });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/provision/status?key=prov_cs_whatever`, { headers: { 'x-provision-secret': SECRET } });
    assert.strictEqual(r.status, 503);
    await new Promise((r2) => server.close(r2));
  });

  await test('the old public trial routes return 410 Gone', async () => {
    const box = fakeBox();
    await withServer({ box }, async (api) => {
      for (const [m, p] of [['POST', '/signup'], ['GET', '/signup'], ['GET', '/confirm?token=abc'], ['POST', '/confirm']]) {
        const r = await api.raw(m, p);
        assert.strictEqual(r.status, 410, `${m} ${p}`);
        assert.match(r.body.error, /coglass\.co\.uk\/pricing/);
      }
      assert.strictEqual(box.calls, 0);
    });
  });

  await test('internal endpoints are rate limited, and repeated bad secrets lock out the IP', async () => {
    const box = fakeBox();
    await withServer({ box, limits: { badAuthPerIp: 3, statusPerIp: 5 } }, async (api) => {
      for (let i = 0; i < 5; i++) assert.strictEqual((await api.status('prov_cs_rate0001')).status, 200);
      assert.strictEqual((await api.status('prov_cs_rate0001')).status, 429);
    });
    await withServer({ box, limits: { badAuthPerIp: 3 } }, async (api) => {
      for (let i = 0; i < 3; i++) assert.strictEqual((await api.status('prov_cs_rate0001', { secret: 'nope' })).status, 401);
      assert.strictEqual((await api.status('prov_cs_rate0001')).status, 429, 'even the right secret is locked out for a while');
    });
  });

  await test('emails escape user-controlled values', async () => {
    const html = internalAlertHtml({
      companyName: '<script>alert(1)</script> & Co',
      email: 'a"onmouseover="x@evil.test',
      instanceUrl: 'https://x.coglass.app',
      plan: '<b>growth</b>',
      at: 'now',
    });
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>growth'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co'));
    assert.ok(!/href="mailto:[^"]*"onmouseover/.test(html));
    assert.strictEqual(escapeHtml(`'"<>&`), '&#39;&quot;&lt;&gt;&amp;');
    assert.strictEqual(oneLine('Acme\r\nBcc: x@y'), 'Acme Bcc: x@y');
  });

  await test('the team alert says what was actually sold (not "[New Trial]" for everything)', async () => {
    // The live £1 test-plan purchase (glass4me, 2026-10-04) — paid, no trial.
    const testPaid = { trial: false, testPlan: true, amountPence: 100, currency: 'gbp', livemode: true };
    assert.strictEqual(internalAlertSubject({ companyName: 'glass4me', sale: testPaid }), '[TEST] [New Customer] glass4me just signed up');
    assert.strictEqual(internalAlertSubject({ companyName: 'Acme', sale: { trial: true, testPlan: false, livemode: true } }), '[New Trial] Acme just signed up');
    assert.strictEqual(internalAlertSubject({ companyName: 'Acme', sale: { trial: false, testPlan: false, livemode: true } }), '[New Customer] Acme just signed up');
    assert.strictEqual(internalAlertSubject({ companyName: 'Acme', sale: { trial: true, testPlan: false, livemode: false } }), '[TEST] [New Trial] Acme just signed up', 'Stripe test mode is TEST too');
    assert.strictEqual(internalAlertSubject({ companyName: 'Acme', sale: null }), '[New instance] Acme is built', 'an older accounts → no guess');
    const html = internalAlertHtml({ companyName: 'glass4me', email: 'o@g.test', instanceUrl: 'https://glass4me.coglass.app', plan: 'test', sale: testPaid, at: 'now' });
    assert.ok(html.includes('£1.00 GBP / month'), 'amount + currency in the body');
    assert.ok(html.includes('Paid — first payment taken, no free trial'));
    assert.ok(html.includes('Hidden £1 test plan'));
    assert.ok(html.includes('<strong>Plan</strong></td><td style="padding:6px 0">test<'));
    assert.ok(!/New Trial/.test(html));

    // Only well-typed values get through from the request body.
    assert.deepStrictEqual(saleFromBody({ trial: false, testPlan: true, amountPence: 100, currency: 'GBP', livemode: true }), testPaid);
    assert.strictEqual(saleFromBody({ companyName: 'x' }), null);
    assert.deepStrictEqual(saleFromBody({ trial: 'yes', amountPence: '100', currency: '<b>', testPlan: 1 }), null);
  });

  await test('sale details ride from the request to the alert', async () => {
    const box = fakeBox();
    await withServer({ box }, async (api, { provisioned }) => {
      const r = await api.provision({ ...acme('prov_cs_sale0001'), plan: 'test', trial: false, testPlan: true, amountPence: 100, currency: 'gbp', livemode: true });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(provisioned[0].sale, { trial: false, testPlan: true, amountPence: 100, currency: 'gbp', livemode: true });
    });
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
