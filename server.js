// ============================================================
//  SERVER - App foto/video evento con QR code — v6.1
//  Struttura MEGA: /FOTO-EVENTI/<Evento [TOKEN]>/ + _sistema
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
    const MegaLib = require('megajs');
    megaStorage = new MegaLib.Storage({
      email: process.env.MEGA_EMAIL,
      password: process.env.MEGA_PASSWORD,
      userAgent: 'foto-evento-app'
    }, (err) => {
      if (err) { console.error('☁️ MEGA: accesso fallito:', err.message); megaStorage = null; }
      else {
        megaPronto = true;
        console.log('☁️ Backup MEGA collegato (struttura: /FOTO-EVENTI)');
        try { garantisciRadice(() => garantisciSistema(() => {})); } catch (e) {}
      }
    });
  } catch (e) { console.error('☁️ MEGA non disponibile:', e.message); }
}

// ============================================================
//  LIVELLO MEGA — gestione cartelle senza proprietà ambigue.
//  Le cartelle si riconoscono SOLO dal nome (certo), non da
//  flag tipo isDirectory che variano tra versioni di megajs.
// ============================================================
const RADICE_MEGA = 'FOTO-EVENTI';
const CART_SISTEMA = '_sistema';
const megaCache = { radice: null, sistema: null, eventi: {} };

function nodiMega() { return Object.values((megaStorage && megaStorage.files) || {}); }

// figli di una cartella: usa children se presente, altrimenti l'indice per parent
function figliDi(cartella) {
  if (!cartella || cartella.nodeId === undefined) return [];
  if (Array.isArray(cartella.children)) return cartella.children.filter(Boolean);
  return nodiMega().filter(f => f && f.parent === cartella.nodeId);
}

// callback di mkdir/upload: gestisce sia (err, nodo) sia (nodo)
function estraiNodo(args) {
  for (const a of args) {
    if (a && typeof a === 'object' && !(a instanceof Error) && a.nodeId !== undefined) return a;
  }
  return null;
}

function registraNodo(nodo, parent) {
  if (!nodo || nodo.nodeId === undefined) return;
  if (!megaStorage.files) megaStorage.files = {};
  if (!megaStorage.files[nodo.nodeId]) megaStorage.files[nodo.nodeId] = nodo;
  if (parent && Array.isArray(parent.children) &&
      !parent.children.some(c => c && c.nodeId === nodo.nodeId)) parent.children.push(nodo);
}

function creaCartella(nome, parent, cb) {
  try {
    megaStorage.mkdir({ name: nome, parent }, (...args) => {
      const nodo = estraiNodo(args);
      if (nodo) registraNodo(nodo, parent);
      cb(nodo);
    });
  } catch (e) { console.error('☁️ Creazione cartella fallita:', e.message); cb(null); }
}

// /FOTO-EVENTI (creata una sola volta, poi cache)
function garantisciRadice(cb) {
  if (megaCache.radice) return cb(megaCache.radice);
  const rootNodo = megaStorage.root || null;
  if (!rootNodo) { console.error('☁️ MEGA: radice non disponibile'); return cb(null); }
  const esistente = nodiMega().find(f => f.name === RADICE_MEGA);
  if (esistente) { megaCache.radice = esistente; return cb(esistente); }
  creaCartella(RADICE_MEGA, rootNodo, (nodo) => { megaCache.radice = nodo; cb(nodo); });
}

// /FOTO-EVENTI/_sistema + pulizia dei duplicati vuoti lasciati dalla v6
function garantisciSistema(cb) {
  if (megaCache.sistema) return cb(megaCache.sistema);
  garantisciRadice((radice) => {
    if (!radice) return cb(null);
    let scelto = figliDi(radice).find(f => f.name === CART_SISTEMA)
      || nodiMega().find(f => f.name === CART_SISTEMA) || null;
    if (!scelto) {
      return creaCartella(CART_SISTEMA, radice, (nodo) => {
        megaCache.sistema = nodo; cb(nodo);
      });
    }
    megaCache.sistema = scelto;
    for (const f of nodiMega()) {
      if (f.name === CART_SISTEMA && f !== scelto && figliDi(f).length === 0) cancellaNodoMega(f);
    }
    cb(scelto);
  });
}

function pulisciNome(n) {
  return (n || 'Evento').replace(/[\/\\:<>"|?*\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Evento';
}

// cartella evento = qualsiasi nodo il cui nome termina con [TOKEN]
function trovaCartellaEvento(token) {
  const re = new RegExp(`\\[${token}\\]$`);
  return nodiMega().find(f => f.name && re.test(f.name)) || null;
}

function garantisciCartellaEvento(ev, cb) {
  if (megaCache.eventi[ev.token]) return cb(megaCache.eventi[ev.token]);
  garantisciRadice((radice) => {
    if (!radice) return cb(null);
    const esistente = trovaCartellaEvento(ev.token);
    if (esistente) { megaCache.eventi[ev.token] = esistente; return cb(esistente); }
    creaCartella(`${pulisciNome(ev.nome)} [${ev.token}]`, radice, (nodo) => {
      megaCache.eventi[ev.token] = nodo; cb(nodo);
    });
  });
}

function cancellaNodoMega(nodo) {
  if (!nodo) return;
  try { nodo.delete(true, () => {}); } catch (e1) { try { nodo.delete(() => {}); } catch (e2) {} }
}

// vecchi file "piatti" dei backup v4/v5 (TOKEN_file.ext, sfondo-TOKEN.ext)
function eliminaPiattiMega(prefisso) {
  if (!megaStorage || !megaPronto) return;
  nodiMega().forEach(f => { if (f.name && f.name.startsWith(prefisso)) cancellaNodoMega(f); });
}

function eliminaCartellaEvento(token) {
  if (!megaStorage || !megaPronto) return;
  const cartella = trovaCartellaEvento(token);
  if (!cartella) return;
  figliDi(cartella).forEach(cancellaNodoMega);
  setTimeout(() => cancellaNodoMega(cartella), 1500);
  delete megaCache.eventi[token];
}

function eliminaSfondiMega(token) {
  if (!megaStorage || !megaPronto) return;
  const cartella = trovaCartellaEvento(token);
  if (cartella) figliDi(cartella).forEach(f => {
    if (f.name && f.name.startsWith('sfondo')) cancellaNodoMega(f);
  });
  eliminaPiattiMega('sfondo-' + token);
}

function caricaBufferMega(buffer, nome, cartella, cb) {
  const opzioni = { name: nome, allowUploadBuffering: true };
  if (cartella) opzioni.parent = cartella;
  try {
    megaStorage.upload(opzioni, buffer, (...args) => {
      const err = args.find(a => a instanceof Error) || null;
      const nodo = estraiNodo(args);
      if (nodo && cartella) registraNodo(nodo, cartella);
      if (cb) cb(err);
    });
  } catch (e) { if (cb) cb(e); }
}

// copia un media nella cartella MEGA del suo evento
function backupMega(percorsoFile, nomeFile, ev) {
  if (!megaStorage || !megaPronto || !ev) return;
  try {
    garantisciCartellaEvento(ev, (cartella) => {
      if (!cartella) { console.error('☁️ Cartella evento MEGA non disponibile'); return; }
      const buffer = fs.readFileSync(percorsoFile);
      caricaBufferMega(buffer, nomeFile, cartella, (err) => {
        if (err) console.error('☁️ Backup MEGA fallito:', err.message);
      });
    });
  } catch (e) { console.error('☁️ Backup MEGA errore:', e.message); }
}

// ---------- SNAPSHOT SU MEGA (debounce 15 s) ----------
let snapshotTimer = null;
function programmaSnapshot(ritardo = 15000) {
  if (!megaStorage) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(eseguiSnapshot, ritardo);
}

function pulisciVecchiFile(cartella, prefisso, daTenere) {
  const files = figliDi(cartella)
    .filter(f => f.name && f.name.startsWith(prefisso) && f.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  files.slice(0, Math.max(0, files.length - daTenere)).forEach(cancellaNodoMega);
}

function eseguiSnapshot() {
  if (!megaStorage || !megaPronto) return;
  try {
    const eventi = db.prepare('SELECT * FROM eventi').all();
    const foto = db.prepare('SELECT * FROM foto').all();
    const ts = Date.now();

    // 1) snapshot globale → FOTO-EVENTI/_sistema (ultimi 3)
    garantisciSistema((sistema) => {
      if (!sistema) return;
      const glob = JSON.stringify({ esportato_il: new Date(ts).toISOString(), eventi, foto });
      caricaBufferMega(Buffer.from(glob), `db-snapshot-${ts}.json`, sistema, (err) => {
        if (err) console.error('☁️ Snapshot DB non salvato:', err.message);
        else { console.log('☁️ Snapshot database salvato su MEGA'); pulisciVecchiFile(sistema, 'db-snapshot-', 3); }
      });
    });

    // 2) JSON dei dati propri di ogni evento → dentro la sua cartella (ultimi 2)
    for (const ev of eventi) {
      garantisciCartellaEvento(ev, (cartella) => {
        if (!cartella) return;
        const proprie = foto.filter(f => f.evento_token === ev.token);
        const j = JSON.stringify({ esportato_il: new Date(ts).toISOString(), eventi: [ev], foto: proprie });
        caricaBufferMega(Buffer.from(j), `dati-${ts}.json`, cartella, (err) => {
          if (!err) pulisciVecchiFile(cartella, 'dati-', 2);
        });
      });
    }
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
  eliminaSfondiMega(ev.token);
  backupMega(req.file.path, 'sfondo' + path.extname(req.file.filename), ev);
  programmaSnapshot();
  res.json({ ok: true, sfondo: req.file.filename });
});

app.delete('/api/eventi/:id/sfondo', soloAdmin, (req, res) => {
  const ev = db.prepare('SELECT token, sfondo FROM eventi WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ errore: 'Evento non trovato' });
  if (ev.sfondo) { try { fs.unlinkSync(path.join(CARTELLA_FOTO, ev.sfondo)); } catch (e) {} }
  eliminaSfondiMega(ev.token);
  db.prepare('UPDATE eventi SET sfondo = NULL WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

app.post('/api/eventi/:id/toggle', soloAdmin, (req, res) => {
  db.prepare('UPDATE eventi SET attivo = 1 - attivo WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

app.post('/api/eventi/:id/dearchivia', soloAdmin, (req, res) => {
  db.prepare('UPDATE eventi SET archiviato = 0 WHERE id = ?').run(req.params.id);
  programmaSnapshot();
  res.json({ ok: true });
});

// ELIMINAZIONE: ?modo=archivia (nasconde, non tocca nulla) | ?modo=tutto (cancella tutto)
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
  backupMega(req.file.path, req.file.filename, ev);
  programmaSnapshot();
  res.json({ ok: true, tipo });
});

// ---------- ELENCO DEI BACKUP MEGA (ripristino selettivo) ----------
app.get('/admin/eventi-mega', soloAdmin, async (req, res) => {
  if (!megaStorage || !megaPronto) return res.status(400).json({ errore: 'MEGA non configurato' });
  try {
    const lista = {};
    const aggiungi = (token, nome) => {
      if (!/^[A-Za-z0-9_-]{8}$/.test(token || '')) return;
      if (!lista[token]) lista[token] = { token, nome: nome || 'Evento (backup)', num_media: 0 };
    };

    // eventi noti allo snapshot globale più recente (dove si trovi: root o _sistema)
    const snaps = nodiMega().filter(f => f.name && /^db-snapshot-\d+\.json$/.test(f.name))
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

    // cartelle evento "Nome [TOKEN]" (nuovo formato)
    for (const c of nodiMega()) {
      if (!c.name) continue;
      const m = c.name.match(/\[([A-Za-z0-9_-]{8})\]$/);
      if (!m) continue;
      aggiungi(m[1], c.name.replace(/\s*\[[^\]]+\]$/, ''));
      const numMedia = figliDi(c).filter(f => f.name &&
        !f.name.startsWith('sfondo') && !/^dati-\d+\.json$/.test(f.name)).length;
      lista[m[1]].num_media = Math.max(lista[m[1]].num_media, numMedia);
    }
    // vecchi file piatti "TOKEN_file.ext" (backup v4/v5)
    for (const f of nodiMega()) {
      if (!f.name) continue;
      const m = f.name.match(new RegExp(`^([A-Za-z0-9_-]{8})_.+\\.(${EST_MEDIA.join('|')})$`, 'i'));
      if (m) { aggiungi(m[1]); lista[m[1]].num_media++; }
    }

    res.json(Object.values(lista).map(e => ({
      ...e,
      gia_presente: !!db.prepare('SELECT id FROM eventi WHERE token = ?').get(e.token)
    })));
  } catch (e) { res.status(500).json({ errore: e.message }); }
});

// ---------- RIPRISTINO SELETTIVO ----------
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

// inserisce eventi e record foto mancanti (mai duplicati)
function applicaMeta(dati, tokens) {
  const insEvento = db.prepare(`INSERT INTO eventi
    (token, nome, data_evento, qualita, attivo, creato_il, sfondo, archiviato) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insMedia = db.prepare(`INSERT INTO foto
    (evento_token, filename, invitato, caricata_il, tipo) VALUES (?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const ev of (dati.eventi || [])) {
      if (!tokens.includes(ev.token)) continue;
      if (db.prepare('SELECT id FROM eventi WHERE token = ?').get(ev.token)) continue;
      insEvento.run(ev.token, ev.nome, ev.data_evento || null, ev.qualita || 'standard',
        ev.attivo === undefined ? 1 : ev.attivo, ev.creato_il || null, ev.sfondo || null,
        ev.archiviato ? 1 : 0);
      ripristino.eventi++;
    }
    for (const m of (dati.foto || [])) {
      if (!tokens.includes(m.evento_token)) continue;
      if (db.prepare('SELECT id FROM foto WHERE evento_token = ? AND filename = ?')
            .get(m.evento_token, m.filename)) continue;
      insMedia.run(m.evento_token, m.filename, m.invitato || 'Invitato',
        m.caricata_il || null, m.tipo || 'foto');
      ripristino.media++;
    }
  })();
}

// prova gli snapshot dal più recente, restituisce il primo leggibile
function scaricaSnapshotValido(snaps, cb) {
  const prova = (i) => {
    if (i < 0) return cb(null);
    snaps[i].downloadBuffer((err, buf) => {
      if (err) return prova(i - 1);
      try { cb(JSON.parse(buf.toString('utf8'))); }
      catch (e) { prova(i - 1); }
    });
  };
  prova(snaps.length - 1);
}

// fallback senza snapshot globale: usa i JSON dentro le cartelle evento
function ripristinoDaJsonPerEvento(tokens, done) {
  let i = 0;
  const prossima = () => {
    if (i >= tokens.length) return done();
    const token = tokens[i++];
    const cartella = trovaCartellaEvento(token);
    if (!cartella) return prossima();
    const jsons = figliDi(cartella)
      .filter(f => f.name && /^dati-\d+\.json$/.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!jsons.length) return prossima();
    jsons[jsons.length - 1].downloadBuffer((err, buf) => {
      if (!err) { try { applicaMeta(JSON.parse(buf.toString('utf8')), [token]); } catch (e) {} }
      prossima();
    });
  };
  prossima();
}

function finalizzaRipristino() {
  ripristino.in_corso = false;
  ripristino.messaggio =
    `✅ Completato: ${ripristino.eventi} eventi recuperati, ` +
    `${ripristino.media} foto/video ripristinati, ${ripristino.errori} errori.`;
  programmaSnapshot(3000);
}

function eseguiRipristino(tokens) {
  try {
    const snaps = nodiMega().filter(f => f.name && /^db-snapshot-\d+\.json$/.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dopoMeta = () => scaricaSelezionati(tokens, finalizzaRipristino);

    if (snaps.length) {
      ripristino.messaggio = 'Scarico lo snapshot del database…';
      scaricaSnapshotValido(snaps, (dati) => {
        if (dati) {
          try { applicaMeta(dati, tokens); }
          catch (e) { ripristino.errori++; }
          dopoMeta();
        } else {
          ripristino.messaggio = 'Snapshot illeggibile: uso i JSON di ogni evento…';
          ripristinoDaJsonPerEvento(tokens, dopoMeta);
        }
      });
    } else {
      ripristinoDaJsonPerEvento(tokens, dopoMeta);
    }
  } catch (e) {
    ripristino.in_corso = false;
    ripristino.messaggio = 'Errore durante il ripristino: ' + e.message;
  }
}

// scarica i media dei SOLO token scelti (cartelle nuove + vecchi file piatti)
function scaricaSelezionati(tokens, done) {
  const tasks = [];

  for (const token of tokens) {
    const cartella = trovaCartellaEvento(token);
    if (cartella) {
      for (const f of figliDi(cartella)) {
        if (!f.name) continue;
        if (f.name.startsWith('sfondo')) continue;
        if (/^dati-\d+\.json$/.test(f.name)) continue;
        tasks.push({ f, token, filename: f.name });
      }
    }
    for (const f of nodiMega()) {
      if (!f.name) continue;
      const m = f.name.match(new RegExp(`^${token}_(.+)\\.(${EST_MEDIA.join('|')})$`, 'i'));
      if (m) tasks.push({ f, token, filename: m[1] });
    }
  }

  // sfondi mancanti sul disco
  for (const token of tokens) {
    const ev = db.prepare('SELECT sfondo FROM eventi WHERE token = ?').get(token);
    if (!ev || !ev.sfondo) continue;
    if (fs.existsSync(path.join(CARTELLA_FOTO, ev.sfondo))) continue;
    const cartella = trovaCartellaEvento(token);
    let sf = cartella ? figliDi(cartella).find(f => f.name && f.name.startsWith('sfondo')) : null;
    if (!sf) sf = nodiMega().find(f => f.name &&
      new RegExp(`^sfondo-${token}\\.`, 'i').test(f.name));
    if (sf) tasks.push({ f: sf, token, filename: ev.sfondo, soloFile: true });
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

    const evEsiste = db.prepare('SELECT id FROM eventi WHERE token = ?').get(t.token);
    if (!evEsiste) {
      const c = trovaCartellaEvento(t.token);
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