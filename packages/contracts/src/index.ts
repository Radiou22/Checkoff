import { z } from 'zod';

export const uuid = z.uuid();
export const gencod = z.string().regex(/^\d{8,14}$/);
export const code = z.string().regex(/^[\w-]{1,64}$/);
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
export const role = z.enum(['admin', 'cashier']);
export const name = z.string().trim().min(1).max(120);
export const cents = z.int().min(0).max(1_000_000_000);
export const documentType = z.enum(['ticket', 'invoice']);
const date = z.iso.datetime();
const email = z.email().max(254);

export const login = z.strictObject({ username, password: z.string().min(1).max(128) });
export const userInput = login.extend({
  role: role.default('cashier'),
  password: z.string().min(12).max(128),
});
export const userState = z.strictObject({ active: z.boolean() });
export const user = z.object({ id: uuid, username, role, active: z.boolean().optional() });
export const session = z.object({ token: z.string(), expiresAt: date, user });

export const articleFields = z.strictObject({
  name,
  brand: name,
  category: name,
  unitPriceCents: cents.max(10_000_000),
  vatRateBps: z.int().min(0).max(10_000),
});
export const article = articleFields.extend({ gencod });
export const articlePatch = articleFields.partial();
export const stockInput = z.strictObject({ onHand: z.int().min(0).max(1_000_000_000) });
export const stock = stockInput.extend({
  gencod,
  reserved: z.literal(0),
  available: z.int().min(0),
});
export const quantityInput = z.strictObject({ quantity: z.int().min(1).max(10_000) });
export const loyaltyInput = z.strictObject({ code, email });
export const loyaltyUpdate = z.strictObject({ email });
export const loyaltyLink = z.strictObject({ code: code.nullable() });
export const loyaltyResult = z.object({ code });
export const paymentInput = z.strictObject({
  method: z.enum(['cash', 'card']),
  tenderedCents: cents,
});
export const payment = paymentInput.extend({
  changeCents: cents,
  amountCents: cents,
  processedAt: date,
});
export const billingDetails = z.strictObject({ name, address: z.string().trim().min(1).max(240) });
export const invoice = billingDetails.extend({
  saleId: uuid,
  number: z.int().positive(),
  issuedAt: date,
});

export const line = article.extend({
  quantity: quantityInput.shape.quantity,
  netCents: cents,
  vatCents: cents,
  totalCents: cents,
});
export const totals = z.object({
  currency: z.literal('EUR'),
  itemCount: z.int(),
  netCents: cents,
  vatCents: cents,
  totalCents: cents,
  vatBreakdown: z.array(z.object({ rateBps: z.int(), amountCents: cents })),
});
export const saleSummary = z.object({
  id: uuid,
  cashierId: uuid,
  status: z.enum(['open', 'paid']),
  createdAt: date,
  paidAt: date.nullable(),
  loyaltyCode: code.nullable(),
  totals,
  payment: payment.nullable(),
});
export const sale = saleSummary.extend({ lines: z.array(line) });

export const seller = z.object({ name, address: z.string(), taxId: z.string() });
export const receipt = z.object({ sale, type: documentType, invoice: invoice.nullable(), seller });
export const delivery = z.object({
  id: uuid,
  status: z.enum(['pending', 'sent', 'failed']),
  attempts: z.int(),
  sentAt: date.nullable(),
  lastError: z.string().nullable(),
  workerInstance: z.string().nullable(),
});
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextAfter: z.string().nullable() });
export const queryCursor = <T extends z.ZodType>(cursor: T) =>
  z.object({ after: cursor.optional() });
export const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export type Article = z.infer<typeof article>;
export type BillingDetails = z.infer<typeof billingDetails>;
export type Delivery = z.infer<typeof delivery>;
export type DocumentType = z.infer<typeof documentType>;
export type Invoice = z.infer<typeof invoice>;
export type PaymentInput = z.infer<typeof paymentInput>;
export type Receipt = z.infer<typeof receipt>;
export type Sale = z.infer<typeof sale>;
export type SaleSummary = z.infer<typeof saleSummary>;
export type User = z.infer<typeof user>;

export function calculate(
  lines: ReadonlyArray<Article & { quantity: number }>,
): Pick<Sale, 'lines' | 'totals'> {
  const taxes = new Map<number, number>();
  let totalCents = 0;
  let netCents = 0;
  let itemCount = 0;
  const priced = lines.map((item) => {
    const gross = item.quantity * item.unitPriceCents;
    const divisor = 10_000 + item.vatRateBps;
    const net = Math.floor((gross * 10_000 + Math.floor(divisor / 2)) / divisor);
    const vat = gross - net;
    taxes.set(item.vatRateBps, (taxes.get(item.vatRateBps) ?? 0) + vat);
    totalCents += gross;
    netCents += net;
    itemCount += item.quantity;
    return { ...item, totalCents: gross, netCents: net, vatCents: vat };
  });
  const vatBreakdown = [...taxes.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rateBps, amountCents]) => ({ rateBps, amountCents }));
  return {
    lines: priced,
    totals: {
      currency: 'EUR',
      itemCount,
      netCents,
      vatCents: totalCents - netCents,
      totalCents,
      vatBreakdown,
    },
  };
}

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
