-- Append-only history, enforced by the database itself whoever connects (the API, a console, a mistake).
-- OPTIONAL migration: creating triggers needs the TRIGGER privilege and, on servers with binary logging, either SUPER or
-- log_bin_trust_function_creators=1. If the server refuses, `npm run migrate` warns and retries next time.
-- Safe to run repeatedly (each trigger is dropped first).
DROP TRIGGER IF EXISTS trg_ledger_no_update;
CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE ON ledger_transactions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only';
DROP TRIGGER IF EXISTS trg_ledger_no_delete;
CREATE TRIGGER trg_ledger_no_delete BEFORE DELETE ON ledger_transactions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only';
DROP TRIGGER IF EXISTS trg_audit_no_update;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
DROP TRIGGER IF EXISTS trg_audit_no_delete;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
DROP TRIGGER IF EXISTS trg_events_no_update;
CREATE TRIGGER trg_events_no_update BEFORE UPDATE ON order_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'order_events is append-only';
DROP TRIGGER IF EXISTS trg_events_no_delete;
CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON order_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'order_events is append-only';
DROP TRIGGER IF EXISTS trg_stock_no_update;
CREATE TRIGGER trg_stock_no_update BEFORE UPDATE ON stock_movements FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_movements is append-only';
DROP TRIGGER IF EXISTS trg_stock_no_delete;
CREATE TRIGGER trg_stock_no_delete BEFORE DELETE ON stock_movements FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_movements is append-only';
