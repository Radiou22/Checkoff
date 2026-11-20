# Checkoff — Back-end

API de caisse en Node.js 24 et Express. Chaque service dispose de sa propre base SQLite. La passerelle Caddy expose le `CheckoutManager` en HTTPS. Celui-ci appelle les services de catalogue, de stock, de paiement, de justificatifs et d’utilisateurs sur le réseau Docker.

## Démarrage

```sh
cp .env.example .env
openssl rand -hex 32
```

Dans `.env`, renseigner `ADMIN_PASSWORD` (au moins 12 caractères) et copier la valeur générée dans `CHECKOFF_INTERNAL_TOKEN`. `ADMIN_USERNAME` et `ADMIN_PASSWORD` servent à créer le premier administrateur sur une base vide. Modifier ces variables après l’initialisation ne change pas le compte existant.

```sh
docker compose up --build --wait
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt /tmp/checkoff-ca.crt
curl --cacert /tmp/checkoff-ca.crt https://localhost:8443/health
```

La configuration par défaut publie la passerelle sur `127.0.0.1:8443`. Sur le réseau local du magasin, configurer `CHECKOFF_BIND_ADDRESS` sur l’adresse LAN du serveur, renseigner `CHECKOFF_DOMAIN` avec le nom utilisé par les postes, puis installer l’autorité Caddy sur ces postes. Chaque service conserve ses données dans un volume dédié. Le mode Compose lance une instance par service.

Pour lancer les six services localement sans Docker, avec Node.js 24 et une configuration administrateur dans `.env` :

```sh
npm ci
npm start
npm test
```

En mode local, l’API est disponible sur `http://127.0.0.1:8080` et les données restent dans `data/`. Si le front est servi depuis une autre origine, définir `CORS_ORIGIN` avec son origine exacte, par exemple `http://localhost:5173`.

## API publique

Les routes sont préfixées par `/api`, sauf `GET /health`. Envoyer les corps en JSON avec `Content-Type: application/json`. Après connexion, envoyer `Authorization: Bearer <token>`. Les sessions expirent après huit heures. Une erreur JSON contient `error.code` et `error.message`.

| Méthode et route | Corps ou paramètres | Accès |
| --- | --- | --- |
| `POST /auth/login` | `{ username, password }` → `{ token, expiresAt, user }` | Public |
| `GET /auth/me`, `POST /auth/logout` | Utilisateur courant / fermeture de session | Authentifié |
| `GET /users` | Curseur facultatif `after` (nom d’utilisateur) | Admin |
| `POST /users` | `{ username, password, role? }` avec `cashier` par défaut ou `admin` | Admin |
| `PATCH /users/:id` | `{ active }` (la désactivation révoque les sessions) | Admin |
| `GET /articles`, `GET /articles/:gencod` | Liste ou article. Curseur facultatif `after` (GENCOD) | Authentifié |
| `POST /articles` | `{ gencod, name, brand, category, unitPriceCents, vatRateBps }` | Admin |
| `PATCH /articles/:gencod` | Champs modifiables de l’article | Admin |
| `GET /stock`, `GET /stock/:gencod` | Liste ou état `{ gencod, onHand, reserved, available }`. Curseur facultatif `after` (GENCOD) | Authentifié |
| `PUT /stock/:gencod` | `{ onHand }` (stock physique constaté) | Admin |
| `POST /loyalty-cards` | `{ code, email }` | Authentifié |
| `PATCH /loyalty-cards/:code`, `DELETE /loyalty-cards/:code` | `{ email }` pour la mise à jour | Admin |
| `POST /checkouts`, `GET /checkouts` | Ouvrir un panier / lister les ventes du compte. Curseur facultatif `after` (ID de vente) | Authentifié |
| `GET /checkouts/:id` | Panier, totaux, état et paiement si payé | Propriétaire ou admin |
| `PUT /checkouts/:id/lines/:gencod`, `DELETE /checkouts/:id/lines/:gencod` | `{ quantity }` pour fixer la quantité, ou suppression de la ligne | Propriétaire ou admin |
| `PUT /checkouts/:id/loyalty-card` | `{ code }` ou `{ "code": null }` pour détacher la carte | Propriétaire ou admin |
| `POST /checkouts/:id/finalize` | `{ method, tenderedCents }` avec `cash` ou `card` | Propriétaire ou admin |
| `PUT /checkouts/:id/invoice` | `{ name, address }` pour émettre une facture numérotée | Propriétaire ou admin |
| `GET /checkouts/:id/documents/:type` | PDF imprimable. `type` vaut `ticket` ou `invoice` | Propriétaire ou admin |
| `POST /checkouts/:id/documents/:type/email` | Envoi explicite du PDF à l’adresse de la carte associée | Propriétaire ou admin |

Les listes renvoient `{ items, nextAfter }`, avec au plus 100 entrées et `nextAfter: null` en fin de liste. Un administrateur peut consulter tous les paniers. Le GENCOD est une chaîne de 8 à 14 chiffres afin de préserver les zéros initiaux.

Tous les montants sont des entiers en centimes d’euro. `unitPriceCents` est TTC et `vatRateBps` est en points de base (`2000` pour 20 %). Les prix et taux sont figés à l’ajout de la ligne. Le calcul de la TVA sépare le TTC et le HT arrondi au centime par ligne.

## Vente et reprise

1. Ouvrir le panier et enregistrer chaque quantité par GENCOD. Associer une carte si le client souhaite recevoir un document.
2. Finaliser la vente. Le stock est réservé avant validation. En cas de paiement refusé (`422 payment_declined`), la réservation est libérée et le panier redevient modifiable.
3. Une fois la vente `paid`, récupérer le ticket PDF ou émettre la facture puis récupérer son PDF.
4. Pour envoyer un justificatif, configurer `SMTP_URL` (`smtp://…` ou `smtps://…`) et `MAIL_FROM`, puis appeler la route d’envoi. Un échec SMTP remonte en `502` et laisse le PDF et la vente disponibles.

Le paiement carte est **simulé** par une comparaison du montant TTC. Le paiement en espèces calcule la monnaie à rendre. Aucun numéro de carte n’est demandé. En cas de réponse perdue ou d’état `processing`, renvoyer le même corps à `/finalize`. Le stock et le paiement reconnaissent la tentative déjà enregistrée, y compris après un redémarrage. Renseigner `STORE_NAME`, `STORE_ADDRESS` et `STORE_TAX_ID` pour afficher l’identité du magasin sur les documents.

`npm test` vérifie le parcours de caisse via HTTP, dont les rôles, les PDF, les réponses SMTP simulées, le refus du paiement, deux ventes concurrentes et la reprise après redémarrage.
