// ============================================================
//  SERVER - App foto evento con QR code
//  Gestisce: pannello admin, eventi, QR code, upload foto
// ============================================================

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');

// ------------------------------------------------------------
// URL BASE: l'indirizzo che viene inserito DENTRO i QR code.
// - Il server rileva da solo l'indirizzo del computer nella
//   rete locale (perfetto per i test con lo smartphone)
// - Quando metti il sito online, imposta la variabile
//   URL_BASE con il tuo dominio (es. https://miosito.it)
// ------------------------------------------------------------
function rilevaIPLocale() {
  const interfacce = os.networkInterfaces();
  for (const nome of Object.keys(interfacce)) {
    for (const interfaccia of interfacce[nome]) {
      if (interfaccia.family === 'IPv4' && !interfaccia.internal) {
        return interfaccia.address;
      }
    }
  }
  return 'localhost';
}

const URL_BASE = process.env.URL_BASE || `http://${rilevaIPLocale()}:3000`;

// Password dell'admin (in produzione: variabile ADMIN_PASSWORD)
const PASSWORD_ADMIN = process.env.ADMIN_PASSWORD || 'admin123';

// ------------------------------------------------------------
// DATABASE (SQLite: un solo file, nessuna installazione)
// ------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || '.';
const db = new Database(path.join(DATA_DIR, 'database.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS eventi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    nome TEXT NOT NULL,
    data_evento TEXT,
    attivo INTEGER DEFAULT 1,
    creato_il TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS foto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_token TEXT NOT NULL,
    filename TEXT NOT NULL,
    invitato TEXT,
    caricata_il TEXT DEFAULT (datetime('now'))
  );
`);

// Cartella dove vengono salvate le foto
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const caricamento = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-questa-frase-segreta!',
  resave: false,
  saveUninitialized: false
}));

// ------------------------------------------------------------
// LOGIN / LOGOUT DELL'ADMIN
// ------------------------------------------------------------
function soloAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ errore: 'Non autorizzato' });
}

app.post('/admin/login', (req, res) => {
  if (req.body.password === PASSWORD_ADMIN) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ errore: 'Password errata' });
});

app.post('/admin/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ------------------------------------------------------------
// API EVENTI (solo admin)
// ------------------------------------------------------------

// Elenco degli eventi, con conteggio foto per ciascuno
app.get('/api/eventi', soloAdmin, (req, res) => {
  const eventi = db.prepare(`
    SELECT e.*, COUNT(f.id) AS num_foto
    FROM eventi e LEFT JOIN foto f ON f.evento_token = e.token
    GROUP BY e.id ORDER BY e.id DESC
  `).all();
  res.json(eventi.map(e => ({ ...e, link: `${URL_BASE}/e/${e.token}` })));
});

// Creazione di un nuovo evento (genera il token univoco)
app.post('/api/eventi', soloAdmin, (req, res) => {
  const nome = (req.body.nome || '').trim();
  if (nome.length < 2) {
    return res.status(400).json({ errore: 'Inserisci un nome valido (almeno 2 caratteri)' });
  }
  const token = crypto.randomBytes(6).toString('base64url'); // es. "Xk29fJ_q"
  db.prepare('INSERT INTO eventi (token, nome, data_evento) VALUES (?, ?, ?)')
    .run(token, nome, req.body.data_evento || null);
  res.json({ ok: true, token });
});

// Apri o chiudi un evento (l'interruttore attivo/inattivo)
app.post('/api/eventi/:id/toggle', soloAdmin, (req, res) => {
  db.prepare('UPDATE eventi SET attivo = 1 - attivo WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Elimina un evento (e le sue foto dal database)
app.delete('/api/eventi/:id', soloAdmin, (req, res) => {
  db.prepare('DELETE FROM foto WHERE evento_token = (SELECT token FROM eventi WHERE id = ?)').run(req.params.id);
  db.prepare('DELETE FROM eventi WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Nome pubblico dell'evento (mostrato nella pagina dell'invitato)
app.get('/api/evento/:token', (req, res) => {
  const ev = db.prepare('SELECT nome FROM eventi WHERE token = ? AND attivo = 1').get(req.params.token);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato o chiuso' });
  res.json({ nome: ev.nome });
});

// ------------------------------------------------------------
// QR CODE (immagine PNG, visibile solo all'admin)
// ------------------------------------------------------------
app.get('/qr/:token', soloAdmin, async (req, res) => {
  const ev = db.prepare('SELECT token FROM eventi WHERE token = ?').get(req.params.token);
  if (!ev) return res.status(404).send('Non trovato');
  const png = await QRCode.toBuffer(`${URL_BASE}/e/${ev.token}`, { width: 600, margin: 2 });
  res.type('image/png').send(png);
});

// ------------------------------------------------------------
// PAGINE WEB
// ------------------------------------------------------------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Questo è il link contenuto nel QR code: /e/TOKEN → pagina invitato
app.get('/e/:token', (req, res) => {
  const ev = db.prepare('SELECT id FROM eventi WHERE token = ? AND attivo = 1').get(req.params.token);
  if (!ev) return res.status(404).sendFile(path.join(__dirname, 'public', 'scaduto.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------------------------------------------
// CARICAMENTO FOTO (dagli invitati)
// ------------------------------------------------------------
app.post('/upload', caricamento.single('foto'), (req, res) => {
  const ev = db.prepare('SELECT token FROM eventi WHERE token = ? AND attivo = 1').get(req.body.token);
  if (!ev) return res.status(403).json({ errore: 'Evento non valido o chiuso' });

  db.prepare('INSERT INTO foto (evento_token, filename, invitato) VALUES (?, ?, ?)')
    .run(ev.token, req.file.filename, (req.body.nome || 'Invitato').slice(0, 50));

  // 👉 Qui puoi invece salvare su MEGA, Google Drive, S3 ecc.
  res.json({ ok: true });
});

// File statici (le pagine HTML dentro /public)
app.use(express.static('public'));

// ------------------------------------------------------------
// AVVIO DEL SERVER
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Server avviato sulla porta ${PORT}`);
  console.log(`   Pannello admin: ${URL_BASE}/admin`);
});