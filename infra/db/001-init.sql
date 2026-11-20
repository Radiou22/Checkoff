CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL UNIQUE,
    role text NOT NULL CHECK (role IN ('admin', 'cashier')),
    active boolean NOT NULL DEFAULT true,
    salt bytea NOT NULL,
    password_hash bytea NOT NULL
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts,
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE catalog (
    gencod text PRIMARY KEY CHECK (gencod ~ '^[0-9]{8,14}$'),
    name text NOT NULL,
    brand text NOT NULL,
    category text NOT NULL,
    unit_price_cents integer NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 10000000),
    vat_rate_bps integer NOT NULL CHECK (vat_rate_bps BETWEEN 0 AND 10000)
);
CREATE TABLE catalog_revision (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision bigint NOT NULL DEFAULT 0
);
INSERT INTO catalog_revision DEFAULT VALUES;

CREATE TABLE inventory (
    gencod text PRIMARY KEY REFERENCES catalog,
    on_hand integer NOT NULL CHECK (on_hand >= 0)
);

CREATE TABLE loyalty_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE,
    email text NOT NULL
);

CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cashier_id uuid NOT NULL REFERENCES accounts,
    loyalty_id uuid REFERENCES loyalty_cards ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz,
    seller jsonb
);
CREATE INDEX sales_recent ON sales (created_at DESC, id DESC);
CREATE INDEX sales_cashier_recent ON sales (cashier_id, created_at DESC, id DESC);
CREATE INDEX sales_loyalty ON sales (loyalty_id);

CREATE TABLE sale_lines (
    sale_id uuid NOT NULL REFERENCES sales,
    gencod text NOT NULL REFERENCES catalog,
    name text NOT NULL,
    brand text NOT NULL,
    category text NOT NULL,
    unit_price_cents integer NOT NULL,
    vat_rate_bps integer NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
    PRIMARY KEY (sale_id, gencod)
);

CREATE TABLE payment_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id uuid NOT NULL REFERENCES sales,
    method text NOT NULL CHECK (method IN ('cash', 'card')),
    amount_cents integer NOT NULL CHECK (amount_cents >= 0),
    tendered_cents integer NOT NULL CHECK (tendered_cents >= 0),
    change_cents integer NOT NULL CHECK (change_cents >= 0),
    accepted boolean NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_accepted_payment ON payment_attempts (sale_id) WHERE accepted;
CREATE INDEX attempts_sale ON payment_attempts (sale_id, processed_at);

CREATE TABLE invoices (
    sale_id uuid PRIMARY KEY REFERENCES sales,
    number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
    name text NOT NULL,
    address text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id uuid NOT NULL REFERENCES sales,
    type text NOT NULL CHECK (type IN ('invoice', 'ticket')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    generation integer NOT NULL DEFAULT 1,
    attempts integer NOT NULL DEFAULT 0,
    dispatch_after timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    last_error text,
    worker_instance text,
    UNIQUE (sale_id, type)
);
CREATE INDEX deliveries_dispatch ON deliveries (dispatch_after, id) WHERE status = 'pending';

INSERT INTO catalog VALUES
    ('3760123456789', 'Pommes Pink Lady', 'Verger', 'Fruits', 240, 550),
    ('3760123456796', 'Pain de campagne', 'Boulangerie', 'Boulangerie', 390, 550),
    ('3760123456802', 'Lait demi-écrémé', 'Laiterie', 'Produits frais', 160, 550),
    ('3760123456819', 'Jus d’orange', 'Verger', 'Boissons', 320, 550);

INSERT INTO inventory (gencod, on_hand) SELECT gencod, 30 FROM catalog;
