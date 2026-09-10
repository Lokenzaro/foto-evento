// ============================================================
//  SERVER - App foto evento con QR code — v4
//  Admin + invitati + galleria live + backup/ripristino MEGA
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

function rilevaIPLocale() {
  const interfacce = os.networkInterfaces();
  for (const nome of Object.keys(interfacce)) {
    for (const i of interfacce[nome]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

const URL_BASE = process.env.URL_BASE || `http://${rilevaIPLocale()}:3000`;
const PASSWORD_ADMIN = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_DIR = process.env.DATA_DIR || '.';
const CARTELLA_FOTO = path.join(DATA_DIR, 'uploads');

// ---------- DATABASE ----------
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
try { db.exec("ALTER TABLE eventi ADD COLUMN qualita TEXT DEFAULT 'standard'"); } catch (e) {}

fs.mkdirSync(CARTELLA_FOTO, { recursive: true });
const caricamento = multer({ dest: CARTELLA_FOTO, limits: { fileSize: 20 * 1024 * 1024 } });

// ---------- CONNESSIONE MEGA (opzionale) ----------
let megaStorage = null;
let megaPronto = false;
if (process.env.MEGA_EMAIL && process.env.MEGA_PASSWORD) {
  try {
    const mega = require('megajs');
    megaStorage = new mega.Storage({
      email: process.env.MEGA_EMAIL,
      password: process.env.MEGA_PASSWORD,
      userAgent: 'foto-evento-app'
    }, (err) => {
      if (err) { console.error('☁️ MEGA: accesso fallito:', err.message); megaStorage = null; }
      else { megaPronto = true; console.log("☁️ Backup MEGA collegato all'account"); }
    });
  } catch (e) { console.error('☁️ MEGA non disponibile:', e.message); }
}

function backupMega(percorsoFile, nomeSuMega) {
  if (!megaStorage || !megaPronto) return;
  try {
    const buffer = fs.readFileSync(percorsoFile);
    megaStorage.upload({ name: nomeSuMega, allowUploadBuffering: true }, buffer, (err) => {
      if (err) console.error('☁️ Backup MEGA fallito:', err.message);
    });
  } catch (e) { console.error('☁️ Backup MEGA errore:', e.message); }
}

// ---------- SNAPSHOT DATABASE SU MEGA (con debounce 15 s) ----------
let snapshotTimer = null;
function programmaSnapshot(ritardo = 15000) {
  if (!megaStorage) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(eseguiSnapshot, ritardo);
}

function eseguiSnapshot() {
  if (!megaStorage || !megaPronto) return;
  try {
    const dati = JSON.stringify({
      esportato_il: new Date().toISOString(),
      eventi: db.prepare('SELECT * FROM eventi').all(),
      foto: db.prepare('SELECT * FROM foto').all()
    });
    const nome = `db-snapshot-${Date.now()}.json`;
    megaStorage.upload({ name: nome, allowUploadBuffering: true }, Buffer.from(dati), (err) => {
      if (err) console.error('☁️ Snapshot DB non salvato:', err.message);
      else console.log('☁️ Snapshot database salvato su MEGA');
    });
  } catch (e) { console.error('☁️ Snapshot errore:', e.message); }
}

// ---------- APP ----------
const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-questa-frase-segreta!',
  resave: false,
  saveUninitialized: false
}));

function soloAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ errore: 'Non autorizzato' });
}

app.post('/admin/login', (req, res) => {
  if (req.body.password === PASSWORD_ADMIN) { req.session.admin = true; return res.json({ ok: true }); }
  res.status(401).json({ errore: 'Password errata' });
});
app.post('/admin/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---------- API EVENTI (solo admin) ----------
app.get('/api/eventi', soloAdmin, (req, res) => {
  const eventi = db.prepare(`
    SELECT e.*, COUNT(f.id) AS num_foto
    FROM eventi e LEFT JOIN foto f ON f.evento_token = e.token
    GROUP BY e.id ORDER BY e.id DESC
  `).all();
  res.json(eventi.map(e => ({ ...e, link: `${URL_BASE}/e/${e.token}` })));
});

app.post('/api/eventi', soloAdmin, (req, res) => {
  const nome = (req.body.nome || '').trim();
  const LIVELLI = ['risparmio', 'standard', 'massima'];
  if (nome.length < 2) return res.status(400).json({ errore: 'Inserisci un nome valido' });
  const qualita = LIVELLI.includes(req.body.qualita) ? req.body.qualita : 'standard';
  const token = crypto.randomBytes(6).toString('base64url'); // sempre 8 caratteri
  db.prepare('INSERT INTO eventi (token, nome, data_evento, qualita) VALUES (?, ?, ?, ?)')
    .run(token, nome, req.body.data_evento || null, qualita);
  programmaSnapshot();
  res.json({ ok: true, token });
});

app.post('/api/eventi/:id/qualita', soloAdmin, (req, res) => {
  const LIVELLI = ['risparmio', 'standard', 'massima'];
  if (!LIVELLI.includes(req.body.qualita)) return res.status(400).json({ errore: 'Livello non valido' });
  db.prepare('UPDATE eventi SET qualita = ? WHERE id = ?').run(req.body.qualita, req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

app.post('/api/eventi/:id/toggle', soloAdmin, (req, res) => {
  db.prepare('UPDATE eventi SET attivo = 1 - attivo WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

app.delete('/api/eventi/:id', soloAdmin, (req, res) => {
  const ev = db.prepare('SELECT token FROM eventi WHERE id = ?').get(req.params.id);
  if (ev) {
    const foto = db.prepare('SELECT filename FROM foto WHERE evento_token = ?').all(ev.token);
    for (const f of foto) { try { fs.unlinkSync(path.join(CARTELLA_FOTO, f.filename)); } catch (e) {} }
    if (megaStorage && megaPronto) {
      Object.values(megaStorage.files || {}).forEach(f => {
        if (f.name && !f.isDirectory && f.name.startsWith(ev.token + '_')) {
          try { f.delete(() => {}); } catch (e) {}
        }
      });
    }
    db.prepare('DELETE FROM foto WHERE evento_token = ?').run(ev.token);
    db.prepare('DELETE FROM eventi WHERE id = ?').run(req.params.id);
    programmaSnapshot();
  }
  res.json({ ok: true });
});

// ---------- API PUBBLICHE (sola lettura) ----------
app.get('/api/evento/:token', (req, res) => {
  const ev = db.prepare('SELECT nome, qualita FROM eventi WHERE token = ? AND attivo = 1').get(req.params.token);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato o chiuso' });
  res.json(ev);
});

app.get('/api/foto/:token', (req, res) => {
  const ev = db.prepare('SELECT id FROM eventi WHERE token = ?').get(req.params.token);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato' });
  const foto = db.prepare(
    'SELECT filename, invitato, caricata_il FROM foto WHERE evento_token = ? ORDER BY id DESC'
  ).all(req.params.token);
  res.json(foto.map(f => ({ ...f, url: '/foto/' + f.filename })));
});

app.use('/foto', express.static(CARTELLA_FOTO)); // sola lettura via web

// ---------- QR CODE ----------
app.get('/qr/:token', soloAdmin, async (req, res) => {
  const ev = db.prepare('SELECT token FROM eventi WHERE token = ?').get(req.params.token);
  if (!ev) return res.status(404).send('Non trovato');
  const png = await QRCode.toBuffer(`${URL_BASE}/e/${ev.token}`, { width: 600, margin: 2 });
  res.type('image/png').send(png);
});

// ---------- PAGINE ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/e/:token', (req, res) => {
  const ev = db.prepare('SELECT id FROM eventi WHERE token = ? AND attivo = 1').get(req.params.token);
  if (!ev) return res.status(404).sendFile(path.join(__dirname, 'public', 'scaduto.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/galleria/:token', (req, res) => {
  const ev = db.prepare('SELECT id FROM eventi WHERE token = ?').get(req.params.token);
  if (!ev) return res.status(404).sendFile(path.join(__dirname, 'public', 'scaduto.html'));
  res.sendFile(path.join(__dirname, 'public', 'galleria.html'));
});

// ---------- CARICAMENTO FOTO ----------
app.post('/upload', caricamento.single('foto'), (req, res) => {
  const ev = db.prepare('SELECT token FROM eventi WHERE token = ? AND attivo = 1').get(req.body.token);
  if (!ev) return res.status(403).json({ errore: 'Evento non valido o chiuso' });
  db.prepare('INSERT INTO foto (evento_token, filename, invitato) VALUES (?, ?, ?)')
    .run(ev.token, req.file.filename, (req.body.nome || 'Invitato').slice(0, 50));
  backupMega(req.file.path, `${ev.token}_${req.file.filename}.jpg`);
  programmaSnapshot();
  res.json({ ok: true });
});

// ---------- RIPRISTINO DAL BACKUP MEGA ----------
const ripristino = { in_corso: false, messaggio: 'Mai avviato', eventi: 0, foto: 0, errori: 0, totale: 0 };

app.post('/admin/ripristino', soloAdmin, (req, res) => {
  if (!megaStorage || !megaPronto) {
    return res.status(400).json({ errore: 'MEGA non configurato: servono MEGA_EMAIL e MEGA_PASSWORD' });
  }
  if (ripristino.in_corso) return res.json({ ok: true });
  ripristino.in_corso = true;
  ripristino.eventi = 0; ripristino.foto = 0; ripristino.errori = 0; ripristino.totale = 0;
  ripristino.messaggio = 'Avvio: lettura dei file da MEGA…';
  eseguiRipristino();
  res.json({ ok: true });
});

app.get('/admin/stato-ripristino', soloAdmin, (req, res) => res.json(ripristino));

function eseguiRipristino() {
  try {
    const tutti = Object.values(megaStorage.files || {}).filter(f => !f.isDirectory && f.name);
    const snapshots = tutti
      .filter(f => f.name.startsWith('db-snapshot-') && f.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name)); // il più recente è l'ultimo

    if (snapshots.length) {
      ripristino.messaggio = 'Scarico lo snapshot del database…';
      snapshots[snapshots.length - 1].downloadBuffer((err, buffer) => {
        if (err) {
          ripristino.errori++;
          ripristino.messaggio = 'Snapshot illeggibile (' + err.message + '), recupero solo le foto…';
        } else {
          try {
            const dati = JSON.parse(buffer.toString('utf8'));
            const insEvento = db.prepare(`INSERT INTO eventi
              (token, nome, data_evento, qualita, attivo, creato_il) VALUES (?, ?, ?, ?, ?, ?)`);
            const insFoto = db.prepare(`INSERT INTO foto
              (evento_token, filename, invitato, caricata_il) VALUES (?, ?, ?, ?)`);
            db.transaction(() => {
              for (const ev of (dati.eventi || [])) {
                const esiste = db.prepare('SELECT id FROM eventi WHERE token = ?').get(ev.token);
                if (!esiste) {
                  insEvento.run(ev.token, ev.nome, ev.data_evento || null,
                    ev.qualita || 'standard', ev.attivo === undefined ? 1 : ev.attivo, ev.creato_il || null);
                  ripristino.eventi++;
                }
              }
              for (const f of (dati.foto || [])) {
                const esiste = db.prepare('SELECT id FROM foto WHERE evento_token = ? AND filename = ?')
                  .get(f.evento_token, f.filename);
                if (!esiste) {
                  insFoto.run(f.evento_token, f.filename, f.invitato || 'Invitato', f.caricata_il || null);
                  ripristino.foto++;
                }
              }
            })();
          } catch (e) {
            ripristino.errori++;
            ripristino.messaggio = 'Snapshot corrotto (' + e.message + '), recupero solo le foto…';
          }
        }
        scaricaFoto(tutti);
      });
    } else {
      scaricaFoto(tutti);
    }
  } catch (e) {
    ripristino.in_corso = false;
    ripristino.messaggio = 'Errore durante il ripristino: ' + e.message;
  }
}

function scaricaFoto(filesMega) {
  const fotoMega = filesMega.filter(f =>
    !f.name.startsWith('db-snapshot-') && /^[A-Za-z0-9_-]{8}_.+\.jpg$/.test(f.name)
  );
  ripristino.totale = fotoMega.length;
  let i = 0;

  const prossima = () => {
    if (i >= fotoMega.length) {
      ripristino.in_corso = false;
      ripristino.messaggio =
        `✅ Completato: ${ripristino.eventi} eventi recuperati, ` +
        `${ripristino.foto} foto ripristinate, ${ripristino.errori} errori.`;
      programmaSnapshot(3000);
      return;
    }
    const f = fotoMega[i++];
    const m = f.name.match(/^([A-Za-z0-9_-]{8})_(.+)\.jpg$/);
    const token = m[1], filename = m[2];
    ripristino.messaggio = `Foto ${i} di ${ripristino.totale}…`;

    const evEsiste = db.prepare('SELECT id FROM eventi WHERE token = ?').get(token);
    if (!evEsiste) {
      db.prepare(`INSERT INTO eventi (token, nome, data_evento, qualita, attivo, creato_il)
        VALUES (?, 'Evento recuperato', NULL, 'standard', 1, ?)`)
        .run(token, new Date().toISOString().slice(0, 19).replace('T', ' '));
      ripristino.eventi++;
    }

    const registrata = db.prepare('SELECT id FROM foto WHERE evento_token = ? AND filename = ?')
      .get(token, filename);
    const percorsoLocale = path.join(CARTELLA_FOTO, filename);
    if (registrata && fs.existsSync(percorsoLocale)) { prossima(); return; }

    f.downloadBuffer((err, buffer) => {
      if (err) { ripristino.errori++; }
      else {
        try {
          fs.writeFileSync(percorsoLocale, buffer);
          if (!registrata) {
            let quando = null;
            try { quando = new Date(f.timestamp).toISOString().slice(0, 19).replace('T', ' '); } catch (e) {}
            db.prepare('INSERT INTO foto (evento_token, filename, invitato, caricata_il) VALUES (?, ?, ?, ?)')
              .run(token, filename, 'Invitato', quando);
            ripristino.foto++;
          }
        } catch (e) { ripristino.errori++; }
      }
      prossima();
    });
  };
  prossima();
}

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server avviato sulla porta ${PORT}`);
  console.log(`   Pannello admin:  ${URL_BASE}/admin`);
});