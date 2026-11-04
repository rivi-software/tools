CREATE TABLE order_log (
  order_id INTEGER NOT NULL,
  message TEXT NOT NULL
);

CREATE TRIGGER orders_log_status AFTER UPDATE OF status ON orders
BEGIN
  INSERT INTO order_log (order_id, message)
  VALUES (NEW.id, CASE NEW.status WHEN 'paid' THEN 'paid; thanks' ELSE 'now ' || NEW.status END);
  UPDATE orders SET total = total WHERE id = NEW.id;
END;

CREATE VIEW open_orders AS SELECT * FROM orders WHERE status <> 'done';
