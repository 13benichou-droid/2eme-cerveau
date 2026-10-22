# 2ème cerveau 🧠

Appli perso installable (téléphone et ordinateur) : habitudes, projets, finance (actu FR/EN et Trading Lab), lecture, cours de Terminale avec profs IA, sport.

- **Fonctionne hors connexion** : tout est d'abord enregistré sur l'appareil.
- **Synchronisation** téléphone ↔ ordi avec un compte Supabase gratuit (`supabase.sql`, `config.js`).
- **IA** dans ⚙️ Réglages : Gemini (gratuit avec quota), puis le relais Cloudflare (Mistral, Cerebras, Groq, OpenRouter), puis Ollama sur le PC.
- **Actu du jour** : `.github/workflows/actu.yml` lance `scripts/actu.mjs` chaque matin en semaine et met à jour `data/news.json`. Les résumés FR/EN sont écrits par la première IA qui répond : Gemini (secret `GEMINI_API_KEY`), puis le relais Cloudflare (secret `RELAIS_LIEN` = le « lien pour ton autre appareil » des Réglages), puis d'éventuelles clés directes (`MISTRAL_API_KEY`, `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`). Un article resté sans résumé est rattrapé les jours suivants, ou depuis l'appli avec « ✨ Résumer avec l'IA ».

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
