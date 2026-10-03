require('dotenv').config();
const path = require('path');
const { Resend } = require('resend');
const { Client: SshClient } = require('ssh2');
const { createApp } = require('./app');
const { ProvisionStore } = require('./provision-store');

const INTERNAL_EMAIL = process.env.INTERNAL_NOTIFY_EMAIL || 'contact@coglass.co.uk';

// Where the idempotency records live. MUST be on a persistent volume: if this
// file is lost, the service forgets which paid signups it already built.
const PROVISION_STORE_PATH =
  process.env.PROVISION_STORE_PATH || path.join(__dirname, 'data', 'provision-store.json');

// Instance provisioning — runs the same script the HQ panel already uses, over
// SSH. The old Coolify-API provisioning is gone (Coolify was decommissioned
// 2026-07-08); /opt/hq-create-instance.sh on the instances box does the
// compose/env/Traefik/SSL work itself (CRON_SECRET, master admin, licence,
// shared platform secrets).
const PROVISION_SSH_HOST = process.env.PROVISION_SSH_HOST || '138.201.52.175';
const PROVISION_SSH_USER = process.env.PROVISION_SSH_USER || 'root';
const PROVISION_SSH_KEY  = process.env.PROVISION_SSH_KEY; // private key text (OpenSSH/PEM)
// NOTE: this key's authorized_keys entry on the box MUST be command-restricted
// so it can never run anything except the provisioning script, e.g.:
//   command="/opt/hq-create-instance.sh $SSH_ORIGINAL_COMMAND",no-pty,no-port-forwarding,no-X11-forwarding,no-agent-forwarding ssh-ed25519 AAAA... signup-provision
// That's why we send ONLY the arguments, not the script path itself.

// Vendor master login, seeded on every instance by the provisioning script —
// used here only for one follow-up call after the instance is up (set the
// tenant's branded SMS sender ID).
const MASTER_ADMIN_USERNAME = process.env.MASTER_ADMIN_USERNAME || 'deanobab';
const MASTER_ADMIN_PASSWORD = process.env.MASTER_ADMIN_PASSWORD;

let resendClient = null;
function resend() {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** For a subject line: no line breaks (header injection), bounded length. */
function oneLine(value, max = 120) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

// Runs the create script's arguments on the instances box. Resolves with the
// exit code and output; rejects with err.phase = 'connect' when the command
// never left (nothing ran) or 'exec' when the connection died mid-run.
function runRemoteCommand(args) {
  return new Promise((resolve, reject) => {
    const fail = (phase, err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      e.phase = phase;
      reject(e);
    };
    if (!PROVISION_SSH_KEY) return fail('connect', new Error('PROVISION_SSH_KEY is not set'));
    const conn = new SshClient();
    let execStarted = false;
    let settled = false;
    conn
      .on('ready', () => {
        conn.exec(args, (err, stream) => {
          if (err) {
            settled = true;
            conn.end();
            return fail('connect', err);
          }
          execStarted = true;
          let stdout = '';
          let stderr = '';
          stream
            .on('close', (code) => {
              settled = true;
              conn.end();
              resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
            })
            .on('data', (d) => {
              stdout += d;
            })
            .stderr.on('data', (d) => {
              stderr += d;
            });
        });
      })
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        fail(execStarted ? 'exec' : 'connect', err);
      })
      .on('close', () => {
        // Connection closed without the command's stream reporting an end.
        if (settled) return;
        settled = true;
        fail(execStarted ? 'exec' : 'connect', new Error('SSH connection closed'));
      })
      .connect({
        host: PROVISION_SSH_HOST,
        username: PROVISION_SSH_USER,
        privateKey: PROVISION_SSH_KEY,
        readyTimeout: 20000,
      });
  });
}

// Best-effort: log in as the seeded master admin and set the tenant's SMS
// sender ID from their company name. Retries because a fresh container + its
// SSL cert take a little while to come up. Never fatal.
async function seedSmsBranding(instanceUrl, smsSenderId) {
  if (!MASTER_ADMIN_PASSWORD) return;
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const loginRes = await fetch(`${instanceUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: MASTER_ADMIN_USERNAME, password: MASTER_ADMIN_PASSWORD }),
        signal: AbortSignal.timeout(10000),
      });
      if (!loginRes.ok) throw new Error(`login returned ${loginRes.status}`);
      const { token } = await loginRes.json();

      const settingsRes = await fetch(`${instanceUrl}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sms: { senderId: smsSenderId } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!settingsRes.ok) throw new Error(`settings PATCH returned ${settingsRes.status}`);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error('SMS branding seed failed (non-fatal):', err.message);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function internalAlertHtml({ companyName, email, instanceUrl, plan, at, recovered }) {
  const e = escapeHtml;
  return `
      <div style="font-family:sans-serif;max-width:560px;color:#0D1F2D">
        <h2 style="color:#0096C7;margin-bottom:4px">New paid instance built</h2>
        <p style="color:#5C7A8A;margin-top:0">${e(at)}${recovered ? ' (recovered after a lost response)' : ''}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          <tr><td style="padding:6px 0;color:#555;width:130px"><strong>Company</strong></td><td style="padding:6px 0">${e(companyName)}</td></tr>
          <tr><td style="padding:6px 0;color:#555"><strong>Email</strong></td><td style="padding:6px 0"><a href="mailto:${e(encodeURIComponent(email))}">${e(email)}</a></td></tr>
          <tr><td style="padding:6px 0;color:#555"><strong>Plan</strong></td><td style="padding:6px 0">${e(plan)}</td></tr>
          <tr><td style="padding:6px 0;color:#555"><strong>Instance</strong></td><td style="padding:6px 0"><a href="${e(instanceUrl)}">${e(instanceUrl)}</a></td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">Sent automatically by the Coglass signup API.</p>
      </div>
    `;
}

async function sendInternalAlert(info) {
  await resend().emails.send({
    from: 'Coglass Signups <hello@coglass.app>',
    reply_to: oneLine(info.email, 254),
    to: INTERNAL_EMAIL,
    subject: `[New instance] ${oneLine(info.companyName)} is built`,
    html: internalAlertHtml(info),
  });
}

function onProvisioned(info) {
  // Runs once per key, when it first reaches 'done' (a replay of a done key
  // returns early and never gets here). A recovered "already exists" is still
  // the first time we KNOW it is built, so it alerts too, and says so.
  (async () => {
    await seedSmsBranding(info.instanceUrl, info.smsSenderId);
  })().catch((e) => console.error('SMS branding failed:', e.message));
  sendInternalAlert({ ...info, at: new Date().toUTCString() }).catch((e) =>
    console.error('Internal alert failed:', e.message)
  );
}

function openStore() {
  try {
    const store = new ProvisionStore(PROVISION_STORE_PATH);
    const recovered = store.recoverAfterRestart();
    if (recovered) console.warn(`[provision] ${recovered} record(s) were mid-build at the last shutdown — marked for checking`);
    console.log(`[provision] store: ${PROVISION_STORE_PATH}`);
    return { store, storeError: null };
  } catch (err) {
    console.error(`[provision] CANNOT open the provision store at ${PROVISION_STORE_PATH}: ${err.message}`);
    console.error('[provision] /internal/provision will answer 503 until this is fixed.');
    return { store: null, storeError: err };
  }
}

if (require.main === module) {
  const { store, storeError } = openStore();
  const app = createApp({
    store,
    storeError,
    runCommand: runRemoteCommand,
    onProvisioned,
    getSecret: () => process.env.INTERNAL_PROVISION_SECRET,
  });
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Coglass signup API running on port ${PORT}`));
}

module.exports = { escapeHtml, oneLine, internalAlertHtml };
