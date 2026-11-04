INSERT INTO customers (id, name) VALUES (1, 'Ada; Lovelace'), (2, '"Grace" Hopper');
INSERT INTO orders (id, customer_id, status) VALUES (1, 1, 'new');
UPDATE orders SET status = 'paid' WHERE id = 1;
-- The trigger has logged the payment.
