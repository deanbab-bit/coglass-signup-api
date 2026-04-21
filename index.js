require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

const COOLIFY_URL  = 'http://62.210.200.21:8000';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN;
const PROJECT_UUID  = 'iovrelskt1hg9h3evybc4xx0';
const SERVER_UUID   = 'gixpnckiv88uhfw19rwvugpi';

app.use(cors());
app.use(express.json());

// ─── Helpers ───────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
}

function usernameFromEmail(email) {
  return email.trim().toLowerCase();
}

function buildCompose(slug, password, adminUsername) {
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
    image: coglass-app:latest
    container_name: ${slug}-web
    environment:
      NODE_ENV: production
      PORT: "3002"
      DATABASE_URL: "postgres://crmuser:crmpass@db:5432/crmdb"
      DATABASE_SSL: "false"
      DEFAULT_ADMIN_USERNAME: "${adminUsername}"
      DEFAULT_ADMIN_PASSWORD: "${password}"
      DEV_USERNAMES: "deanobab"
      UPLOADS_DIR: "/app/uploads"
      INSTALL_ID_DIR: "/app/config"
      DEFAULT_SMS_SENDER_ID: "${slug}"
      ANTHROPIC_API_KEY: "${process.env.ANTHROPIC_API_KEY || ''}"
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

async function provisionInstance(slug, password, adminUsername) {
  const compose = buildCompose(slug, password, adminUsername);
  const composeB64 = Buffer.from(compose).toString('base64');

  // 1. Create service in Coolify
  const svc = await coolifyFetch('/api/v1/services', 'POST', {
    name: slug,
    project_uuid: PROJECT_UUID,
    environment_name: 'production',
    server_uuid: SERVER_UUID,
    docker_compose_raw: composeB64,
  });

  if (!svc.uuid) throw new Error(`Coolify service creation failed: ${JSON.stringify(svc)}`);

  // 2. Deploy it
  await coolifyFetch(`/api/v1/deploy?uuid=${svc.uuid}`, 'GET');

  return `https://${slug}.coglass.app`;
}

async function sendWelcomeEmail(email, companyName, instanceUrl, plan, adminUsername) {
  await resend.emails.send({
    from: 'Coglass <hello@coglass.app>',
    to: email,
    subject: `Your Coglass account is ready — ${companyName}`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #0D1F2D;">
        <div style="margin-bottom: 32px;">
          <span style="font-size: 18px; font-weight: 300; letter-spacing: 3px; text-transform: uppercase; color: #004A66;">COGLASS</span>
        </div>
        <h1 style="font-size: 26px; font-weight: 700; margin-bottom: 16px;">You're all set, ${companyName}.</h1>
        <p style="font-size: 16px; color: #5C7A8A; line-height: 1.6; margin-bottom: 24px;">
          Your Coglass account is live. You're on a 14-day free trial — no charge until your trial ends.
        </p>

        <div style="background: #F4F8FA; border-radius: 10px; padding: 20px 24px; margin-bottom: 28px; border-left: 4px solid #29ABE2;">
          <p style="margin: 0 0 12px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #004A66;">Your login details</p>
          <p style="margin: 0 0 6px; font-size: 15px; color: #0D1F2D;"><strong>URL:</strong> <a href="${instanceUrl}" style="color: #29ABE2;">${instanceUrl}</a></p>
          <p style="margin: 0 0 6px; font-size: 15px; color: #0D1F2D;"><strong>Username:</strong> ${adminUsername}</p>
          <p style="margin: 0; font-size: 15px; color: #0D1F2D;"><strong>Password:</strong> the password you set when signing up</p>
        </div>

        <a href="${instanceUrl}" style="display: inline-block; background: #29ABE2; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin-bottom: 32px;">
          Open Coglass →
        </a>

        <p style="font-size: 14px; color: #5C7A8A; line-height: 1.6;">
          Bookmark your account URL — it's your team's login page. You can add more users in Settings once you're in.
        </p>
        <hr style="border: none; border-top: 1px solid #D6E8F0; margin: 32px 0;">
        <p style="font-size: 13px; color: #5C7A8A;">
          Questions? Reply to this email or visit <a href="https://coglass.co.uk" style="color: #29ABE2;">coglass.co.uk</a>
        </p>
      </div>
    `,
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/signup', async (req, res) => {
  const { companyName, email, password, plan = 'Professional' } = req.body;

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

  const adminUsername = usernameFromEmail(email);

  try {
    // 1. Provision instance via Coolify API (SMS sender ID set automatically from slug)
    const instanceUrl = await provisionInstance(slug, password, adminUsername);

    // 2. Send welcome email via Resend
    await sendWelcomeEmail(email, companyName, instanceUrl, plan, adminUsername);

    // 3. TODO: Stripe — create customer + 14-day trial subscription
    //    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    //    const customer = await stripe.customers.create({ email, name: companyName });
    //    const subscription = await stripe.subscriptions.create({
    //      customer: customer.id,
    //      items: [{ price: STRIPE_PRICE_IDS[plan] }],
    //      trial_period_days: 14,
    //    });

    return res.json({
      success: true,
      instanceUrl,
      message: `Account created. Welcome email sent to ${email}.`,
    });

  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again or contact support.' });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Coglass signup API running on port ${PORT}`));
