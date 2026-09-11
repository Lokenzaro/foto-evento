// ============================================================
//  SERVER - App foto/video evento con QR code — v6.5
//  MEGA: /FOTO-EVENTI/<Evento [TOKEN]>/
//  - figliDi() via children/parent (campo megajs: "parent")
//  - tipo media da mimetype + estensione
//  - sweep video all'avvio: ripara tipi, converte HEVC/mov/webm,
//    genera anteprime, backup MEGA del file finale
// ============================================================

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const QRCode = require('qrcode');

const VERSIONE = '6.5';

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
const EST_VIDEO_IMG = /\.(mp4|webm|mov|mkv|3gp)\.jpg$/i;   // anteprime generate dal server
const E_VIDEO = (f) => EST_VIDEO.includes(path.extname(f || '').toLowerCase());

let FFMPEG_PATH = null;
try { FFMPEG_PATH = require('ffmpeg-static'); } catch (e) { FFMPEG_PATH = null; }

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

// ---------- STATO OPERAZIONI LUNGHE (dichiarato prima dell'uso) ----------
const ripristino = { in_corso: false, messaggio: 'Mai avviato', eventi: 0, media: 0, errori: 0, totale: 0 };

// ---------- CONNESSIONE MEGA ----------
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
        aggiornaIndice(() => {
          garantisciRadice(() => garantisciSistema(() => programmaSnapshot(3000)));
        });
      }
    });
  } catch (e) { console.error('☁️ MEGA non disponibile:', e.message); }
}

// ============================================================
//  LIVELLO MEGA
//  figliDi(): usa children (presente in megajs) o il campo "parent"
// ============================================================
const RADICE_MEGA = 'FOTO-EVENTI';
const CART_SISTEMA = '_sistema';
const megaCache = { radice: null, sistema: null, eventi: {} };

function nodiMega() { return Object.values((megaStorage && megaStorage.files) || {}); }

function figliDi(cartella) {
  if (!cartella || cartella.nodeId === undefined) return [];
  if (Array.isArray(cartella.children)) return cartella.children.filter(Boolean);
  return nodiMega().filter(f => f && f.parent === cartella.nodeId && f.nodeId !== cartella.nodeId);
}

function aggiornaIndice(cb) {
  try {
    if (typeof megaStorage.refresh === 'function') {
      megaStorage.refresh(true, () => cb());
    } else cb();
  } catch (e) { cb(); }
}

function creaCartellaDentro(padre, nome, cb) {
  const fatto = () => cb();
  try {
    if (padre && typeof padre.mkdir === 'function') {
      padre.mkdir({ name: nome }, () => fatto());
    } else {
      megaStorage.mkdir({ name: nome, parent: padre }, () => fatto());
    }
  } catch (e) {
    try { megaStorage.mkdir({ name: nome }, () => fatto()); } catch (e2) { fatto(); }
  }
}

function caricaInCartella(cartella, nome, buffer, cb) {
  const fine = (err) => cb && cb(err || null);
  try {
    if (cartella && typeof cartella.upload === 'function') {
      cartella.upload({ name: nome, allowUploadBuffering: true }, buffer, (...a) =>
        fine(a.find(x => x instanceof Error)));
    } else {
      megaStorage.upload({ name: nome, allowUploadBuffering: true }, buffer, (...a) =>
        fine(a.find(x => x instanceof Error)));
    }
  } catch (e) { fine(e); }
}

function cancellaNodoMega(nodo) {
  if (!nodo) return;
  try { nodo.delete(true, () => {}); } catch (e1) { try { nodo.delete(() => {}); } catch (e2) {} }
}

function pulisciNome(n) {
  return (n || 'Evento').replace(/[\/\\:<>"|?*\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Evento';
}

function trovaRadice() {
  const root = megaStorage.root;
  if (!root) return null;
  return figliDi(root).find(f => f.name === RADICE_MEGA)
    || nodiMega().find(f => f.name === RADICE_MEGA) || null;
}

function garantisciRadice(cb) {
  if (megaCache.radice) return cb(megaCache.radice);
  aggiornaIndice(() => {
    let radice = trovaRadice();
    if (radice) { megaCache.radice = radice; return cb(radice); }
    const root = megaStorage.root;
    if (!root) { console.error('☁️ MEGA: radice del cloud non disponibile'); return cb(null); }
    creaCartellaDentro(root, RADICE_MEGA, () => {
      aggiornaIndice(() => {
        radice = trovaRadice();
        megaCache.radice = radice || null;
        if (radice) cb(radice);
        else { console.error('☁️ Creazione /FOTO-EVENTI non riuscita'); cb(null); }
      });
    });
  });
}

function garantisciSistema(cb) {
  if (megaCache.sistema) return cb(megaCache.sistema);
  garantisciRadice((radice) => {
    if (!radice) return cb(null);
    let scelto = figliDi(radice).find(f => f.name === CART_SISTEMA)
      || nodiMega().find(f => f.name === CART_SISTEMA) || null;
    if (!scelto) {
      return creaCartellaDentro(radice, CART_SISTEMA, () => {
        aggiornaIndice(() => {
          scelto = figliDi(radice).find(f => f.name === CART_SISTEMA) || null;
          megaCache.sistema = scelto;
          if (scelto) pulisciDuplicatiSistema(scelto);
          cb(scelto);
        });
      });
    }
    megaCache.sistema = scelto;
    pulisciDuplicatiSistema(scelto);
    cb(scelto);
  });
}

function pulisciDuplicatiSistema(scelto) {
  nodiMega().forEach(f => {
    if (f.name === CART_SISTEMA && f.nodeId !== scelto.nodeId) {
      const vuota = (!Array.isArray(f.children) || f.children.length === 0) && figliDi(f).length === 0;
      if (vuota) cancellaNodoMega(f);
    }
  });
}

function trovaCartellaEvento(token) {
  const re = new RegExp('\\[' + token + '\\]$');
  if (megaCache.radice) {
    const dentro = figliDi(megaCache.radice).find(f => f.name && re.test(f.name));
    if (dentro) return dentro;
  }
  return nodiMega().find(f => f.name && re.test(f.name)) || null;
}

function garantisciCartellaEvento(ev, cb) {
  if (megaCache.eventi[ev.token]) return cb(megaCache.eventi[ev.token]);
  garantisciRadice((radice) => {
    if (!radice) return cb(null);
    let cartella = trovaCartellaEvento(ev.token);
    if (cartella) { megaCache.eventi[ev.token] = cartella; return cb(cartella); }
    creaCartellaDentro(radice, `${pulisciNome(ev.nome)} [${ev.token}]`, () => {
      aggiornaIndice(() => {
        cartella = trovaCartellaEvento(ev.token) || null;
        megaCache.eventi[ev.token] = cartella;
        if (cartella) cb(cartella);
        else { console.error('☁️ Cartella evento non creabile per ' + ev.token); cb(null); }
      });
    });
  });
}

function backupMega(percorsoFile, nomeFile, ev) {
  if (!megaStorage || !megaPronto || !ev) return;
  try {
    const buffer = fs.readFileSync(percorsoFile);
    garantisciCartellaEvento(ev, (cartella) => {
      if (!cartella) return;
      caricaInCartella(cartella, nomeFile, buffer, (err) => {
        if (err) console.error('☁️ Backup MEGA fallito:', err.message);
        else console.log(`☁️ Copiato: /FOTO-EVENTI/${pulisciNome(ev.nome)} [${ev.token}]/${nomeFile}`);
      });
    });
  } catch (e) { console.error('☁️ Backup MEGA errore:', e.message); }
}

function eliminaPiattiMega(prefisso) {
  if (!megaStorage || !megaPronto) return;
  nodiMega().forEach(f => { if (f.name && f.name.startsWith(prefisso)) cancellaNodoMega(f); });
}

function eliminaNomeDaCartellaEvento(token, nome) {
  if (!megaStorage || !megaPronto) return;
  const cartella = trovaCartellaEvento(token);
  if (cartella) figliDi(cartella).forEach(f => { if (f.name === nome) cancellaNodoMega(f); });
  nodiMega().forEach(f => { if (f.name === `${token}_${nome}`) cancellaNodoMega(f); });
}

function eliminaSfondiMega(token) {
  if (!megaStorage || !megaPronto) return;
  const cartella = trovaCartellaEvento(token);
  if (cartella) figliDi(cartella).forEach(f => {
    if (f.name && f.name.startsWith('sfondo')) cancellaNodoMega(f);
  });
  eliminaPiattiMega('sfondo-' + token);
}

function eliminaCartellaEvento(token) {
  if (!megaStorage || !megaPronto) return;
  const cartella = trovaCartellaEvento(token);
  if (!cartella) return;
  figliDi(cartella).forEach(cancellaNodoMega);
  setTimeout(() => cancellaNodoMega(cartella), 2000);
  delete megaCache.eventi[token];
}

// ============================================================
//  ELABORAZIONE VIDEO (coda seriale)
// ============================================================
const codaVideo = [];
let conversioneAttiva = false;
let convTotali = 0, convFatte = 0;

function accodaConversioneVideo(ev, filename) {
  if (!FFMPEG_PATH) {
    const origine = path.join(CARTELLA_FOTO, filename);
    if (fs.existsSync(origine)) backupMega(origine, filename, ev);
    return;
  }
  codaVideo.push({ ev, filename });
  avviaConversioni();
}

function avviaConversioni() {
  if (conversioneAttiva) return;
  const job = codaVideo.shift();
  if (!job) return;
  conversioneAttiva = true;
  preparaVideo(job, () => {
    conversioneAttiva = false;
    avviaConversioni();
  });
}

function eseguiFfmpeg(args, timeoutMs, cb) {
  if (!FFMPEG_PATH) return cb(new Error('ffmpeg non disponibile'));
  execFile(FFMPEG_PATH, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    (err) => cb(err || null));
}

function preparaVideo(job, done) {
  const ev = job.ev, filename = job.filename;
  const fine = (ok) => {
    if (convTotali > 0) {
      convFatte++;
      if (ripristino.in_corso) ripristino.messaggio = `🎬 Conversione video ${convFatte}/${convTotali}…`;
      if (convFatte >= convTotali) {
        ripristino.in_corso = false;
        ripristino.messaggio = `✅ Conversione completata: ${convFatte} video elaborati.`;
        convTotali = 0; convFatte = 0;
        programmaSnapshot(3000);
      }
    }
    done(ok);
  };

  const origine = path.join(CARTELLA_FOTO, filename);
  if (!fs.existsSync(origine)) return fine(false);
  if (!FFMPEG_PATH) { backupMega(origine, filename, ev); return fine(false); }

  const ext = path.extname(filename).toLowerCase();

  const generaPoster = (fileVideo, cb) => {
    const poster = fileVideo + '.jpg';
    if (fs.existsSync(poster)) return cb();
    eseguiFfmpeg(['-y', '-ss', '1', '-i', fileVideo,
      '-vframes', '1', '-vf', 'scale=480:-2', poster], 2 * 60 * 1000, () => {
        if (!fs.existsSync(poster))
          eseguiFfmpeg(['-y', '-i', fileVideo,
            '-vframes', '1', '-vf', 'scale=480:-2', poster], 2 * 60 * 1000, () => cb());
      });
  };

  const converti = () => {
    const base = crypto.randomBytes(12).toString('hex');
    const mp4 = base + '.mp4';
    const tmp = path.join(CARTELLA_FOTO, base + '.tmp.mp4');
    console.log(`🎬 Conversione in corso: ${filename} → MP4…`);
    const args = ['-y', '-i', origine,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-vf', "scale='min(1280,iw)':-2",
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', tmp];
    eseguiFfmpeg(args, 15 * 60 * 1000, (err) => {
      if (err || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
        console.error('🎬 Conversione fallita per', filename, err ? err.message : '');
        try { fs.unlinkSync(tmp); } catch (e) {}
        generaPoster(origine, () => {});
        backupMega(origine, filename, ev);
        return fine(false);
      }
      fs.renameSync(tmp, path.join(CARTELLA_FOTO, mp4));
      db.prepare('UPDATE foto SET filename = ? WHERE evento_token = ? AND filename = ?')
        .run(mp4, ev.token, filename);
      try { fs.unlinkSync(origine); } catch (e) {}
      generaPoster(path.join(CARTELLA_FOTO, mp4), () => {});
      eliminaNomeDaCartellaEvento(ev.token, filename);
      backupMega(path.join(CARTELLA_FOTO, mp4), mp4, ev);
      console.log(`🎬 Convertito: ${filename} → ${mp4}`);
      programmaSnapshot();
      fine(true);
    });
  };

  if (ext === '.mp4') {
    execFile(FFMPEG_PATH, ['-i', origine], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 },
      (err, so, se) => {
        const out = (se || '') + (so || '');
        if (/hevc|hvc1/i.test(out)) return converti();
        generaPoster(origine, () => {
          backupMega(origine, filename, ev);
          console.log(`🎬 Video MP4 ok (H.264): anteprima pronta per ${filename}`);
          fine(true);
        });
      });
  } else {
    converti();
  }
}

// ---------- SNAPSHOT SU MEGA ----------
let snapshotTimer = null;
let snapshotInAttesa = false;
function programmaSnapshot(ritardo = 15000) {
  if (!megaStorage) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(eseguiSnapshot, ritardo);
}

function pulisciVecchiFile(cartella, prefisso, daTenere) {
  aggiornaIndice(() => {
    const files = figliDi(cartella)
      .filter(f => f.name && f.name.startsWith(prefisso) && f.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));
    files.slice(0, Math.max(0, files.length - daTenere)).forEach(cancellaNodoMega);
  });
}

function eseguiSnapshot() {
  if (!megaStorage) return;
  if (!megaPronto) {
    if (!snapshotInAttesa) {
      snapshotInAttesa = true;
      setTimeout(() => { snapshotInAttesa = false; eseguiSnapshot(); }, 20000);
    }
    return;
  }
  try {
    const eventi = db.prepare('SELECT * FROM eventi').all();
    const foto = db.prepare('SELECT * FROM foto').all();
    const ts = Date.now();

    garantisciSistema((sistema) => {
      if (!sistema) return;
      const glob = JSON.stringify({ esportato_il: new Date(ts).toISOString(), eventi, foto });
      caricaInCartella(sistema, `db-snapshot-${ts}.json`, Buffer.from(glob), (err) => {
        if (err) console.error('☁️ Snapshot DB non salvato:', err.message);
        else {
          console.log('☁️ Snapshot salvato: /FOTO-EVENTI/_sistema');
          pulisciVecchiFile(sistema, 'db-snapshot-', 3);
        }
      });
    });

    for (const ev of eventi) {
      garantisciCartellaEvento(ev, (cartella) => {
        if (!cartella) return;
        const proprie = foto.filter(f => f.evento_token === ev.token);
        const j = JSON.stringify({ esportato_il: new Date(ts).toISOString(), eventi: [ev], foto: proprie });
        caricaInCartella(cartella, `dati-${ts}.json`, Buffer.from(j), (err) => {
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

app.get('/version', (req, res) => res.json({ versione: VERSIONE }));

app.post('/admin/login', (req, res) => {
  if (req.body.password === PASSWORD_ADMIN) { req.session.admin = true; return res.json({ ok: true }); }
  res.status(401).json({ errore: 'Password errata' });
});
app.post('/admin/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

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
  for (const m of media) {
    try { fs.unlinkSync(path.join(CARTELLA_FOTO, m.filename)); } catch (e) {}
    try { fs.unlinkSync(path.join(CARTELLA_FOTO, m.filename + '.jpg')); } catch (e) {}
  }
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

app.get('/qr/:token', soloAdmin, async (req, res) => {
  const ev = db.prepare('SELECT token FROM eventi WHERE token = ?').get(req.params.token);
  if (!ev) return res.status(404).send('Non trovato');
  const png = await QRCode.toBuffer(`${URL_BASE}/e/${ev.token}`, { width: 600, margin: 2 });
  res.type('image/png').send(png);
});

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

app.post('/upload', caricamento.single('media'), (req, res) => {
  const ev = db.prepare('SELECT token, nome FROM eventi WHERE token = ? AND attivo = 1').get(req.body.token);
  if (!ev) return res.status(403).json({ errore: 'Evento non valido o chiuso' });
  const tipo = (req.file.mimetype.startsWith('video/') || E_VIDEO(req.file.filename)) ? 'video' : 'foto';
  db.prepare('INSERT INTO foto (evento_token, filename, invitato, tipo) VALUES (?, ?, ?, ?)')
    .run(ev.token, req.file.filename, (req.body.nome || 'Invitato').slice(0, 50), tipo);

  if (tipo === 'video') {
    accodaConversioneVideo(ev, req.file.filename);
  } else {
    backupMega(req.file.path, req.file.filename, ev);
  }
  programmaSnapshot();
  res.json({ ok: true, tipo });
});

// ---------- ELENCO BACKUP: SOLO eventi con file reali su MEGA ----------
app.get('/admin/eventi-mega', soloAdmin, (req, res) => {
  if (!megaStorage || !megaPronto) return res.status(400).json({ errore: 'MEGA non configurato' });
  aggiornaIndice(async () => {
    try {
      const lista = {};
      const conContenuto = new Set();
      for (const c of nodiMega()) {
        const m = c.name && c.name.match(/\[([A-Za-z0-9_-]{8})\]$/);
        if (m && figliDi(c).length > 0) conContenuto.add(m[1]);
      }
      for (const f of nodiMega()) {
        const m = f.name && f.name.match(new RegExp(`^([A-Za-z0-9_-]{8})_.+\\.(${EST_MEDIA.join('|')})$`, 'i'));
        if (m) conContenuto.add(m[1]);
      }
      if (!conContenuto.size) return res.json([]);

      const meta = {};
      const snaps = nodiMega().filter(f => f.name && /^db-snapshot-\d+\.json$/.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      await new Promise(done => {
        if (!snaps.length) return done();
        snaps[snaps.length - 1].downloadBuffer((err, buf) => {
          if (!err) {
            try {
              const d = JSON.parse(buf.toString('utf8'));
              for (const ev of (d.eventi || [])) {
                if (conContenuto.has(ev.token)) meta[ev.token] = ev.nome;
              }
            } catch (e) {}
          }
          done();
        });
      });

      for (const c of nodiMega()) {
        const m = c.name && c.name.match(/\[([A-Za-z0-9_-]{8})\]$/);
        if (!m || !conContenuto.has(m[1])) continue;
        const token = m[1];
        if (!lista[token]) {
          lista[token] = {
            token,
            nome: c.name.replace(/\s*\[[^\]]+\]$/, '') || meta[token] || 'Evento (backup)',
            num_media: 0
          };
        }
        lista[token].num_media = figliDi(c).filter(f => f.name &&
          !f.name.startsWith('sfondo') && !/^dati-\d+\.json$/.test(f.name) &&
          !EST_VIDEO_IMG.test(f.name)).length;
      }
      for (const f of nodiMega()) {
        const m = f.name && f.name.match(new RegExp(`^([A-Za-z0-9_-]{8})_.+\\.(${EST_MEDIA.join('|')})$`, 'i'));
        if (!m) continue;
        const token = m[1];
        if (!lista[token]) lista[token] = { token, nome: meta[token] || 'Evento (backup)', num_media: 0 };
        lista[token].num_media++;
      }

      res.json(Object.values(lista).map(e => ({
        ...e,
        gia_presente: !!db.prepare('SELECT id FROM eventi WHERE token = ?').get(e.token)
      })));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ errore: e.message });
    }
  });
});

// ---------- RIPRISTINO SELETTIVO ----------
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

app.post('/admin/converti-video', soloAdmin, (req, res) => {
  if (!FFMPEG_PATH) return res.status(400).json({ errore: 'ffmpeg non disponibile sul server' });
  if (ripristino.in_corso) return res.json({ ok: true });
  const candidati = db.prepare(`
    SELECT f.filename, f.evento_token, e.nome
    FROM foto f JOIN eventi e ON e.token = f.evento_token
    WHERE f.tipo = 'video'
  `).all().filter(v => {
    const p = path.join(CARTELLA_FOTO, v.filename);
    return fs.existsSync(p) && !fs.existsSync(p + '.jpg');
  });
  if (!candidati.length) return res.json({ ok: true, nessuno: true });
  ripristino.in_corso = true;
  ripristino.eventi = 0; ripristino.media = 0; ripristino.errori = 0; ripristino.totale = candidati.length;
  convTotali = candidati.length; convFatte = 0;
  ripristino.messaggio = `🎬 Conversione video 0/${candidati.length}…`;
  for (const c of candidati) accodaConversioneVideo({ token: c.evento_token, nome: c.nome }, c.filename);
  res.json({ ok: true });
});

app.get('/admin/stato-ripristino', soloAdmin, (req, res) => {
  const r = { ...ripristino };
  if (r.in_corso && convTotali > 0) r.messaggio = `🎬 Conversione video ${convFatte}/${convTotali}…`;
  res.json(r);
});

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

function scaricaSnapshotValido(snaps, cb) {
  const prova = (i) => {
    if (i < 0) return cb(null);
    snaps[i].downloadBuffer((err, buf) => {
      if (err) return prova(i - 1);
      try { cb(JSON.parse(buf.toString('utf8'))); } catch (e) { prova(i - 1); }
    });
  };
  prova(snaps.length - 1);
}

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
    aggiornaIndice(() => {
      const snaps = nodiMega().filter(f => f.name && /^db-snapshot-\d+\.json$/.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      const dopoMeta = () => scaricaSelezionati(tokens, finalizzaRipristino);

      if (snaps.length) {
        ripristino.messaggio = 'Scarico lo snapshot del database…';
        scaricaSnapshotValido(snaps, (dati) => {
          if (dati) {
            try { applicaMeta(dati, tokens); } catch (e) { ripristino.errori++; }
            dopoMeta();
          } else {
            ripristino.messaggio = 'Snapshot illeggibile: uso i JSON di ogni evento…';
            ripristinoDaJsonPerEvento(tokens, dopoMeta);
          }
        });
      } else ripristinoDaJsonPerEvento(tokens, dopoMeta);
    });
  } catch (e) {
    ripristino.in_corso = false;
    ripristino.messaggio = 'Errore durante il ripristino: ' + e.message;
  }
}

function scaricaSelezionati(tokens, done) {
  const tasks = [];

  for (const token of tokens) {
    const cartella = trovaCartellaEvento(token);
    if (cartella) {
      for (const f of figliDi(cartella)) {
        if (!f.name) continue;
        if (f.name.startsWith('sfondo')) continue;
        if (/^dati-\d+\.json$/.test(f.name)) continue;
        if (EST_VIDEO_IMG.test(f.name)) continue;
        tasks.push({ f, token, filename: f.name });
      }
    }
    for (const f of nodiMega()) {
      if (!f.name) continue;
      const m = f.name.match(new RegExp(`^${token}_(.+)\\.(${EST_MEDIA.join('|')})$`, 'i'));
      if (m) tasks.push({ f, token, filename: m[1] });
    }
  }

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
            const tipo = E_VIDEO(t.filename) ? 'video' : 'foto';
            db.prepare('INSERT INTO foto (evento_token, filename, invitato, caricata_il, tipo) VALUES (?, ?, ?, ?, ?)')
              .run(t.token, t.filename, 'Invitato', quando, tipo);
            ripristino.media++;
          }
          if (E_VIDEO(t.filename)) {
            const evR = db.prepare('SELECT token, nome FROM eventi WHERE token = ?').get(t.token);
            if (evR) accodaConversioneVideo(evR, t.filename);
          }
        } catch (e) { ripristino.errori++; }
      }
      prossima();
    });
  };
  prossima();
}

// ---------- MANUTENZIONE ALL'AVVIO ----------
function riparaTipiMedia() {
  const cond = EST_VIDEO.map(e => `LOWER(filename) LIKE '%${e}'`).join(' OR ');
  const info = db.prepare(`UPDATE foto SET tipo = 'video' WHERE tipo != 'video' AND (${cond})`).run();
  if (info.changes) console.log(`🎬 Riparati ${info.changes} media registrati con tipo errato`);
}

function elaboraVideoEsistenti() {
  if (!FFMPEG_PATH) return;
  riparaTipiMedia();
  const video = db.prepare(`SELECT filename, evento_token FROM foto WHERE tipo = 'video' ORDER BY id`).all();
  let n = 0;
  for (const v of video) {
    const ev = db.prepare('SELECT token, nome FROM eventi WHERE token = ?').get(v.evento_token);
    if (!ev) continue;
    const percorso = path.join(CARTELLA_FOTO, v.filename);
    if (!fs.existsSync(percorso)) continue;
    if (fs.existsSync(percorso + '.jpg')) continue;
    accodaConversioneVideo(ev, v.filename);
    n++;
  }
  if (n) console.log(`🎬 Elaborazione di ${n} video (conversione/anteprime) avviata…`);
}

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server foto-eventi v${VERSIONE} avviato sulla porta ${PORT}`);
  console.log(`   Pannello admin:  ${URL_BASE}/admin`);
  console.log(`🎬 ffmpeg: ${FFMPEG_PATH ? 'disponibile' : 'NON disponibile'}`);
  elaboraVideoEsistenti();
});