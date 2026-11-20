import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import { appFor, HttpError, invalid, object, string, uuid } from '../http.js';

const money = cents => (cents / 100).toFixed(2).replace('.', ',') + ' EUR';
const percent = rate => String(rate / 100).replace('.', ',') + ' %';

export function billingDetails(value) {
  const { name, address } = object(value);
  return { name: string(name, 'name'), address: string(address, 'address', { max: 240 }) };
}

function renderPdf(sale, type, invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: type === 'ticket' ? 'Ticket de caisse' : 'Facture' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(22).text(type === 'ticket' ? 'Ticket de caisse' : `Facture ${invoice.number}`);
    doc.moveDown(0.4).fontSize(11).text(sale.seller.name);
    if (sale.seller.address) doc.text(sale.seller.address);
    if (sale.seller.taxId) doc.text(`Identifiant fiscal : ${sale.seller.taxId}`);
    doc.text(`Vente : ${sale.id}`);
    doc.text(`Paiement : ${sale.paidAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`);
    if (invoice) {
      doc.text(`Émission : ${invoice.issuedAt.slice(0, 10)}`);
      doc.moveDown(0.5).text('Facturé à').text(invoice.name).text(invoice.address);
    }

    doc.moveDown();
    for (const line of sale.lines) {
      if (doc.y > 710) doc.addPage();
      doc.font('Helvetica-Bold').text(line.name);
      doc.font('Helvetica').text(
        `${line.gencod}  |  ${line.quantity} × ${money(line.unitPriceCents)}  |  TVA ${percent(line.vatRateBps)}  |  ${money(line.totalCents)}`
      );
      doc.moveDown(0.4);
    }

    if (doc.y > 650) doc.addPage();
    doc.moveDown(0.6);
    doc.text(`Total HT : ${money(sale.totals.netCents)}`);
    for (const tax of sale.totals.vatBreakdown) {
      doc.text(`TVA ${percent(tax.rateBps)} : ${money(tax.amountCents)}`);
    }
    doc.font('Helvetica-Bold').text(`Total TTC : ${money(sale.totals.totalCents)}`);
    doc.font('Helvetica').text(`Mode : ${sale.payment.method === 'cash' ? 'Espèces' : 'Carte (simulation)'}`);
    if (sale.payment.method === 'cash') doc.text(`Monnaie rendue : ${money(sale.payment.changeCents)}`);
    doc.end();
  });
}

export function receiptService(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      saleId TEXT PRIMARY KEY,
      snapshot TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS invoices (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      saleId TEXT NOT NULL UNIQUE REFERENCES receipts(saleId),
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      issuedAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS deliveries (
      saleId TEXT NOT NULL REFERENCES receipts(saleId),
      type TEXT NOT NULL,
      sentAt TEXT NOT NULL,
      PRIMARY KEY (saleId, type)
    ) STRICT;
  `);
  const app = appFor('ReceiptManager', config.internalToken);
  const find = db.prepare('SELECT * FROM receipts WHERE saleId = ?');
  const findInvoice = db.prepare('SELECT * FROM invoices WHERE saleId = ?');
  const findDelivery = db.prepare('SELECT sentAt FROM deliveries WHERE saleId = ? AND type = ?');
  const sending = new Set();
  const mailer = config.smtpUrl && config.mailFrom && nodemailer.createTransport(config.smtpUrl, {
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const transport = config.sendMail ?? (mailer && (message => mailer.sendMail(message)));

  function documentFor(id, type) {
    if (type !== 'ticket' && type !== 'invoice') invalid('type');
    const receipt = find.get(id);
    if (!receipt) throw new HttpError(404, 'receipt_not_found', 'Justificatif inconnu.');
    const invoice = type === 'invoice' ? findInvoice.get(id) : null;
    if (type === 'invoice' && !invoice) throw new HttpError(404, 'invoice_not_found', 'Facture inconnue.');
    return { sale: JSON.parse(receipt.snapshot), invoice, filename: `${type}-${id}.pdf` };
  }

  app.put('/receipts/:id', (req, res) => {
    const id = uuid(req.params.id);
    const sale = object(req.body);
    if (sale.id !== id || sale.status !== 'paid') invalid('vente');
    const seller = { name: config.storeName, address: config.storeAddress, taxId: config.storeTaxId };
    db.prepare('INSERT OR IGNORE INTO receipts VALUES (?, ?)').run(id, JSON.stringify({ ...sale, seller }));
    res.json({ id });
  });

  app.put('/receipts/:id/invoice', (req, res) => {
    const id = uuid(req.params.id);
    documentFor(id, 'ticket');
    const billTo = billingDetails(req.body);
    const existing = findInvoice.get(id);
    if (existing) {
      if (existing.name !== billTo.name || existing.address !== billTo.address) {
        throw new HttpError(409, 'invoice_exists', 'Une facture a déjà été émise pour cette vente.');
      }
      return res.json(existing);
    }
    db.prepare('INSERT INTO invoices (saleId, name, address, issuedAt) VALUES (?, ?, ?, ?)')
      .run(id, billTo.name, billTo.address, new Date().toISOString());
    return res.json(findInvoice.get(id));
  });

  app.get('/receipts/:id/pdf/:type', async (req, res) => {
    const { type } = req.params;
    const { sale, invoice, filename } = documentFor(uuid(req.params.id), type);
    res.type('pdf').attachment(filename).send(await renderPdf(sale, type, invoice));
  });

  app.post('/receipts/:id/email/:type', async (req, res) => {
    const id = uuid(req.params.id);
    const { type } = req.params;
    const { sale, invoice, filename } = documentFor(id, type);
    const previous = findDelivery.get(id, type);
    if (previous) return res.json(previous);
    if (!transport) throw new HttpError(503, 'email_unavailable', 'L’envoi par mail est indisponible.');
    const to = string(object(req.body).email, 'email', { max: 254 });
    const key = id + '/' + type;
    if (sending.has(key)) throw new HttpError(409, 'email_in_progress', 'L’envoi est en cours.');

    sending.add(key);
    try {
      const pdf = await renderPdf(sale, type, invoice);
      try {
        const title = type === 'ticket' ? 'Votre ticket de caisse' : 'Votre facture';
        const result = await transport({
          from: config.mailFrom,
          to,
          subject: title,
          text: `${title} est disponible en pièce jointe.`,
          attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
        });
        if (result?.accepted?.length === 0) throw new Error('SMTP recipient rejected');
      } catch {
        throw new HttpError(502, 'email_failed', 'Le serveur mail n’a pas accepté le justificatif.');
      }
      const sentAt = new Date().toISOString();
      db.prepare('INSERT INTO deliveries VALUES (?, ?, ?)').run(id, type, sentAt);
      return res.json({ sentAt });
    } finally {
      sending.delete(key);
    }
  });

  return app;
}
