# DigiZORA — déploiement Render

Projet extrait du fichier `DigiZORA2.bat` fourni.

## Lancement local

Node.js 22.13+ requis.

```bash
npm start
```

Puis ouvrir http://localhost:3000

## Déploiement Render

- Runtime : Node
- Build command : `npm install`
- Start command : `npm start`
- Node : 22.16.0 ou version 22 récente

Définir au minimum `ADMIN_EMAIL` et `ADMIN_PASSWORD` dans les variables d'environnement Render.

## Attention données

La version gratuite Render utilise un disque éphémère. La base SQLite et les fichiers de `data/uploads` / `data/private` ne doivent pas être considérés comme un stockage permanent. Pour la production, migrer la base vers PostgreSQL et les fichiers vers un stockage persistant/object storage.
