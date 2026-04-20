require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { NodeSSH } = require('node-ssh');
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());

// ─── Helpers ───────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
}

async function provisionInstance(slug, password) {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: process.env.SSH_HOST,
    username: process.env.SSH_USER,
    password: process.env.SSH_PASSWORD,
  });
  const result = await ssh.execCommand(`bash /root/new-instance.sh ${slug} ${password}`);
  ssh.dispose();
  if (result.code !== 0) throw new Error(result.stderr || 'Provisioning failed');
  return `https://${slug}.coglass.app`;
}

async function sendWelcomeEmail(email, companyName, instanceUrl, plan) {
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
        <p style="font-size: 16px; color: #5C7A8A; line-height: 1.6; margin-bottom: 32px;">
          Your Coglass account is live. You're on a 14-day free trial of the <strong>${plan}</strong> plan — no charge until your trial ends.
        </p>
        <a href="${instanceUrl}" style="display: inline-block; background: #29ABE2; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin-bottom: 32px;">
          Open Coglass →
        </a>
        <p style="font-size: 14px; color: #5C7A8A; line-height: 1.6;">
          Your account URL: <a href="${instanceUrl}" style="color: #29ABE2;">${instanceUrl}</a><br>
          Bookmark this — it's your team's login page.
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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Signup
app.post('/signup', async (req, res) => {
  const { companyName, email, password, plan = 'Professional' } = req.body;

  // Basic validation
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

  try {
    // 1. Provision the instance
    const instanceUrl = await provisionInstance(slug, password);

    // 2. Send welcome email
    await sendWelcomeEmail(email, companyName, instanceUrl, plan);

    // 3. TODO: Create Stripe customer + subscription with trial
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
