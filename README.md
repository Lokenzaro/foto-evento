Foto-Eventi

Condividi le foto e i video di un evento con un semplice QR code.

NodeLicense: MITPRs Welcome

Gli invitati scansionano il QR code con la fotocamera del telefono e si apronouna pagina web: niente app da installare, niente account. Scattano foto, registranovideo o li caricano dalla galleria del telefono: tutto compare in una gallerialive proiettabile a schermo grande durante la festa, e viene salvato in backupautomatico su MEGA.
✨ Funzionalità

    📷 Foto e video con invio automatico (o manuale), fotocamera frontale/posteriore
    🎬 Conversione automatica dei video in MP4 H.264 (compatibili con ogni browser):i video iPhone (.mov HEVC) e Android (.webm) diventano riproducibili in galleria
    🖼️ Anteprime dei video generate sul server (ffmpeg)
    🖼️ Galleria live con auto-aggiornamento ogni 5 secondi, visualizzazione aschermo intero con nome dell'invitato e orario
    🔐 Pannello admin protetto: creazione eventi, QR code scaricabili, linkcondivisibili, apertura/chiusura evento
    🎚️ Qualità foto a 3 livelli (🟢 1280 / 🔵 1920 / 🔴 4000 px), modificabilea evento in corso
    🌄 Immagine di sfondo personalizzata per la pagina degli invitati
    📦 Archiviazione eventi (reversibile) o eliminazione definitiva
    ☁️ Backup automatico su MEGA: ogni evento nella propria cartella(FOTO-EVENTI/Nome evento [TOKEN]), snapshot del database per il ripristino
    ☁️ Ripristino selettivo degli eventi dal backup MEGA, con un click
    📱 Interfaccia responsive pensata per smartphone (fotocamera integrata,pulsanti grandi) e per proiezione
    🔒 Sicurezza: rate limiting su login e upload, cookie di sessione protetti,whitelist dei tipi di file caricati, prepared statements SQL

🎬 Come funziona

ORGANIZZATORE                        INVITATO
┌──────────────────┐                ┌──────────────────────┐
│ Crea l'evento     │   QR code ──▶ │ Scansiona il QR       │
│ riceve il QR      │               │ Scatta / carica media │
│ Vede la galleria  │ ◀── live ──── │ (niente app, niente   │
│ e lo proietta     │    update     │  account da creare)   │
└──────────────────┘                └──────────────────────┘
        │
        ▼ backup automatico su MEGA (foto, video, snapshot DB)
		

## 🛠️ Tecnologie

[Node.js](https://nodejs.org) · [Express](https://expressjs.com) ·
[SQLite (better-sqlite3)](https://github.com/WiseLibs/better-sqlite3) ·
[megajs](https://github.com/qgustavor/megajs) ·
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) ·
[qrcode](https://github.com/soldair/node-qrcode)

Frontend in HTML/CSS/JavaScript vanilla: nessun framework, nessuna build.

## 🚀 Avvio in locale

Prerequisiti: [Node.js 18+](https://nodejs.org) (consigliato 22 LTS)

```bash
git clone https://github.com/Lokenzaro/foto-evento.git
cd foto-evento
npm install
node server.js
Apri http://localhost:3000/admin (password predefinita: admin123,
sostituiscila subito con la variabile ADMIN_PASSWORD).

     

    ℹ️ In locale la fotocamera funziona perché localhost è considerato sicuro;
    da altri dispositivi della rete serve HTTPS (vedi deploy).

⚙️ Variabili d'ambiente
Variabile
	
Obbligatoria
	
Descrizione
ADMIN_PASSWORD	✅	Password del pannello admin
SESSION_SECRET	✅	Frase lunga e casuale: protegge le sessioni
URL_BASE	✅ (in produzione)	Indirizzo pubblico inserito nei QR code, es. https://mioapp.onrender.com
DATA_DIR	consigliata	Cartella dei dati persistenti (es. /data con disco Render)
MEGA_EMAIL / MEGA_PASSWORD	opzionale	Account MEGA dedicato per il backup automatico
RENDER_API_KEY / RENDER_SERVICE_ID	opzionale	Abilita il pulsante di redeploy con pulizia cache dal pannello
 
 
☁️ Deploy su Render (gratuito per iniziare)

    Fai push di questo repository su GitHub
    Su render.com: New + → Web Service → collega il repository
    Impostazioni: Build npm install · Start npm start
    Aggiungi le variabili d'ambiente della tabella sopra
    Consigliato: Disks → Add Disk con Mount Path /data e variabile
    DATA_DIR=/data → foto e database sopravvivono ai riavvii
    Deploy! L'app sarà online su https://nome-scelto.onrender.com

🔒 Note di sicurezza

     Le credenziali (admin, MEGA, API Render) vivono solo in variabili d'ambiente:
    mai nel codice, mai nella storia di Git
     Il login admin è protetto da rate limiting (10 tentativi / 15 minuti)
     Gli upload sono limitati a foto e video (whitelist MIME), max 100 MB,
    150 invii/ora per indirizzo IP
     I cookie di sessione sono httpOnly, sameSite=strict, secure in produzione
     Le query al database usano prepared statements (nessuna SQL injection)
     ⚠️ Se pubblichi la tua istanza, ricorda che i contenuti degli eventi sono
    accessibili a chi possiede il link/QR dell'evento: condividili solo con
    gli invitati
	Usa il progetto liberamente, anche per i tuoi eventi.