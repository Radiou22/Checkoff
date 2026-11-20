import { calculate } from '@checkoff/contracts';
import type { Article, Delivery, Sale } from '@checkoff/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { App } from './app.js';

const userId = 'de305d54-75b4-431b-adb2-eb6b9e546014';
const saleId = '6e17c002-fd9d-4271-8204-a19aad5813bc';
const deliveryId = '4f211367-807d-4f47-8b1d-40c174af441e';
const date = '2026-11-20T10:00:00.000Z';
const item: Article = {
  gencod: '3760123456789',
  name: 'Pommes Pink Lady',
  category: 'Fruits',
  brand: 'Verger',
  unitPriceCents: 240,
  vatRateBps: 550,
};

function session() {
  return {
    token: 'checkout-jwt',
    user: { id: userId, username: 'admin', role: 'admin' },
    expiresAt: date,
  };
}

function emptySale(): Sale {
  return {
    id: saleId,
    cashierId: userId,
    createdAt: date,
    paidAt: null,
    status: 'open',
    loyaltyCode: null,
    payment: null,
    ...calculate([]),
  };
}

function signIn() {
  fireEvent.change(screen.getByLabelText('Identifiant'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'test-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('encaisse un article scanné et suit la file du ticket après une erreur de paiement', async () => {
  let current = emptySale();
  const pending: Delivery = {
    id: deliveryId,
    status: 'pending',
    attempts: 0,
    sentAt: null,
    lastError: null,
    workerInstance: null,
  };
  const checkout = '/api/checkouts/' + saleId;
  const calls: string[] = [];
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method || 'GET';
    calls.push(method + ' ' + path);
    if (path === '/api/auth/login') return Response.json(session(), { status: 201 });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer checkout-jwt');
    const input =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === '/api/articles') return Response.json({ items: [item], nextAfter: null });
    if (path === '/api/articles/' + item.gencod) return Response.json(item);
    if (path === '/api/checkouts' && method === 'GET')
      return Response.json({ items: [], nextAfter: null });
    if (path === '/api/checkouts' && method === 'POST')
      return Response.json(current, { status: 201 });
    if (path === checkout + '/lines/' + item.gencod) {
      expect(input).toEqual({ quantity: 1 });
      current = { ...current, ...calculate([{ ...item, quantity: 1 }]) };
      return Response.json(current);
    }
    if (path === '/api/loyalty-cards') {
      expect(input).toEqual({ code: 'DEMO-24', email: 'client@example.test' });
      return Response.json({ code: 'DEMO-24' }, { status: 201 });
    }
    if (path === checkout + '/loyalty-card') {
      expect(input).toEqual({ code: 'DEMO-24' });
      current = { ...current, loyaltyCode: 'DEMO-24' };
      return Response.json(current);
    }
    if (path === checkout + '/finalize') {
      if (input.tenderedCents === 100) {
        return Response.json(
          { error: { code: 'payment_declined', message: 'Montant insuffisant.' } },
          { status: 422 },
        );
      }
      expect(input).toEqual({ method: 'cash', tenderedCents: 300 });
      current = {
        ...current,
        status: 'paid',
        paidAt: date,
        payment: {
          method: 'cash',
          amountCents: 240,
          tenderedCents: 300,
          changeCents: 60,
          processedAt: date,
        },
      };
      return Response.json(current);
    }
    if (path === checkout + '/documents/ticket/email') {
      if (method === 'POST') return Response.json(pending, { status: 202 });
      return Response.json({
        ...pending,
        status: 'sent',
        attempts: 1,
        sentAt: date,
        workerInstance: 'worker-1',
      });
    }
    if (path === checkout + '/invoice') {
      expect(input).toEqual({ name: 'Client Test', address: 'Paris' });
      return Response.json({
        saleId,
        number: 1,
        name: 'Client Test',
        address: 'Paris',
        issuedAt: date,
      });
    }
    throw new Error('Unexpected request: ' + path);
  });
  vi.stubGlobal('fetch', request);
  render(<App />);
  signIn();

  const scanner = await screen.findByLabelText('Saisie du code-barres');
  fireEvent.change(scanner, { target: { value: item.gencod } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrée' }));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /Encaisser 2,40/u }).disabled,
    ).toBe(false),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Fidélité' }));
  fireEvent.change(screen.getByLabelText('Code de carte'), { target: { value: 'DEMO-24' } });
  fireEvent.change(screen.getByLabelText('E-mail (nouvelle carte)'), {
    target: { value: 'client@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Associer la carte' }));
  expect((await screen.findByRole('status')).textContent).toMatch(/associée/u);

  fireEvent.click(screen.getByRole('button', { name: /Encaisser 2,40/u }));
  const amount = screen.getByLabelText('Montant reçu en espèces (€)');
  fireEvent.change(amount, { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Valider le paiement' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Montant insuffisant.');
  fireEvent.click(screen.getByRole('button', { name: 'Vider la saisie' }));
  fireEvent.click(screen.getByRole('button', { name: '3' }));
  fireEvent.click(screen.getByRole('button', { name: '.' }));
  fireEvent.click(screen.getByRole('button', { name: '00' }));
  fireEvent.click(screen.getByRole('button', { name: 'Entrée' }));
  expect((await screen.findByRole('status')).textContent).toMatch(/Monnaie à rendre.*0,60/u);

  fireEvent.click(screen.getByRole('button', { name: 'Envoyer le ticket' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Vérifier l’envoi du ticket' }));
  expect((await screen.findByRole('status')).textContent).toBe('Justificatif envoyé.');

  fireEvent.click(screen.getByRole('button', { name: 'Facture' }));
  fireEvent.change(screen.getByLabelText('Nom du client'), { target: { value: 'Client Test' } });
  fireEvent.change(screen.getByLabelText('Adresse de facturation'), { target: { value: 'Paris' } });
  fireEvent.click(screen.getByRole('button', { name: 'Émettre la facture' }));
  expect((await screen.findByRole('status')).textContent).toBe('Facture émise.');
  expect(calls).toContain('PUT ' + checkout + '/invoice');
});

it('reprend un panier ouvert et clôture la session', async () => {
  const current = { ...emptySale(), ...calculate([{ ...item, quantity: 2 }]) };
  const { lines: _lines, ...summary } = current;
  const request = vi.fn(async (path: string): Promise<Response> => {
    if (path === '/api/auth/login') return Response.json(session(), { status: 201 });
    if (path === '/api/articles') return Response.json({ items: [item], nextAfter: null });
    if (path === '/api/checkouts') return Response.json({ items: [summary], nextAfter: null });
    if (path === '/api/checkouts/' + saleId) return Response.json(current);
    if (path === '/api/auth/logout') return new Response(null, { status: 204 });
    throw new Error('Unexpected request: ' + path);
  });
  vi.stubGlobal('fetch', request);
  render(<App />);
  signIn();
  expect(await screen.findByRole('button', { name: /Encaisser 4,80/u })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Ventes récentes' }));
  expect(await screen.findByRole('region', { name: 'Ventes récentes' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clôturer la caisse' }));
  expect(await screen.findByRole('heading', { name: 'Connexion à la caisse' })).toBeTruthy();
});
