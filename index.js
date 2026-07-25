require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');
const { Client: SshClient } = require('ssh2');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

const INTERNAL_EMAIL = process.env.INTERNAL_NOTIFY_EMAIL || 'contact@coglass.co.uk';
const REPLY_TO       = process.env.REPLY_TO_EMAIL || 'contact@coglass.co.uk';
const BASE_URL       = process.env.BASE_URL  || 'https://signup-api.coglass.app';
const SITE_URL       = process.env.SITE_URL  || 'https://coglass.co.uk';

// Instance provisioning — runs the same script the HQ panel already uses, over
// SSH. The old Coolify-API provisioning is gone (Coolify was decommissioned
// 2026-07-08); /opt/hq-create-instance.sh on the instances box now does the
// compose/env/Traefik/SSL work itself (including CRON_SECRET, master admin,
// SEED_TRIAL_LICENCE, and sourcing Chatwoot/Unipile/Anthropic secrets from a
// reference instance) — none of that needs to be built here anymore.
const PROVISION_SSH_HOST = process.env.PROVISION_SSH_HOST || '138.201.52.175';
const PROVISION_SSH_USER = process.env.PROVISION_SSH_USER || 'root';
const PROVISION_SSH_KEY  = process.env.PROVISION_SSH_KEY; // private key text (OpenSSH/PEM)
// NOTE: this key's authorized_keys entry on the box MUST be command-restricted
// so it can never run anything except the provisioning script, e.g.:
//   command="/opt/hq-create-instance.sh $SSH_ORIGINAL_COMMAND",no-pty,no-port-forwarding,no-X11-forwarding,no-agent-forwarding ssh-ed25519 AAAA... signup-provision
// That's why we send ONLY the arguments below, not the script path itself —
// the forced command supplies the path, so the key can't be used to run
// anything else even if the private key ever leaked.

// Vendor master login, seeded on every instance by the provisioning script —
// used here only for one follow-up API call after the instance is up (set the
// tenant's branded SMS sender ID), not to seed anything itself.
const MASTER_ADMIN_USERNAME = process.env.MASTER_ADMIN_USERNAME || 'deanobab';
const MASTER_ADMIN_PASSWORD = process.env.MASTER_ADMIN_PASSWORD;

// In-memory pending signups (token → data). Expires after 30 min.
const pendingSignups = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of pendingSignups) {
    if (data.expiresAt < now) pendingSignups.delete(token);
  }
}, 10 * 60 * 1000);

app.use(cors());
app.use(express.json());

// ─── Helpers ───────────────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function toSmsId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 11);
}

function usernameFromEmail(email) {
  return email.trim().toLowerCase();
}

// Runs a single command on the instances box over SSH and resolves with
// stdout, or rejects on a non-zero exit / connection failure.
function runRemoteCommand(command) {
  return new Promise((resolve, reject) => {
    if (!PROVISION_SSH_KEY) return reject(new Error('PROVISION_SSH_KEY is not set'));
    const conn = new SshClient();
    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          let stdout = '';
          let stderr = '';
          stream
            .on('close', (code) => {
              conn.end();
              if (code !== 0) return reject(new Error(`Exit ${code}: ${(stderr || stdout).trim()}`));
              resolve(stdout);
            })
            .on('data', (d) => {
              stdout += d;
            })
            .stderr.on('data', (d) => {
              stderr += d;
            });
        });
      })
      .on('error', reject)
      .connect({
        host: PROVISION_SSH_HOST,
        username: PROVISION_SSH_USER,
        privateKey: PROVISION_SSH_KEY,
        readyTimeout: 20000,
      });
  });
}

// Provisions a brand-new tenant instance by running the same script the HQ
// panel uses (bash /opt/hq-create-instance.sh <slug> <b64 email> <b64 pw>
// <b64 company>) directly on the instances box over SSH.
async function provisionInstance(slug, companyName, adminUsername, password) {
  const emailB64 = Buffer.from(adminUsername).toString('base64');
  const pwB64 = Buffer.from(password).toString('base64');
  const companyB64 = Buffer.from(companyName).toString('base64');

  // Just the args — the authorized_keys forced command on the box supplies
  // the actual script path (see PROVISION_SSH_KEY note above).
  await runRemoteCommand(`${slug} ${emailB64} ${pwB64} ${companyB64}`);

  return `https://${slug}.coglass.app`;
}

// Best-effort: log in as the seeded master admin and set the tenant's SMS
// sender ID from their company name, so outbound SMS is branded from day one
// instead of falling back to a generic default. Retries because a freshly
// provisioned container + its SSL cert can take a little while to come up.
// Non-fatal by design — losing branding is far less bad than failing the
// whole signup over a startup-timing race.
async function seedSmsBranding(instanceUrl, smsSenderId) {
  if (!MASTER_ADMIN_PASSWORD) return; // nothing to log in with — skip quietly
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
      return; // success
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error('SMS branding seed failed (non-fatal):', err.message);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function sendConfirmationEmail(email, companyName, confirmUrl) {
  await resend.emails.send({
    from: 'Coglass <hello@coglass.app>',
    reply_to: REPLY_TO,
    to: email,
    subject: `Confirm your Coglass account — ${companyName}`,
    html: `
      <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;color:#0D1F2D">
        <div style="margin-bottom:32px">
          <span style="font-size:18px;font-weight:300;letter-spacing:3px;text-transform:uppercase;color:#004A66">COGLASS</span>
        </div>
        <h1 style="font-size:24px;font-weight:700;margin-bottom:12px">Confirm your email address</h1>
        <p style="font-size:15px;color:#5C7A8A;line-height:1.6;margin-bottom:28px">
          Hi ${companyName}, thanks for signing up to Coglass. Click below to confirm your email and we'll set up your account straight away.
        </p>
        <a href="${confirmUrl}" style="display:inline-block;background:#29ABE2;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;margin-bottom:28px">
          Confirm email &amp; create account →
        </a>
        <p style="font-size:13px;color:#5C7A8A;line-height:1.6">This link expires in 30 minutes. If you didn't sign up for Coglass, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #D6E8F0;margin:28px 0">
        <p style="font-size:12px;color:#aaa">Or copy this link: <a href="${confirmUrl}" style="color:#29ABE2">${confirmUrl}</a></p>
      </div>
    `,
  });
}

async function sendWelcomeEmail(email, companyName, instanceUrl, adminUsername) {
  await resend.emails.send({
    from: 'Coglass <hello@coglass.app>',
    reply_to: REPLY_TO,
    to: email,
    subject: `Your Coglass account is ready — ${companyName}`,
    html: `
      <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;color:#0D1F2D">
        <div style="margin-bottom:32px">
          <span style="font-size:18px;font-weight:300;letter-spacing:3px;text-transform:uppercase;color:#004A66">COGLASS</span>
        </div>
        <h1 style="font-size:26px;font-weight:700;margin-bottom:16px">You're all set, ${companyName}.</h1>
        <p style="font-size:16px;color:#5C7A8A;line-height:1.6;margin-bottom:24px">
          Your Coglass account is live. You're on a 14-day free trial — no charge until your trial ends.
        </p>
        <div style="background:#F4F8FA;border-radius:10px;padding:20px 24px;margin-bottom:28px;border-left:4px solid #29ABE2">
          <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#004A66">Your login details</p>
          <p style="margin:0 0 6px;font-size:15px"><strong>URL:</strong> <a href="${instanceUrl}" style="color:#29ABE2">${instanceUrl}</a></p>
          <p style="margin:0 0 6px;font-size:15px"><strong>Username:</strong> ${adminUsername}</p>
          <p style="margin:0;font-size:15px"><strong>Password:</strong> the password you chose when signing up</p>
        </div>
        <a href="${instanceUrl}" style="display:inline-block;background:#29ABE2;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;margin-bottom:32px">
          Open Coglass →
        </a>
        <p style="font-size:14px;color:#5C7A8A;line-height:1.6">Bookmark your account URL — it's your team's login page. You can add more users in Settings once you're in.</p>
        <hr style="border:none;border-top:1px solid #D6E8F0;margin:32px 0">
        <p style="font-size:13px;color:#5C7A8A">Questions? Reply to this email or visit <a href="https://coglass.co.uk" style="color:#29ABE2">coglass.co.uk</a></p>
      </div>
    `,
  });
}

async function sendInternalAlert(companyName, email, instanceUrl, plan, signupAt) {
  await resend.emails.send({
    from: 'Coglass Signups <hello@coglass.app>',
    reply_to: email,
    to: INTERNAL_EMAIL,
    subject: `[New Trial] ${companyName} just signed up`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;color:#0D1F2D">
        <h2 style="color:#0096C7;margin-bottom:4px">New Free Trial Started</h2>
        <p style="color:#5C7A8A;margin-top:0">${signupAt}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          <tr><td style="padding:6px 0;color:#555;width:130px"><strong>Company</strong></td><td style="padding:6px 0">${companyName}</td></tr>
          <tr><td style="padding:6px 0;color:#555"><strong>Email</strong></td><td style="padding:6px 0"><a href="mailto:${email}">${email}</a></td></tr>
          <tr><td style="padding:6px 0;color:#555"><strong>Plan interest</strong></td><td style="padding:6px 0">${plan}</td></tr>
          <tr><td style="padding:6px 0;color:#555"><strong>Instance</strong></td><td style="padding:6px 0"><a href="${instanceUrl}">${instanceUrl}</a></td></tr>
          <tr><td style="padding:6px 0;color:#555"><strong>Trial ends</strong></td><td style="padding:6px 0">${new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toDateString()}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">Sent automatically by the Coglass signup API.</p>
      </div>
    `,
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────

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

// Step 1 — validate and send confirmation email
app.post('/signup', async (req, res) => {
  const { companyName, email, password, plan = 'Business' } = req.body;

  if (!companyName || !email || !password) {
    return res.status(400).json({ error: 'Company name, email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const slug = slugify(companyName);
  if (!slug) {
    return res.status(400).json({ error: 'Company name must contain at least one letter or number.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const adminUsername = usernameFromEmail(email);

  pendingSignups.set(token, {
    companyName, email, password, plan, slug, adminUsername,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  try {
    const confirmUrl = `${BASE_URL}/confirm?token=${token}`;
    await sendConfirmationEmail(email, companyName, confirmUrl);
    return res.json({ success: true });
  } catch (err) {
    pendingSignups.delete(token);
    console.error('Confirmation email error:', err);
    return res.status(500).json({ error: 'Could not send confirmation email. Please try again.' });
  }
});

// Step 2 — confirm email, provision instance
app.get('/confirm', async (req, res) => {
  const { token } = req.query;
  const pending = token ? pendingSignups.get(token) : null;

  if (!pending || pending.expiresAt < Date.now()) {
    pendingSignups.delete(token);
    return res.redirect(`${SITE_URL}/signup.html?error=expired`);
  }

  pendingSignups.delete(token); // consume token — prevents double-confirm

  try {
    const smsSenderId = toSmsId(pending.companyName);
    const instanceUrl = await provisionInstance(
      pending.slug,
      pending.companyName,
      pending.adminUsername,
      pending.password
    );
    await seedSmsBranding(instanceUrl, smsSenderId);
    const signupAt = new Date().toUTCString();

    await Promise.all([
      sendWelcomeEmail(pending.email, pending.companyName, instanceUrl, pending.adminUsername),
      sendInternalAlert(pending.companyName, pending.email, instanceUrl, pending.plan, signupAt),
    ]);

    return res.redirect(
      `${SITE_URL}/confirmed.html?url=${encodeURIComponent(instanceUrl)}&company=${encodeURIComponent(pending.companyName)}`
    );
  } catch (err) {
    console.error('Provision error:', err);
    return res.redirect(`${SITE_URL}/signup.html?error=provision`);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Coglass signup API running on port ${PORT}`));
