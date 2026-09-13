Come contribuire

Grazie per l'interesse! Questo progetto nasce per condividere le fotodegli eventi ed è aperto a miglioramenti.
Come proporre una modifica

    Fai un Fork del repository
    Crea un ramo: git checkout -b mia-funzionalita
    Apporta le modifiche e verifica: node --check server.js
    Commit: git commit -m "Descrizione chiara della modifica"
    Push sul tuo fork e apri una Pull Request

Linee guida

    Il progetto usa solo Node.js + Express + SQLite: niente dipendenze pesanti non giustificate
    Le funzioni di backup MEGA sono delicate: se le tocchi, spiega il test fatto
    Ogni nuova variabile d'ambiente va documentata nel README
    Segnala bug aprendo una Issue con: versione (/version), passi per riprodurre, log rilevanti

PASSO 3 — Rendi pubblico il repository

    Apri https://github.com/Lokenzaro/foto-evento
    Settings → scorri fino a Danger Zone → Change repository visibility → Change to public → conferma scrivendo il nome del repository
    Sempre in Settings → General: compila Description (es. «Condividi le foto e i video di un evento via QR code, con galleria live e backup MEGA») e aggiungi Topics: nodejs express qrcode mega ffmpeg sqlite events photo-sharing
    Settings → Actions/Features: spunta Issues (indispensabile per i contributori); Discussions facoltativo
    Security tab del repository → abilita Dependabot alerts e Secret scanning (gratuiti, ti avvisano se una dipendenza ha vulnerabilità o se qualcuno incolla un segreto)
    (Opzionale) Branch protection: Settings → Branches → Add rule su main → "Require a pull request before merging": ti obbliga a rivedere le modifiche di altri prima di integrarle. Per iniziare puoi anche non attivarlo, vista la scala del progetto