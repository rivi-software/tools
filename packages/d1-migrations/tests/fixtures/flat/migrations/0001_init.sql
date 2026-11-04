-- Customers; a comment with a semicolon; in it.
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT DEFAULT 'it''s; fine' -- a quote and a semicolon in a string
);

/* A block comment; with a semicolon,
   over two lines. */
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status TEXT NOT NULL DEFAULT 'new',
  total INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX orders_by_customer ON orders (customer_id);
