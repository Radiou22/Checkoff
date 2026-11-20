import { appFor, gencod, HttpError, integer, object, string } from '../http.js';

export function articleService(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      gencod TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      category TEXT NOT NULL,
      unitPriceCents INTEGER NOT NULL,
      vatRateBps INTEGER NOT NULL
    ) STRICT;
  `);
  const app = appFor('ArticleManager', config.internalToken);
  const find = db.prepare('SELECT * FROM articles WHERE gencod = ?');

  function fields(body, previous = {}) {
    const input = { ...previous, ...object(body) };
    return [
      string(input.name, 'name'),
      string(input.brand, 'brand'),
      string(input.category, 'category'),
      integer(input.unitPriceCents, 'unitPriceCents', { max: 10_000_000 }),
      integer(input.vatRateBps, 'vatRateBps', { max: 10_000 }),
    ];
  }

  function findArticle(code) {
    const article = find.get(code);
    if (!article) throw new HttpError(404, 'article_not_found', 'Article inconnu.');
    return article;
  }

  app.get('/articles', (req, res) => {
    const after = req.query.after === undefined ? '' : gencod(req.query.after);
    const rows = db.prepare('SELECT * FROM articles WHERE gencod > ? ORDER BY gencod LIMIT 101').all(after);
    const items = rows.slice(0, 100);
    res.json({ items, nextAfter: rows.length > 100 ? items.at(-1).gencod : null });
  });

  app.post('/articles', (req, res) => {
    const code = gencod(object(req.body).gencod);
    const result = db.prepare('INSERT OR IGNORE INTO articles VALUES (?, ?, ?, ?, ?, ?)')
      .run(code, ...fields(req.body));
    if (!result.changes) throw new HttpError(409, 'article_exists', 'Ce GENCOD est déjà utilisé.');
    res.status(201).json(findArticle(code));
  });

  app.get('/articles/:gencod', (req, res) => res.json(findArticle(gencod(req.params.gencod))));

  app.patch('/articles/:gencod', (req, res) => {
    const code = gencod(req.params.gencod);
    const previous = findArticle(code);
    if (object(req.body).gencod !== undefined && req.body.gencod !== code) {
      throw new HttpError(400, 'immutable_gencod', 'Le GENCOD identifie l’article et ne se modifie pas.');
    }
    db.prepare(`
      UPDATE articles SET name = ?, brand = ?, category = ?, unitPriceCents = ?, vatRateBps = ?
      WHERE gencod = ?
    `).run(...fields(req.body, previous), code);
    res.json(findArticle(code));
  });

  return app;
}
