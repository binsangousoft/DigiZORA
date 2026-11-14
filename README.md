# DigiZORA — déploiement Render

Projet extrait du fichier `DigiZORA2.bat` fourni.

## Lancement local

Node.js 22.13+ requis (aucune dépendance npm).

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

## Données permanentes (important)

Le disque de Render gratuit est effacé à chaque mise en veille et à chaque déploiement.
DigiZORA sauvegarde donc automatiquement la base et les images dans PostgreSQL (Neon gratuit) :

1. Créer un projet sur https://neon.tech et copier l'adresse de connexion (`postgresql://...`).
2. Render > votre service > Environment > ajouter `DATABASE_URL` = cette adresse.
3. Redéployer. Les logs affichent `[sauvegarde] active`.

Fonctionnement : restauration au démarrage, envoi des changements en moins de 5 secondes, dernière sauvegarde à l'arrêt.
Si `DATABASE_URL` est absente, le site démarre mais affiche un avertissement (données temporaires).
Si la base est injoignable ou le mot de passe faux, le site refuse de démarrer (pour ne jamais écraser les vraies données).

Éviter la veille (gratuit) : créer un moniteur sur uptimerobot.com qui visite `https://VOTRE-SITE.onrender.com/api/health` toutes les 5 minutes.
