require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

const COOLIFY_URL    = 'http://62.210.200.21:8000';
const COOLIFY_TOKEN  = process.env.COOLIFY_TOKEN;
const PROJECT_UUID   = 'iovrelskt1hg9h3evybc4xx0';
const SERVER_UUID    = 'gixpnckiv88uhfw19rwvugpi';
const INTERNAL_EMAIL = process.env.INTERNAL_NOTIFY_EMAIL || 'contact@coglass.co.uk';
const REPLY_TO       = process.env.REPLY_TO_EMAIL || 'contact@coglass.co.uk';
const BASE_URL       = process.env.BASE_URL  || 'https://signup-api.coglass.app';
const SITE_URL       = process.env.SITE_URL  || 'https://coglass.co.uk';

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

function buildCompose(slug, smsSenderId, password, adminUsername) {
  // Per-instance secret for the daily Hetzner crons (morning tracking emails +
  // stale-order "Needs attention" sweep). Baked into the compose so it survives
  // every recreate — without it both crons silently skip the instance.
  const cronSecret = crypto.randomBytes(32).toString('hex');
  // Vendor master login, seeded on every instance (hidden from the customer —
  // it has no linked employee so it never appears in their user list).
  const masterUsername = process.env.MASTER_ADMIN_USERNAME || 'deanobab';
  const masterPassword = process.env.MASTER_ADMIN_PASSWORD || 'Blues12332!';
  return `services:
  db:
    image: postgres:16
    container_name: ${slug}-postgres
    environment:
      POSTGRES_DB: crmdb
      POSTGRES_USER: crmuser
      POSTGRES_PASSWORD: crmpass
    volumes:
      - ${slug}_pg_data:/var/lib/postgresql/data
    restart: unless-stopped
    networks:
      - ${slug}-net
  web:
    image: ghcr.io/deanbab-bit/coglass-app:latest
    container_name: ${slug}-web
    environment:
      NODE_ENV: production
      PORT: "3002"
      DATABASE_URL: "postgres://crmuser:crmpass@db:5432/crmdb"
      DATABASE_SSL: "false"
      DEFAULT_ADMIN_USERNAME: "${adminUsername}"
      DEFAULT_ADMIN_PASSWORD: "${password}"
      DEV_USERNAMES: "deanobab"
      MASTER_ADMIN_USERNAME: "${masterUsername}"
      MASTER_ADMIN_PASSWORD: "${masterPassword}"
      CRON_SECRET: "${cronSecret}"
      APP_BASE_URL: "https://${slug}.coglass.app"
      UPLOADS_DIR: "/app/uploads"
      INSTALL_ID_DIR: "/app/config"
      DEFAULT_SMS_SENDER_ID: "${smsSenderId}"
      ANTHROPIC_API_KEY: "${process.env.ANTHROPIC_API_KEY || ''}"
      RESEND_API_KEY: "${process.env.RESEND_API_KEY || ''}"
    volumes:
      - ${slug}_uploads:/app/uploads
      - ${slug}_config:/app/config
    depends_on:
      - db
    restart: unless-stopped
    networks:
      - ${slug}-net
      - coolify
    labels:
      - traefik.enable=true
      - "traefik.http.routers.${slug}.rule=Host(\`${slug}.coglass.app\`)"
      - traefik.http.routers.${slug}.entrypoints=https
      - traefik.http.routers.${slug}.tls.certresolver=letsencrypt
      - traefik.http.services.${slug}.loadbalancer.server.port=3002
      - traefik.docker.network=coolify
networks:
  ${slug}-net:
  coolify:
    external: true
volumes:
  ${slug}_pg_data:
  ${slug}_uploads:
  ${slug}_config:
`;
}

async function coolifyFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${COOLIFY_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${COOLIFY_URL}${path}`, opts);
  return res.json();
}

async function provisionInstance(slug, smsSenderId, password, adminUsername) {
  const compose = buildCompose(slug, smsSenderId, password, adminUsername);
  const composeB64 = Buffer.from(compose).toString('base64');

  const svc = await coolifyFetch('/api/v1/services', 'POST', {
    name: slug,
    project_uuid: PROJECT_UUID,
    environment_name: 'production',
    server_uuid: SERVER_UUID,
    docker_compose_raw: composeB64,
  });

  if (!svc.uuid) throw new Error(`Coolify service creation failed: ${JSON.stringify(svc)}`);
  await coolifyFetch(`/api/v1/deploy?uuid=${svc.uuid}`, 'GET');
  return `https://${slug}.coglass.app`;
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
    const instanceUrl = await provisionInstance(pending.slug, smsSenderId, pending.password, pending.adminUsername);
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
