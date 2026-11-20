import type { Article, BillingDetails, Sale } from '@checkoff/contracts';
import { useState } from 'react';
import type { FormEvent } from 'react';

export const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format;
export const displayPrice = (value: number) => money(value / 100);

export function tenderedCents(input: string): number | null {
  const normalized = input.trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) return null;
  const value = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(value) && value <= 1_000_000_000 ? value : null;
}

export function displayError(error: unknown): string {
  return error instanceof Error && error.name !== 'TimeoutError'
    ? error.message
    : 'La caisse ne répond pas. Réessaie.';
}

function glyph(article: Article): string {
  if (article.category === 'Fruits') return '🍎';
  if (article.category === 'Boulangerie') return '🥖';
  if (article.category === 'Produits frais') return '🥛';
  if (article.category === 'Boissons') return '🍊';
  return '▦';
}

export function Catalog({
  items,
  selected,
  choose,
  disabled,
}: {
  items: Article[];
  selected?: string;
  choose(article: Article): void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState('');
  const normalize = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const query = normalize(search.trim());
  const visible = items.filter((article) =>
    normalize([article.name, article.gencod, article.brand, article.category].join(' ')).includes(
      query,
    ),
  );
  return (
    <section className="panel catalog" aria-label="Catalogue">
      <label className="field search">
        <span>Rechercher un article</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Nom ou code-barres"
        />
      </label>
      <h2>Catalogue</h2>
      <ul>
        {visible.map((article) => (
          <li key={article.gencod}>
            <button
              type="button"
              className="article-choice"
              aria-pressed={selected === article.gencod}
              onClick={() => choose(article)}
              disabled={disabled}
            >
              <span className="product-glyph" aria-hidden="true">
                {glyph(article)}
              </span>
              <span className="article-name">{article.name}</span>
              <strong>{displayPrice(article.unitPriceCents)}</strong>
            </button>
          </li>
        ))}
      </ul>
      {!visible.length && <p className="muted">Aucun article trouvé.</p>}
    </section>
  );
}

export function ArticleCard({ article }: { article: Article | null }) {
  return (
    <section className="panel article-card" aria-label="Article sélectionné">
      <div className="article-visual" aria-hidden="true">
        {article ? glyph(article) : '▦'}
      </div>
      {article ? (
        <div>
          <h2>{article.name}</h2>
          <p className="muted code">GENCOD {article.gencod}</p>
          <strong className="unit-price">{displayPrice(article.unitPriceCents)}</strong>
        </div>
      ) : (
        <div>
          <h2>Article à scanner</h2>
          <p className="muted">Saisis un GENCOD ou choisis un article du catalogue.</p>
        </div>
      )}
    </section>
  );
}

const keys = ['1', '2', '3', '⌫', '4', '5', '6', 'C', '7', '8', '9', 'Entrée', '.', '0', '00'];

export function Keypad({
  onKey,
  decimal,
  disabled,
}: {
  onKey(key: string): void;
  decimal: boolean;
  disabled: boolean;
}) {
  return (
    <div className="keypad" role="group" aria-label="Pavé numérique">
      {keys.map((key) => (
        <button
          type="button"
          key={key}
          className={key === 'Entrée' ? 'key enter' : 'key'}
          aria-label={
            key === '⌫' ? 'Effacer le dernier chiffre' : key === 'C' ? 'Vider la saisie' : undefined
          }
          disabled={disabled || (key === '.' && !decimal)}
          onClick={() => onKey(key)}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

export function Basket({
  sale,
  change,
  busy,
}: {
  sale: Sale | null;
  change(code: string, quantity: number): void;
  busy: boolean;
}) {
  return (
    <section className="panel basket" aria-label="Panier">
      <div className="basket-header">
        <h2>Panier</h2>
        <span>{sale?.totals.itemCount ?? 0} article(s)</span>
      </div>
      {sale?.lines.length ? (
        <ul className="basket-items">
          {sale.lines.map((line) => (
            <li key={line.gencod}>
              <div>
                <strong>{line.name}</strong>
                <small>{displayPrice(line.unitPriceCents)} / unité</small>
              </div>
              <div className="quantity">
                <button
                  type="button"
                  aria-label={'Retirer un ' + line.name}
                  disabled={busy || sale.status === 'paid'}
                  onClick={() => change(line.gencod, line.quantity - 1)}
                >
                  −
                </button>
                <span>{line.quantity}</span>
                <button
                  type="button"
                  aria-label={'Ajouter un ' + line.name}
                  disabled={busy || sale.status === 'paid'}
                  onClick={() => change(line.gencod, line.quantity + 1)}
                >
                  +
                </button>
              </div>
              <strong className="line-total">{displayPrice(line.totalCents)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Le panier est vide.</p>
      )}
      <div className="basket-total">
        <div>
          <span>dont TVA</span>
          <span>{displayPrice(sale?.totals.vatCents ?? 0)}</span>
        </div>
        <div>
          <strong>Total TTC</strong>
          <strong>{displayPrice(sale?.totals.totalCents ?? 0)}</strong>
        </div>
      </div>
    </section>
  );
}

export function LoginForm({
  onLogin,
}: {
  onLogin(username: string, password: string): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await onLogin(String(data.get('username')), String(data.get('password')));
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel login" onSubmit={submit}>
      <h1>Connexion à la caisse</h1>
      <label className="field">
        Identifiant
        <input name="username" autoComplete="username" required />
      </label>
      <label className="field">
        Mot de passe
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        Se connecter
      </button>
    </form>
  );
}

export function BillingForm({
  submit,
  disabled,
}: {
  submit(input: BillingDetails): void;
  disabled: boolean;
}) {
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        submit({ name: String(form.get('name')), address: String(form.get('address')) });
      }}
    >
      <label className="field">
        Nom du client
        <input name="name" maxLength={120} required />
      </label>
      <label className="field">
        Adresse de facturation
        <input name="address" maxLength={240} required />
      </label>
      <button disabled={disabled}>Émettre la facture</button>
    </form>
  );
}
