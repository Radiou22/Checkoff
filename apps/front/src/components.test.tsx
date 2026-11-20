import { calculate } from '@checkoff/contracts';
import type { Article, Sale } from '@checkoff/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Basket, Catalog, Keypad, LoginForm, tenderedCents } from './components.js';

const apples: Article = {
  gencod: '0000123456789',
  name: 'Pommes Pink Lady',
  unitPriceCents: 240,
  vatRateBps: 550,
  brand: 'Verger',
  category: 'Fruits',
};
const bread: Article = {
  ...apples,
  gencod: '0000123456796',
  name: 'Pain de campagne',
  category: 'Boulangerie',
};
const date = new Date().toISOString();
const sale: Sale = {
  id: 'a',
  cashierId: 'b',
  createdAt: date,
  status: 'open',
  loyaltyCode: null,
  paidAt: null,
  payment: null,
  ...calculate([{ ...apples, quantity: 2 }]),
};

afterEach(cleanup);

describe('interface caisse', () => {
  it('recherche avec ou sans accent et permet le choix manuel', () => {
    const pick = vi.fn();
    render(
      <Catalog items={[apples, { ...bread, name: 'Pain doré' }]} choose={pick} disabled={false} />,
    );
    fireEvent.change(screen.getByLabelText('Rechercher un article'), {
      target: { value: 'pain dore' },
    });
    expect(screen.queryByRole('button', { name: /Pommes/u })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Pain doré/u }));
    expect(pick).toHaveBeenCalledOnce();
  });

  it('transmet les touches de validation et effacement et réserve le point au paiement', () => {
    const key = vi.fn();
    const { rerender } = render(<Keypad onKey={key} decimal={false} disabled={false} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '.' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Effacer le dernier chiffre' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entrée' }));
    expect(key.mock.calls).toEqual([['00'], ['⌫'], ['Entrée']]);
    rerender(<Keypad onKey={key} decimal disabled={false} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '.' }).disabled).toBe(false);
  });

  it('affiche le TTC et bloque les mutations d’une vente payée', () => {
    const change = vi.fn();
    const { rerender } = render(<Basket sale={sale} change={change} busy={false} />);
    expect(screen.getAllByText(/4,80/u)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retirer un Pommes Pink Lady' }));
    expect(change).toHaveBeenCalledWith(apples.gencod, 1);
    rerender(<Basket sale={{ ...sale, status: 'paid' }} change={change} busy={false} />);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Ajouter un Pommes Pink Lady' })
        .disabled,
    ).toBe(true);
  });

  it('soumet les identifiants et affiche une erreur métier', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('Identifiants incorrects.'));
    render(<LoginForm onLogin={connect} />);
    fireEvent.change(screen.getByLabelText('Identifiant'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'bad-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Identifiants incorrects.');
    expect(connect).toHaveBeenCalledWith('admin', 'bad-password');
  });

  it.each([
    ['10,30', 1030],
    ['0.01', 1],
    ['12', 1200],
    ['10,109', null],
    ['1e2', null],
    ['-5', null],
  ])('convertit la saisie espèces %s sans arrondi flottant', (input, expected) => {
    expect(tenderedCents(input)).toBe(expected);
  });
});
