# 2ème cerveau 🧠

Appli perso installable (téléphone et ordinateur) : habitudes, projets, finance (actu FR/EN et Trading Lab), lecture, cours de Terminale avec profs IA, sport.

- **Fonctionne hors connexion** : tout est d'abord enregistré sur l'appareil.
- **Synchronisation** téléphone ↔ ordi avec un compte Supabase gratuit (`supabase.sql`, `config.js`).
- **IA** au choix dans ⚙️ Réglages : Gemini (gratuit avec quota) ou Ollama sur le PC (illimité).
- **Actu du jour** : `.github/workflows/actu.yml` lance `scripts/actu.mjs` chaque matin en semaine et met à jour `data/news.json`. Avec le secret `GEMINI_API_KEY`, les articles sont résumés en français et en anglais ; sans lui, seuls les titres et les liens sont gardés.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | toute l'appli |
| `manifest.webmanifest`, `sw.js`, `icons/` | installation et mode hors connexion |
| `config.js` | adresse et clé publique de ton projet Supabase |
| `supabase.sql` | table de synchronisation à créer une fois dans Supabase |
| `data/news.json` | actu, cours des marchés et question du jour |
| `scripts/actu.mjs`, `.github/workflows/actu.yml` | mise à jour automatique de l'actu |

## Publier

Settings → Pages → *Deploy from a branch* → `main` / `(root)`. L'appli est ensuite à l'adresse `https://TON-PSEUDO.github.io/2eme-cerveau/`.

Le guide pas à pas complet t'a été donné avec ces fichiers.
