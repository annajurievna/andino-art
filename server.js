require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const Database = require('better-sqlite3');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json());
app.get('/booking', (req, res) => res.sendFile(path.join(__dirname, 'booking.html')));
app.use(express.static(path.join(__dirname)));

// ── Uploads directory ──────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

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
try { db.exec("ALTER TABLE bookings ADD COLUMN design TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN design_note TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN design_image TEXT NOT NULL DEFAULT ''"); } catch (e) {}

const insertBooking = db.prepare(`
  INSERT INTO bookings (name, email, whatsapp, slot, size, lang, design, design_note, design_image)
  VALUES (@name, @email, @whatsapp, @slot, @size, @lang, @design, @designNote, @designImage)
`);

// ── Send WhatsApp via Twilio ───────────────────────────────────
async function sendWhatsApp(message, mediaUrl) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const params = {
    from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM,
    to:   'whatsapp:+34698939538',
    body: message
  };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  return client.messages.create(params);
}

// ── POST /api/booking — save + notify ─────────────────────────
app.post('/api/booking', upload.single('designImage'), async (req, res) => {
  const { name, email, whatsapp, slot, size, lang, design, designNote } = req.body;

  const sizeMap = {
    es: { small: 'Pequeño', medium: 'Mediano', large: 'Grande' },
    en: { small: 'Small',   medium: 'Medium',  large: 'Large'  }
  };
  const sizeLabel = (sizeMap[lang] || sizeMap.es)[size] || size;

  const designMap = {
    es: { own: 'Diseño propio', artist: 'Diseño por el artista' },
    en: { own: 'Own design',    artist: 'Artist designs'        }
  };
  const designLabel = (designMap[lang] || designMap.es)[design] || design || '';

  // Build design detail line
  const designDetail = (design === 'artist' && designNote)
    ? (lang === 'en' ? `\n📝 Details: ${designNote}` : `\n📝 Detalles: ${designNote}`)
    : '';

  // Build image URL if file uploaded
  let mediaUrl = null;
  const imageFilename = req.file ? req.file.filename : '';
  if (req.file) {
    const baseUrl = process.env.BASE_URL || '';
    if (baseUrl) {
      mediaUrl = `${baseUrl}/uploads/${req.file.filename}`;
    }
    console.log(`[upload] Image saved → ${req.file.filename}${mediaUrl ? ', URL: ' + mediaUrl : ' (no BASE_URL, image not sent via WA)'}`);
  }

  // 1 — Save to database
  try {
    const result = insertBooking.run({
      name, email, whatsapp, slot, size, lang,
      design: design || '', designNote: designNote || '', designImage: imageFilename
    });
    console.log(`[db] Booking saved → id ${result.lastInsertRowid}`);
  } catch (err) {
    console.error('[db] Insert error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }

  // 2 — WhatsApp message
  const msg = lang === 'en'
    ? `🎨 *New Booking — Andino Art*\n\n👤 Name: ${name}\n📧 Email: ${email}\n📱 WhatsApp: ${whatsapp}\n📅 Slot: ${slot}\n📐 Size: ${sizeLabel}\n✏️ Design: ${designLabel}${designDetail}`
    : `🎨 *Nueva Reserva — Andino Art*\n\n👤 Nombre: ${name}\n📧 Email: ${email}\n📱 WhatsApp: ${whatsapp}\n📅 Horario: ${slot}\n📐 Tamaño: ${sizeLabel}\n✏️ Diseño: ${designLabel}${designDetail}`;

  sendWhatsApp(msg, mediaUrl)
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
