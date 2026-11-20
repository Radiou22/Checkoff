# Checkoff

Checkoff est une caisse de magasin. Le caissier retrouve un produit dans le catalogue ou saisit son GENCOD, constitue le panier, encaisse la vente et obtient un ticket ou une facture PDF. Une carte de fidélité permet d’envoyer le document par mail.

Le monorepo contient un front React, une API NestJS, un microservice NestJS de rendu PDF et un job runner NestJS/BullMQ. Ils utilisent TypeScript strict et PNPM workspaces. PostgreSQL stocke les ventes et les comptes. Redis assure le cache, la limitation de connexion et les files BullMQ.

## Démarrer la démo

La démonstration nécessite Node.js 24, PNPM 12.15 et Docker Compose.

```sh
pnpm setup
docker compose up --build --wait
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt /tmp/checkoff-ca.crt
curl --cacert /tmp/checkoff-ca.crt https://localhost:8443/health
```

Le script crée un fichier `.env` avec des secrets aléatoires. Le premier démarrage initialise le catalogue et le stock de démonstration automatiquement. L’API initialise aussi le compte `ADMIN_USERNAME`, avec le mot de passe `ADMIN_PASSWORD` indiqué dans le même fichier. Ces valeurs ne réinitialisent pas un compte existant.

- **Caisse React** à `https://localhost:8443`. Installer l’autorité Caddy copiée ci-dessus dans le magasin de confiance des postes de démonstration.
- **Swagger** à `https://localhost:8443/docs/` et spécification JSON à `/docs/openapi.json`. Se connecter via `POST /api/auth/login`, puis saisir le JWT dans **Authorize**.
- **Mailpit** à `http://127.0.0.1:8025` pour lire les messages de démonstration et leurs pièces jointes.

Le paiement carte est simulé. Configurer `SMTP_URL`, `MAIL_FROM` et `SMTP_REQUIRE_TLS=1` pour utiliser un serveur SMTP qui exige STARTTLS, ou utiliser une URL `smtps://` pour TLS implicite. `STORE_NAME`, `STORE_ADDRESS` et `STORE_TAX_ID` configurent l’identification du magasin sur les PDF. Pour une caisse accessible sur le réseau du magasin, renseigner `CHECKOFF_DOMAIN` et `CHECKOFF_BIND_ADDRESS`, et distribuer la CA Caddy aux postes.

## Développer et vérifier

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm coverage
NODE_EXTRA_CA_CERTS=/tmp/checkoff-ca.crt pnpm smoke
```

Les rapports HTML des tests locaux se trouvent sous `apps/api/coverage` et `apps/front/coverage`. Le test `smoke` exerce l’application via HTTPS avec une base de démonstration et Mailpit. Il contrôle le catalogue prérempli, Swagger, les autorisations, les deux réplicas API, l’encaissement concurrent, l’idempotence, les PDF et la livraison SMTP. La CI publie aussi un rapport de couverture du back-end mesuré pendant cette démonstration.

Les branches d’intégration sont `develop` et `main`. Ouvrir les PR de fonctionnalité vers `develop`, puis une PR de `develop` vers `main` pour le rendu. Utiliser des Conventional Commits et créer un commit de fusion GitHub pour la PR vers `main`.

Voir [l’architecture et la procédure de démonstration](docs/architecture.md).
