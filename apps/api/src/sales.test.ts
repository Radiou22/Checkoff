import { calculate, paymentInput } from '@checkoff/contracts';
import { describe, expect, it } from 'vitest';

import { paymentDecision } from './sales.js';

describe('encaissement', () => {
  it.each([
    [{ method: 'cash', tenderedCents: 1500 }, 1199, true, 301],
    [{ method: 'cash', tenderedCents: 1198 }, 1199, false, 0],
    [{ method: 'card', tenderedCents: 1199 }, 1199, true, 0],
    [{ method: 'card', tenderedCents: 1200 }, 1199, false, 0],
    [{ method: 'card', tenderedCents: 0 }, 0, true, 0],
  ] as const)('valide le mode %j et le montant TTC %i', (input, total, accepted, changeCents) => {
    expect(paymentDecision(input, total)).toEqual({ accepted, changeCents });
  });

  it('refuse les montants non entiers, négatifs ou les propriétés imprévues', () => {
    for (const invalid of [
      { method: 'cash', tenderedCents: 1.2 },
      { method: 'cash', tenderedCents: -1 },
      { method: 'card', tenderedCents: 100, cardNumber: '1234' },
    ])
      expect(paymentInput.safeParse(invalid).success).toBe(false);
  });

  it('arrondit le HT à la ligne et ventile la TVA pour plusieurs taux', () => {
    const common = { brand: 'Checkoff', category: 'Test', name: 'Article' };
    const { totals } = calculate([
      { ...common, gencod: '0234567890123', quantity: 1, unitPriceCents: 390, vatRateBps: 550 },
      { ...common, gencod: '0123456789012', quantity: 2, unitPriceCents: 1199, vatRateBps: 2000 },
    ]);
    expect(totals).toEqual({
      currency: 'EUR',
      itemCount: 3,
      totalCents: 2788,
      netCents: 2368,
      vatCents: 420,
      vatBreakdown: [
        { rateBps: 550, amountCents: 20 },
        { rateBps: 2000, amountCents: 400 },
      ],
    });
  });
});
