Foto-Eventi

App web per condividere le foto e i video di un evento tramite QR code.

Gli invitati scansionano il QR, aprono la pagina nel browser (niente app da installare),scattano foto, registrano video o li scelgono dal telefono: tutto finisce nella gallerialive dell'evento e viene salvato in backup su MEGA.
Funzionalità

    Pannello admin protetto da password: creazione eventi, QR code, link
    Qualità foto a 3 livelli (🟢 1280 / 🔵 1920 / 🔴 4000 px), modificabile a evento aperto
    Foto + video con invio automatico, fotocamera frontale/posteriore
    Video iPhone (.mov HEVC) e Android (.webm) convertiti automaticamente in MP4 H.264 (ffmpeg)
    Anteprime dei video generate sul server
    Immagine di sfondo personalizzata per la pagina invitati
    Galleria live con auto-aggiornamento ogni 5 secondi
    Archiviazione eventi (reversibile) o eliminazione definitiva
    Backup automatico su MEGA in /FOTO-EVENTI/<Evento [TOKEN]> + snapshot del database
    Ripristino selettivo degli eventi dal backup MEGA
    Pagina admin responsive (smartphone e desktop)

Tecnologie

Node.js, Express, SQLite (better-sqlite3), MEGA (megajs), ffmpeg-static, QRCode.
Avvio in locale

npm installnode server.js# pannello admin: http://localhost:3000/admin

Variabili d'ambiente
Variabile	Uso
ADMIN_PASSWORD	password del pannello admin
SESSION_SECRET	segreto per le sessioni
URL_BASE	indirizzo pubblico inserito nei QR code
DATA_DIR	cartella dati persistenti (es. /data su Render)
MEGA_EMAIL / MEGA_PASSWORD	account MEGA per il backup
Deploy

Configurato per Render (web service Node + disco persistente su /data).