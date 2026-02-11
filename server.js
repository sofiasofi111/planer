const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Configure via environment variables
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;

const SMTP_CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
if(!SMTP_CONFIGURED){
  console.warn('Warning: SMTP credentials are not fully set. Server will run in SIMULATION mode (no real emails sent). To enable real sending set SMTP_HOST, SMTP_USER and SMTP_PASS.');
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465, // true for 465, false for other ports
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  }
});

// Rate limiting and retry queue (in-memory)
const sendAttempts = new Map(); // key: email or ip, value: array of timestamps
const FAILED_QUEUE = []; // items: { email, username, code, attempts }

const MAX_ATTEMPTS = 3; // max sends per window
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RETRY_LIMIT = 3; // retry attempts for failed send

function cleanupAttempts(key) {
  const now = Date.now();
  const arr = sendAttempts.get(key) || [];
  const filtered = arr.filter(t => now - t < WINDOW_MS);
  sendAttempts.set(key, filtered);
  return filtered;
}

function recordAttempt(key) {
  const arr = cleanupAttempts(key);
  arr.push(Date.now());
  sendAttempts.set(key, arr);
}

function canSend(key) {
  const arr = cleanupAttempts(key);
  return arr.length < MAX_ATTEMPTS;
}

async function retrySend(mailOptions) {
  let attempt = 0;
  const delays = [1000, 3000, 7000];
  while (attempt < RETRY_LIMIT) {
    try {
      const info = await transporter.sendMail(mailOptions);
      return { ok: true, info };
    } catch (err) {
      attempt++;
      if (attempt >= RETRY_LIMIT) return { ok: false, err };
      await new Promise(r => setTimeout(r, delays[Math.min(attempt-1, delays.length-1)]));
    }
  }
  return { ok: false };
}

// background worker to retry failed queue
setInterval(async () => {
  if (!SMTP_CONFIGURED) return; // nothing to retry in simulation mode
  if (FAILED_QUEUE.length === 0) return;
  const item = FAILED_QUEUE.shift();
  if (!item) return;
  const { email, username, code, attempts = 0 } = item;
  if (attempts >= RETRY_LIMIT) {
    console.error('Dropping failed send after retries for', email);
    return;
  }
  const mail = {
    from: FROM_EMAIL,
    to: email,
    subject: `Код підтвердження для ${username}`,
    text: `Ваш код підтвердження: ${code}`,
    html: `<p>Привіт, ${username}!</p><p>Ваш код підтвердження: <b>${code}</b></p>`
  };
  try {
    const res = await retrySend(mail);
    if (!res.ok) {
      FAILED_QUEUE.push({ ...item, attempts: attempts + 1 });
    }
  } catch (e) {
    FAILED_QUEUE.push({ ...item, attempts: attempts + 1 });
  }
}, 60 * 1000);

app.post('/send-code', async (req, res) => {
  const { email, username, code } = req.body || {};
  if(!email || !code || !username){
    return res.status(400).json({ ok: false, message: 'Missing email, username or code' });
  }
  // If SMTP is not configured, simulate send: log and return success
  if(!SMTP_CONFIGURED){
    console.log('[SIMULATION] send-code', { email, username, code });
    return res.json({ ok: true, simulated: true });
  }
  // rate limit by email and by IP
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!canSend(email) || !canSend(ip)) {
    return res.status(429).json({ ok: false, message: 'Too many requests. Try later.' });
  }

  recordAttempt(email);
  recordAttempt(ip);

  const mail = {
    from: FROM_EMAIL,
    to: email,
    subject: `Код підтвердження для ${username}`,
    text: `Ваш код підтвердження: ${code}`,
    html: `<p>Привіт, ${username}!</p><p>Ваш код підтвердження: <b>${code}</b></p><p>Якщо це не ви — ігноруйте цей лист.</p>`
  };

  try {
    const result = await retrySend(mail);
    if (result.ok) {
      console.log('Email sent:', result.info && result.info.messageId);
      res.json({ ok: true });
    } else {
      console.error('Send failed, queuing for retry', result.err || 'unknown');
      FAILED_QUEUE.push({ email, username, code, attempts: 0 });
      res.status(202).json({ ok: false, message: 'Queued for retry' });
    }
  } catch (err) {
    console.error('Error sending email', err);
    FAILED_QUEUE.push({ email, username, code, attempts: 0 });
    res.status(202).json({ ok: false, message: 'Queued for retry' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>{
  console.log(`Email server listening on port ${PORT}`);
});
