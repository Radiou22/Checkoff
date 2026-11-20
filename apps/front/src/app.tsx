import type {
  Article,
  BillingDetails,
  Delivery,
  DocumentType,
  Sale,
  SaleSummary,
  User,
} from '@checkoff/contracts';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, checkoutApi, login } from './api.js';
import {
  ArticleCard,
  Basket,
  BillingForm,
  Catalog,
  displayError,
  displayPrice,
  Keypad,
  LoginForm,
  tenderedCents,
} from './components.js';

type Api = ReturnType<typeof checkoutApi>;

export function App() {
  const [connection, setConnection] = useState<{
    api: Api;
    user: User;
    articles: Article[];
    initialSale: Sale | null;
  } | null>(null);

  async function connect(username: string, password: string): Promise<void> {
    const session = await login(username, password);
    const api = checkoutApi(session.token);
    const [articles, recent] = await Promise.all([api.articles(), api.recent()]);
    const open = recent.items.find(
      (entry) => entry.status === 'open' && entry.cashierId === session.user.id,
    );
    const initialSale = open ? await api.find(open.id) : null;
    setConnection({ api, articles, initialSale, user: session.user });
  }

  return (
    <>
      <header className="top">
        <strong>
          <span aria-hidden="true">✓</span> Checkoff
        </strong>
        <span>{connection ? 'Caisse ouverte · ' + connection.user.username : 'Caisse'}</span>
      </header>
      {connection ? (
        <Register {...connection} exit={() => setConnection(null)} />
      ) : (
        <main>
          <LoginForm onLogin={connect} />
        </main>
      )}
    </>
  );
}

type Panel = 'loyalty' | 'payment' | 'history' | null;

function Register({
  api,
  articles,
  initialSale,
  exit,
}: {
  api: Api;
  articles: Article[];
  initialSale: Sale | null;
  exit(): void;
}) {
  const [sale, setSale] = useState(initialSale);
  const [selected, setSelected] = useState<Article | null>(initialSale?.lines.at(-1) ?? null);
  const [scan, setScan] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [panel, setPanel] = useState<Panel>(null);
  const [recent, setRecent] = useState<SaleSummary[]>([]);
  const [showInvoice, setShowInvoice] = useState(false);
  const [issued, setIssued] = useState(false);
  const [deliveries, setDeliveries] = useState<Partial<Record<DocumentType, Delivery>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const locked = useRef(false);
  const entryRef = useRef<HTMLInputElement>(null);
  const paid = sale?.status === 'paid';
  const cashMode = panel === 'payment' && method === 'cash';

  async function run(action: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) exit();
      else setError(displayError(reason));
    } finally {
      setBusy(false);
      locked.current = false;
    }
  }

  async function ensureSale() {
    if (sale?.status === 'open') return sale;
    const next = await api.create();
    setSale(next);
    return next;
  }

  async function add(article: Article) {
    const current = await ensureSale();
    const quantity = current.lines.find((line) => line.gencod === article.gencod)?.quantity ?? 0;
    setSale(await api.line(current.id, article.gencod, quantity + 1));
    setSelected(article);
    setScan('');
    entryRef.current?.focus();
  }

  function enter(): void {
    if (panel === 'payment') {
      pay();
      return;
    }
    void run(async () => {
      if (!/^\d{8,14}$/.test(scan.trim()))
        throw new Error('Saisis un code-barres de 8 à 14 chiffres.');
      await add(await api.getArticle(scan.trim()));
    });
  }

  function keypress(key: string): void {
    if (key === 'Entrée') {
      enter();
      return;
    }
    const write = cashMode ? setAmount : setScan;
    write((value) => {
      if (key === 'C') return '';
      if (key === '⌫') return value.slice(0, -1);
      if (key === '.' && /[.,]/.test(value)) return value;
      return (value + key).slice(0, cashMode ? 12 : 14);
    });
  }

  function change(code: string, quantity: number): void {
    if (!sale) return;
    void run(async () => {
      setSale(
        quantity ? await api.line(sale.id, code, quantity) : await api.removeLine(sale.id, code),
      );
    });
  }

  function pay(): void {
    if (!sale) return;
    void run(async () => {
      const tendered = method === 'cash' ? tenderedCents(amount) : sale.totals.totalCents;
      if (tendered === null) throw new Error('Saisis un montant valide, par exemple 10,50.');
      const result = await api.pay(sale.id, { method, tenderedCents: tendered });
      setSale(result);
      setPanel(null);
      setNotice(
        result.payment?.changeCents
          ? 'Monnaie à rendre : ' + displayPrice(result.payment.changeCents)
          : 'Vente encaissée.',
      );
    });
  }

  function attach(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = String(data.get('code')).trim();
    const email = String(data.get('email')).trim();
    void run(async () => {
      const current = await ensureSale();
      if (email) await api.createCard(code, email);
      setSale(await api.link(current.id, code));
      setPanel(null);
      setNotice('Carte de fidélité associée.');
    });
  }

  function chooseSale(next: Sale): void {
    setSale(next);
    setSelected(next.lines.at(-1) ?? null);
    setPanel(null);
    setAmount('');
    setScan('');
    setShowInvoice(false);
    setIssued(false);
    setDeliveries({});
  }

  function document(type: DocumentType): void {
    if (!sale) return;
    void run(async () => {
      const url = URL.createObjectURL(await api.pdf(sale.id, type));
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${type}-${sale.id}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  }

  function issue(body: BillingDetails): void {
    if (!sale) return;
    void run(async () => {
      await api.issue(sale.id, body);
      setIssued(true);
      setShowInvoice(false);
      setNotice('Facture émise.');
    });
  }

  function email(type: DocumentType): void {
    if (!sale) return;
    const pending = deliveries[type]?.status === 'pending';
    void run(async () => {
      const result = await (pending ? api.status(sale.id, type) : api.queue(sale.id, type));
      setDeliveries((previous) => ({ ...previous, [type]: result }));
      if (result.status === 'failed')
        setError(result.lastError ?? 'Le justificatif n’a pas pu être envoyé.');
      else
        setNotice(
          result.status === 'sent' ? 'Justificatif envoyé.' : 'Justificatif en attente d’envoi.',
        );
    });
  }

  return (
    <main className="register">
      <div className="workspace">
        <Catalog
          items={articles}
          selected={selected?.gencod}
          choose={(product) => void run(() => add(product))}
          disabled={busy || paid || panel === 'payment'}
        />
        <div className="center">
          <ArticleCard article={selected} />
          <form
            className="scan-form"
            onSubmit={(event) => {
              event.preventDefault();
              enter();
            }}
          >
            <label className="field">
              {cashMode ? 'Montant reçu en espèces (€)' : 'Saisie du code-barres'}
              <input
                ref={entryRef}
                value={cashMode ? amount : scan}
                inputMode={cashMode ? 'decimal' : 'numeric'}
                placeholder={cashMode ? '0,00' : 'Scanner ou saisir un GENCOD'}
                disabled={busy || paid || (panel === 'payment' && !cashMode)}
                onChange={(event) =>
                  (cashMode ? setAmount : setScan)(event.target.value.slice(0, 14))
                }
              />
            </label>
          </form>
          <Keypad
            onKey={keypress}
            decimal={cashMode}
            disabled={busy || paid || (panel === 'payment' && !cashMode)}
          />
        </div>
        <Basket sale={sale} change={change} busy={busy || panel === 'payment'} />
      </div>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="message" role="status">
          {notice}
        </div>
      )}
      {paid && sale && (
        <section className="panel subpanel" aria-label="Justificatifs">
          <h2>Justificatifs</h2>
          <div className="actions">
            <button disabled={busy} onClick={() => document('ticket')}>
              Télécharger le ticket
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setShowInvoice(!showInvoice);
              }}
            >
              Facture
            </button>
            <button
              disabled={busy || !sale.loyaltyCode || deliveries.ticket?.status === 'sent'}
              onClick={() => email('ticket')}
            >
              {deliveries.ticket?.status === 'pending'
                ? 'Vérifier l’envoi du ticket'
                : 'Envoyer le ticket'}
            </button>
            {(issued || showInvoice) && (
              <>
                <button disabled={busy} onClick={() => document('invoice')}>
                  Télécharger la facture
                </button>
                <button
                  disabled={busy || !sale.loyaltyCode || deliveries.invoice?.status === 'sent'}
                  onClick={() => email('invoice')}
                >
                  {deliveries.invoice?.status === 'pending'
                    ? 'Vérifier l’envoi de la facture'
                    : 'Envoyer la facture'}
                </button>
              </>
            )}
          </div>
          {showInvoice && !issued && <BillingForm submit={issue} disabled={busy} />}
        </section>
      )}
      {panel === 'payment' && (
        <section className="panel subpanel" aria-label="Paiement">
          <h2>Paiement</h2>
          <div className="actions">
            <button
              aria-pressed={method === 'cash'}
              disabled={busy}
              onClick={() => setMethod('cash')}
            >
              Espèces
            </button>
            <button
              aria-pressed={method === 'card'}
              disabled={busy}
              onClick={() => setMethod('card')}
            >
              Carte (simulation)
            </button>
            <button className="primary" disabled={busy} onClick={pay}>
              Valider le paiement
            </button>
            <button disabled={busy} onClick={() => setPanel(null)}>
              Retour
            </button>
          </div>
        </section>
      )}
      {panel === 'loyalty' && (
        <section className="panel subpanel" aria-label="Carte de fidélité">
          <h2>Carte de fidélité</h2>
          {sale?.loyaltyCode && <p>Carte associée : {sale.loyaltyCode}</p>}
          <form className="inline-form" onSubmit={attach}>
            <label className="field">
              Code de carte
              <input name="code" pattern="[A-Za-z0-9_\x2D]+" maxLength={64} required />
            </label>
            <label className="field">
              E-mail (nouvelle carte)
              <input name="email" type="email" maxLength={254} />
            </label>
            <button disabled={busy}>Associer la carte</button>
            {sale?.loyaltyCode && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setSale(await api.link(sale.id, null));
                    setPanel(null);
                  })
                }
              >
                Détacher
              </button>
            )}
          </form>
        </section>
      )}
      {panel === 'history' && (
        <section className="panel subpanel" aria-label="Ventes récentes">
          <h2>Ventes récentes</h2>
          <ul className="history">
            {recent.map((record) => (
              <li key={record.id}>
                <button
                  disabled={busy}
                  onClick={() => void run(async () => chooseSale(await api.find(record.id)))}
                >
                  {new Date(record.createdAt).toLocaleString('fr-FR')} ·{' '}
                  {record.status === 'paid' ? 'Encaissée' : 'Ouverte'} ·{' '}
                  {displayPrice(record.totals.totalCents)}
                </button>
              </li>
            ))}
          </ul>
          {!recent.length && <p className="muted">Aucune vente enregistrée.</p>}
        </section>
      )}
      <footer className="panel actions command-bar">
        <button
          disabled={busy || paid || panel === 'payment'}
          onClick={() => setPanel(panel === 'loyalty' ? null : 'loyalty')}
        >
          Fidélité
        </button>
        <button
          disabled={busy || panel === 'payment'}
          onClick={() => void run(async () => chooseSale(await api.create()))}
        >
          Nouvelle vente
        </button>
        <button
          disabled={busy || panel === 'payment'}
          onClick={() =>
            void run(async () => {
              if (panel === 'history') setPanel(null);
              else {
                setRecent((await api.recent()).items);
                setPanel('history');
              }
            })
          }
        >
          Ventes récentes
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.logout();
              exit();
            })
          }
        >
          Clôturer la caisse
        </button>
        <button
          className="primary checkout-action"
          disabled={busy || paid || !sale?.lines.length}
          onClick={() => {
            setPanel('payment');
            entryRef.current?.focus();
          }}
        >
          Encaisser {displayPrice(sale?.totals.totalCents ?? 0)}
        </button>
      </footer>
    </main>
  );
}
