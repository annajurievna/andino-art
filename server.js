require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const Database = require('better-sqlite3');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Database setup ─────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'bookings.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    whatsapp   TEXT NOT NULL,
    slot       TEXT NOT NULL,
    size       TEXT NOT NULL,
    lang       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

const insertBooking = db.prepare(`
  INSERT INTO bookings (name, email, whatsapp, slot, size, lang)
  VALUES (@name, @email, @whatsapp, @slot, @size, @lang)
`);

// ── Send WhatsApp via Twilio ───────────────────────────────────
async function sendWhatsApp(message) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  return client.messages.create({
    from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM,
    to:   'whatsapp:+34692164559',
    body: message
  });
}

// ── POST /api/booking — save + notify ─────────────────────────
app.post('/api/booking', async (req, res) => {
  const { name, email, whatsapp, slot, size, lang } = req.body;

  const sizeMap = {
    es: { small: 'Pequeño (€50–€150)', medium: 'Mediano (€150–€400)', large: 'Grande (€400–€1.000+)' },
    en: { small: 'Small (€50–€150)',   medium: 'Medium (€150–€400)',  large: 'Large (€400–€1,000+)'  }
  };
  const sizeLabel = (sizeMap[lang] || sizeMap.es)[size] || size;

  // 1 — Save to database
  try {
    const result = insertBooking.run({ name, email, whatsapp, slot, size, lang });
    console.log(`[db] Booking saved → id ${result.lastInsertRowid}`);
  } catch (err) {
    console.error('[db] Insert error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }

  // 2 — Send WhatsApp notification (non-blocking: don't fail the request if this errors)
  const msg = lang === 'en'
    ? `🎨 *New Booking — Andino Art*\n\n👤 Name: ${name}\n📧 Email: ${email}\n📱 WhatsApp: ${whatsapp}\n📅 Slot: ${slot}\n📐 Size: ${sizeLabel}`
    : `🎨 *Nueva Reserva — Andino Art*\n\n👤 Nombre: ${name}\n📧 Email: ${email}\n📱 WhatsApp: ${whatsapp}\n📅 Horario: ${slot}\n📐 Tamaño: ${sizeLabel}`;

  sendWhatsApp(msg)
    .then(r  => console.log(`[whatsapp] Sent → SID ${r.sid}`))
    .catch(e => console.error('[whatsapp] Error:', e.message));

  res.json({ ok: true });
});

// ── GET /api/bookings — view all bookings ─────────────────────
app.get('/api/bookings', (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings ORDER BY id DESC').all();
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅  Andino Art running → http://localhost:${PORT}`)
);
