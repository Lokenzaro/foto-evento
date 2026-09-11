// ============================================================
//  SERVER - App foto/video evento con QR code — v6
//  Archiviazione, ripristino selettivo, cartelle MEGA per evento
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

const ESTENSIONI = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif',
  'video/webm': '.webm', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'video/x-matroska': '.mkv', 'video/3gpp': '.3gp'
};
const EST_MEDIA = ['jpg','jpeg','png','gif','webp','heic','heif','webm','mp4','mov','mkv','3gp'];
const EST_VIDEO = ['.webm', '.mp4', '.mov', '.mkv', '.3gp'];

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
try { db.exec("ALTER TABLE eventi ADD COLUMN sfondo TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE eventi ADD COLUMN archiviato INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE foto ADD COLUMN tipo TEXT DEFAULT 'foto'"); } catch (e) {}

fs.mkdirSync(CARTELLA_FOTO, { recursive: true });

const storageMulter = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CARTELLA_FOTO),
  filename: (req, file, cb) => {
    const ext = ESTENSIONI[file.mimetype]
      || path.extname(file.originalname || '').toLowerCase()
      || '.bin';
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  }
});
const caricamento = multer({ storage: storageMulter, limits: { fileSize: 100 * 1024 * 1024 } });

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

// --- cartelle MEGA ---
const CART_SISTEMA = '_sistema';           // snapshot del database
const cartelleCache = {};                  // token -> nodo cartella evento

function nodiMega() { return Object.values(megaStorage.files || {}); }
function figliDi(cartella) {
  return nodiMega().filter(f => !f.isDirectory && f.parent === cartella.nodeId);
}
function pulisciNome(n) {
  return (n || 'Evento').replace(/[\/\\:<>"'|?*\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Evento';
}

function ottieniCartellaEvento(token, nomeEvento, cb) {
  if (cartelleCache[token]) return cb(cartelleCache[token]);
  const esistente = nodiMega().find(f => f.isDirectory && f.name.endsWith(`[${token}]`));
  if (esistente) { cartelleCache[token] = esistente; return cb(esistente); }
  try {
    megaStorage.mkdir({ name: `${pulisciNome(nomeEvento)} [${token}]`, parent: megaStorage.root },
      (err, folder) => { if (!err && folder) cartelleCache[token] = folder; cb(folder || null); });
  } catch (e) { cb(null); }
}

function ottieniCartellaSistema(cb) {
  const esistente = nodiMega().find(f => f.isDirectory && f.name === CART_SISTEMA);
  if (esistente) return cb(esistente);
  try {
    megaStorage.mkdir({ name: CART_SISTEMA, parent: megaStorage.root },
      (err, folder) => cb(folder || null));
  } catch (e) { cb(null); }
}

function cancellaNodoMega(nodo) {
  if (!nodo) return;
  try { nodo.delete(true, () => {}); } catch (e1) { try { nodo.delete(() => {}); } catch (e2) {} }
}

// Elimina la cartella MEGA di un evento (con tutto il contenuto)
function eliminaCartellaEvento(token) {
  if (!megaStorage || !megaPronto) return;
  const c = nodiMega().find(f => f.isDirectory && f.name.endsWith(`[${token}]`));
  if (!c) return;
  figliDi(c).forEach(cancellaNodoMega);
  setTimeout(() => cancellaNodoMega(c), 1500); // dà tempo alla rimozione dei figli
  delete cartelleCache[token];
}

// Rimuove i vecchi file "piatti" (backup di versione precedenti)
function eliminaPiattiMega(prefisso) {
  if (!megaStorage || !megaPronto) return;
  nodiMega().forEach(f => {
    if (f.name && !f.isDirectory && f.name.startsWith(prefisso)) cancellaNodoMega(f);
  });
}

// Copia un file nella cartella MEGA dell'evento (fallback: root con prefisso token)
function backupMega(percorsoFile, nomeFile, token, nomeEvento) {
  if (!megaStorage || !megaPronto) return;
  try {
    const buffer = fs.readFileSync(percorsoFile);
    if (!token) return;
    ottieniCartellaEvento(token, nomeEvento, (folder) => {
      const nome = folder ? nomeFile : `${token}_${nomeFile}`;
      const opzioni = { name: nome, allowUploadBuffering: true };
      if (folder) opzioni.parent = folder;
      megaStorage.upload(opzioni, buffer, (err) => {
        if (err) console.error('☁️ Backup MEGA fallito:', err.message);
      });
    });
  } catch (e) { console.error('☁️ Backup MEGA errore:', e.message); }
}

// ---------- SNAPSHOT DATABASE SU MEGA (debounce 15 s) ----------
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
    ottieniCartellaSistema((cartella) => {
      const opzioni = { name: nome, allowUploadBuffering: true };
      if (cartella) opzioni.parent = cartella;
      megaStorage.upload(opzioni, Buffer.from(dati), (err) => {
        if (err) console.error('☁️ Snapshot DB non salvato:', err.message);
        else console.log('☁️ Snapshot database salvato su MEGA');
      });
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
  const token = crypto.randomBytes(6).toString('base64url');
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

// --- SFONDO PERSONALIZZATO ---
app.post('/api/eventi/:id/sfondo', soloAdmin, caricamento.single('sfondo'), (req, res) => {
  const ev = db.prepare('SELECT token, nome, sfondo FROM eventi WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato' });
  if (!req.file.mimetype.startsWith('image/')) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(400).json({ errore: 'Il file deve essere un\'immagine' });
  }
  if (ev.sfondo) { try { fs.unlinkSync(path.join(CARTELLA_FOTO, ev.sfondo)); } catch (e) {} }
  db.prepare('UPDATE eventi SET sfondo = ? WHERE id = ?').run(req.file.filename, req.params.id);
  const ext = path.extname(req.file.filename);
  if (megaStorage && megaPronto) {
    eliminaPiattiMega('sfondo-' + ev.token);
    const vecchiaCartella = nodiMega().find(f => f.isDirectory && f.name.endsWith(`[${ev.token}]`));
    if (vecchiaCartella) figliDi(vecchiaCartella).filter(f => f.name.startsWith('sfondo')).forEach(cancellaNodoMega);
  }
  backupMega(req.file.path, `sfondo${ext}`, ev.token, ev.nome);
  programmaSnapshot();
  res.json({ ok: true, sfondo: req.file.filename });
});

app.delete('/api/eventi/:id/sfondo', soloAdmin, (req, res) => {
  const ev = db.prepare('SELECT token, sfondo FROM eventi WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato' });
  if (ev.sfondo) { try { fs.unlinkSync(path.join(CARTELLA_FOTO, ev.sfondo)); } catch (e) {} }
  if (megaStorage && megaPronto) {
    eliminaPiattiMega('sfondo-' + ev.token);
    const cartella = nodiMega().find(f => f.isDirectory && f.name.endsWith(`[${ev.token}]`));
    if (cartella) figliDi(cartella).filter(f => f.name.startsWith('sfondo')).forEach(cancellaNodoMega);
  }
  db.prepare('UPDATE eventi SET sfondo = NULL WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

app.post('/api/eventi/:id/toggle', soloAdmin, (req, res) => {
  db.prepare('UPDATE eventi SET attivo = 1 - attivo WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

// Riporta un evento archiviato nell'elenco
app.post('/api/eventi/:id/dearchivia', soloAdmin, (req, res) => {
  db.prepare('UPDATE eventi SET archiviato = 0 WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

// ELIMINAZIONE con scelta:
//   ?modo=archivia → nasconde dall'elenco (archivia): NON cancella nulla, né disco né MEGA
//   ?modo=tutto    → elimina definitivamente disco + MEGA + database
app.delete('/api/eventi/:id', soloAdmin, (req, res) => {
  const modo = req.query.modo === 'archivia' ? 'archivia' : 'tutto';
  const ev = db.prepare('SELECT token, nome, sfondo FROM eventi WHERE id = ?').get(req.params.id);
  if (!ev) return res.json({ ok: true });

  if (modo === 'archivia') {
    db.prepare('UPDATE eventi SET archiviato = 1, attivo = 0 WHERE id = ?').run(req.params.id);
    programmaSnapshot();
    return res.json({ ok: true, modo });
  }

  const media = db.prepare('SELECT filename FROM foto WHERE evento_token = ?').all(ev.token);
  for (const m of media) { try { fs.unlinkSync(path.join(CARTELLA_FOTO, m.filename)); } catch (e) {} }
  if (ev.sfondo) { try { fs.unlinkSync(path.join(CARTELLA_FOTO, ev.sfondo)); } catch (e) {} }
  if (megaStorage && megaPronto) {
    eliminaCartellaEvento(ev.token);
    eliminaPiattiMega(ev.token + '_');
    eliminaPiattiMega('sfondo-' + ev.token);
  }
  db.prepare('DELETE FROM foto WHERE evento_token = ?').run(ev.token);
  db.prepare('DELETE FROM eventi WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true, modo });
});

// ---------- API PUBBLICHE (sola lettura) ----------
app.get('/api/evento/:token', (req, res) => {
  const ev = db.prepare('SELECT nome, qualita, sfondo FROM eventi WHERE token = ? AND attivo = 1')
    .get(req.params.token);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato o chiuso' });
  res.json({ nome: ev.nome, qualita: ev.qualita, sfondo: ev.sfondo ? '/foto/' + ev.sfondo : null });
});

app.get('/api/foto/:token', (req, res) => {
  const ev = db.prepare('SELECT id FROM eventi WHERE token = ?').get(req.params.token);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato' });
  const media = db.prepare(
    'SELECT filename, tipo, invitato, caricata_il FROM foto WHERE evento_token = ? ORDER BY id DESC'
  ).all(req.params.token);
  res.json(media.map(m => ({ ...m, url: '/foto/' + m.filename, tipo: m.tipo || 'foto' })));
});

app.use('/foto', express.static(CARTELLA_FOTO));

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

// ---------- CARICAMENTO FOTO E VIDEO ----------
app.post('/upload', caricamento.single('media'), (req, res) => {
  const ev = db.prepare('SELECT token, nome FROM eventi WHERE token = ? AND attivo = 1').get(req.body.token);
  if (!ev) return res.status(403).json({ errore: 'Evento non valido o chiuso' });
  const tipo = req.file.mimetype.startsWith('video/') ? 'video' : 'foto';
  db.prepare('INSERT INTO foto (evento_token, filename, invitato, tipo) VALUES (?, ?, ?, ?)')
    .run(ev.token, req.file.filename, (req.body.nome || 'Invitato').slice(0, 50), tipo);
  backupMega(req.file.path, req.file.filename, ev.token, ev.nome);
  programmaSnapshot();
  res.json({ ok: true, tipo });
});

// ---------- ELENCO DEI BACKUP MEGA (per il ripristino selettivo) ----------
app.get('/admin/eventi-mega', soloAdmin, async (req, res) => {
  if (!megaStorage || !megaPronto) return res.status(400).json({ errore: 'MEGA non configurato' });
  try {
    const lista = {};
    const aggiungi = (token, nome) => {
      if (!lista[token]) lista[token] = { token, nome: nome || 'Evento (backup)', num_media: 0 };
    };

    // eventi presenti nello snapshot più recente
    const snaps = nodiMega().filter(f => f.name.startsWith('db-snapshot-') && f.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (snaps.length) {
      await new Promise(done => {
        snaps[snaps.length - 1].downloadBuffer((err, buf) => {
          if (!err) {
            try {
              const d = JSON.parse(buf.toString('utf8'));
              for (const ev of (d.eventi || [])) aggiungi(ev.token, ev.nome);
            } catch (e) {}
          }
          done();
        });
      });
    }

    // cartelle evento (nuovo formato: "Nome [TOKEN]")
    for (const c of nodiMega().filter(f => f.isDirectory)) {
      const m = c.name.match(/\[([A-Za-z0-9_-]{8})\]$/);
      if (m) {
        aggiungi(m[1], c.name.replace(/\s*\[[^\]]+\]$/, ''));
        lista[m[1]].num_media = figliDi(c).filter(f => !f.name.startsWith('sfondo')).length;
      }
    }
    // vecchi file piatti "TOKEN_file.ext"
    for (const f of nodiMega().filter(x => !x.isDirectory && x.name)) {
      const m = f.name.match(new RegExp(`^([A-Za-z0-9_-]{8})_.+\\.(${EST_MEDIA.join('|')})$`, 'i'));
      if (m) { aggiungi(m[1]); lista[m[1]].num_media++; }
    }

    // segnala quali eventi esistono già sul server (ripristino parziale)
    res.json(Object.values(lista).map(e => ({
      ...e,
      gia_presente: !!db.prepare('SELECT id FROM eventi WHERE token = ?').get(e.token)
    })));
  } catch (e) { res.status(500).json({ errore: e.message }); }
});

// ---------- RIPRISTINO SELETTIVO DAL BACKUP MEGA ----------
const ripristino = { in_corso: false, messaggio: 'Mai avviato', eventi: 0, media: 0, errori: 0, totale: 0 };

app.post('/admin/ripristino', soloAdmin, (req, res) => {
  if (!megaStorage || !megaPronto) {
    return res.status(400).json({ errore: 'MEGA non configurato: servono MEGA_EMAIL e MEGA_PASSWORD' });
  }
  const tokens = Array.isArray(req.body.tokens)
    ? req.body.tokens.filter(t => /^[A-Za-z0-9_-]{8}$/.test(t)) : [];
  if (!tokens.length) return res.status(400).json({ errore: 'Seleziona almeno un evento da ripristinare' });
  if (ripristino.in_corso) return res.json({ ok: true });
  ripristino.in_corso = true;
  ripristino.eventi = 0; ripristino.media = 0; ripristino.errori = 0; ripristino.totale = 0;
  ripristino.messaggio = 'Avvio: lettura dei file da MEGA…';
  eseguiRipristino(tokens);
  res.json({ ok: true });
});

app.get('/admin/stato-ripristino', soloAdmin, (req, res) => res.json(ripristino));

function eseguiRipristino(tokens) {
  try {
    const snaps = nodiMega().filter(f => f.name.startsWith('db-snapshot-') && f.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));

    const continuaConMedia = () => scaricaSelezionati(tokens, finalizzaRipristino);

    if (snaps.length) {
      ripristino.messaggio = 'Scarico lo snapshot del database…';
      snaps[snaps.length - 1].downloadBuffer((err, buffer) => {
        if (err) {
          ripristino.errori++;
          continuaConMedia();
        } else {
          try {
            const dati = JSON.parse(buffer.toString('utf8'));
            const insEvento = db.prepare(`INSERT INTO eventi
              (token, nome, data_evento, qualita, attivo, creato_il, sfondo, archiviato)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            const insMedia = db.prepare(`INSERT INTO foto
              (evento_token, filename, invitato, caricata_il, tipo) VALUES (?, ?, ?, ?, ?)`);
            db.transaction(() => {
              for (const ev of (dati.eventi || [])) {
                if (!tokens.includes(ev.token)) continue;
                const esiste = db.prepare('SELECT id FROM eventi WHERE token = ?').get(ev.token);
                if (!esiste) {
                  insEvento.run(ev.token, ev.nome, ev.data_evento || null,
                    ev.qualita || 'standard', ev.attivo === undefined ? 1 : ev.attivo,
                    ev.creato_il || null, ev.sfondo || null, ev.archiviato ? 1 : 0);
                  ripristino.eventi++;
                }
              }
              for (const m of (dati.foto || [])) {
                if (!tokens.includes(m.evento_token)) continue;
                const esiste = db.prepare('SELECT id FROM foto WHERE evento_token = ? AND filename = ?')
                  .get(m.evento_token, m.filename);
                if (!esiste) {
                  insMedia.run(m.evento_token, m.filename, m.invitato || 'Invitato',
                    m.caricata_il || null, m.tipo || 'foto');
                  ripristino.media++;
                }
              }
            })();
            continuaConMedia();
          } catch (e) {
            ripristino.errori++;
            continuaConMedia();
          }
        }
      });
    } else continuaConMedia();
  } catch (e) {
    ripristino.in_corso = false;
    ripristino.messaggio = 'Errore durante il ripristino: ' + e.message;
  }
}

function finalizzaRipristino() {
  ripristino.in_corso = false;
  ripristino.messaggio =
    `✅ Completato: ${ripristino.eventi} eventi recuperati, ` +
    `${ripristino.media} foto/video ripristinati, ${ripristino.errori} errori.`;
  programmaSnapshot(3000);
}

// Costruisce l'elenco dei file da scaricare SOLO per i token scelti
// (cartelle nuove "Nome [TOKEN]" + vecchi file piatti "TOKEN_file.ext")
function scaricaSelezionati(tokens, done) {
  const tasks = [];

  for (const token of tokens) {
    const cartella = nodiMega().find(f => f.isDirectory && f.name.endsWith(`[${token}]`));
    if (cartella) {
      for (const f of figliDi(cartella)) {
        if (f.name.startsWith('sfondo')) continue;
        tasks.push({ f, token, filename: f.name });
      }
    }
    for (const f of nodiMega().filter(x => !x.isDirectory && x.name)) {
      const m = f.name.match(new RegExp(`^${token}_(.+)\\.(${EST_MEDIA.join('|')})$`, 'i'));
      if (m) tasks.push({ f, token, filename: m[1] });
    }
  }

  // sfondi: uno per token (se l'evento lo prevede e manca sul disco)
  for (const token of tokens) {
    const ev = db.prepare('SELECT sfondo FROM eventi WHERE token = ?').get(token);
    if (!ev || !ev.sfondo) continue;
    if (fs.existsSync(path.join(CARTELLA_FOTO, ev.sfondo))) continue;
    const cartella = nodiMega().find(f => f.isDirectory && f.name.endsWith(`[${token}]`));
    if (cartella) {
      const sf = figliDi(cartella).find(f => f.name.startsWith('sfondo'));
      if (sf) { tasks.push({ f: sf, token, filename: ev.sfondo, soloFile: true }); continue; }
    }
    const piatto = nodiMega().find(f => !f.isDirectory &&
      new RegExp(`^sfondo-${token}\\.(${EST_MEDIA.join('|')})$`, 'i').test(f.name));
    if (piatto) tasks.push({ f: piatto, token, filename: ev.sfondo, soloFile: true });
  }

  ripristino.totale = tasks.length;
  let i = 0;

  const prossima = () => {
    if (i >= tasks.length) return done();
    const t = tasks[i++];
    ripristino.messaggio = `Scarico ${i} di ${ripristino.totale}…`;

    const percorsoLocale = path.join(CARTELLA_FOTO, t.filename);
    const registrato = db.prepare('SELECT id FROM foto WHERE evento_token = ? AND filename = ?')
      .get(t.token, t.filename);
    if (!t.soloFile && registrato && fs.existsSync(percorsoLocale)) { prossima(); return; }

    // se l'evento non esiste, lo ricreo (snapshot più vecchio del backup)
    const evEsiste = db.prepare('SELECT id FROM eventi WHERE token = ?').get(t.token);
    if (!evEsiste) {
      const c = nodiMega().find(f => f.isDirectory && f.name.endsWith(`[${t.token}]`));
      const nome = c ? c.name.replace(/\s*\[[^\]]+\]$/, '') : 'Evento recuperato';
      db.prepare(`INSERT INTO eventi (token, nome, data_evento, qualita, attivo, creato_il, sfondo, archiviato)
        VALUES (?, ?, NULL, 'standard', 1, ?, NULL, 0)`)
        .run(t.token, nome, new Date().toISOString().slice(0, 19).replace('T', ' '));
      ripristino.eventi++;
    }

    t.f.downloadBuffer((err, buffer) => {
      if (err) { ripristino.errori++; }
      else {
        try {
          fs.writeFileSync(percorsoLocale, buffer);
          if (!t.soloFile && !registrato) {
            let quando = null;
            try { quando = new Date(t.f.timestamp).toISOString().slice(0, 19).replace('T', ' '); } catch (e) {}
            const ext = path.extname(t.filename).toLowerCase();
            const tipo = EST_VIDEO.includes(ext) ? 'video' : 'foto';
            db.prepare('INSERT INTO foto (evento_token, filename, invitato, caricata_il, tipo) VALUES (?, ?, ?, ?, ?)')
              .run(t.token, t.filename, 'Invitato', quando, tipo);
            ripristino.media++;
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