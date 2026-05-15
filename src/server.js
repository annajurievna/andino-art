require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const Database = require('better-sqlite3');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { google } = require('googleapis');

const SHEET_ID = '1c0L1dhGTlKvoRYiQC5azFilTa4sUojVLbqnN4z5H-w8';

const app = express();
const root = path.join(__dirname, '..');

app.use(express.json());
app.get('/booking', (req, res) => res.sendFile(path.join(__dirname, 'booking.html')));
app.use(express.static(path.join(__dirname)));          // serves src/ (HTML)
app.use('/data',    express.static(path.join(root, 'data')));    // serves images
app.use('/uploads', express.static(path.join(root, 'uploads'))); // serves uploads

// ── Uploads directory ──────────────────────────────────────────
const uploadsDir = path.join(root, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Database setup ─────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(root, 'bookings.db');
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

db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_slots (
    slot_key   TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )
`);

// ── Admin auth middleware ──────────────────────────────────────
function adminAuth(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (!pwd || pwd !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ── GET /api/slots/blocked ─────────────────────────────────────
app.get('/api/slots/blocked', (req, res) => {
  const rows = db.prepare('SELECT slot_key FROM blocked_slots').all();
  res.json(rows.map(r => r.slot_key));
});

// ── POST /api/admin/slots/toggle ──────────────────────────────
app.post('/api/admin/slots/toggle', adminAuth, (req, res) => {
  const { slotKey } = req.body;
  if (!slotKey) return res.status(400).json({ ok: false });
  const exists = db.prepare('SELECT 1 FROM blocked_slots WHERE slot_key=?').get(slotKey);
  if (exists) {
    db.prepare('DELETE FROM blocked_slots WHERE slot_key=?').run(slotKey);
    res.json({ ok: true, blocked: false });
  } else {
    db.prepare('INSERT OR IGNORE INTO blocked_slots (slot_key) VALUES (?)').run(slotKey);
    res.json({ ok: true, blocked: true });
  }
});

// ── GET /admin ─────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── Append booking to Google Sheet ────────────────────────────
async function appendToSheet(data) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const imageUrl = data.designImage
      ? `${process.env.BASE_URL || ''}/uploads/${data.designImage}`
      : '';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:I',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toLocaleString('es-ES'),
          data.name, data.email, data.whatsapp,
          data.slot, data.size, data.lang,
          data.design, data.designNote, imageUrl
        ]]
      }
    });
    console.log('[sheets] Row appended');
  } catch (e) {
    console.error('[sheets] Error:', e.message);
  }
}

// ── Send WhatsApp via Twilio ───────────────────────────────────
async function sendWhatsApp(message, mediaUrl) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const params = {
    from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM,
    to:   'whatsapp:' + process.env.WHATSAPP_TO,
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

  // 2 — Append to Google Sheet
  appendToSheet({ name, email, whatsapp, slot, size, lang, design: design || '', designNote: designNote || '', designImage: imageFilename });

  // 3 — WhatsApp message
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
