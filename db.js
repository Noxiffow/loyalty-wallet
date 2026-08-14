const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'loyalty.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT    NOT NULL,
    phone TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cards (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id        INTEGER NOT NULL REFERENCES clients(id),
    stamps           INTEGER NOT NULL DEFAULT 0,
    google_object_id TEXT    UNIQUE,
    apple_serial     TEXT    UNIQUE,
    enrollment_token TEXT    UNIQUE NOT NULL,
    enrolled_at      TEXT,
    vip_expiry       TEXT,
    last_alisado     TEXT,
    prize_pending    INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stamp_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id       INTEGER NOT NULL REFERENCES cards(id),
    service_type  TEXT    NOT NULL CHECK(service_type IN ('alisado', 'otro')),
    notes         TEXT,
    stamps_before INTEGER NOT NULL,
    stamps_after  INTEGER NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_card_id    INTEGER NOT NULL REFERENCES cards(id),
    referred_client_id  INTEGER NOT NULL REFERENCES clients(id),
    created_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS apple_registrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT    NOT NULL,
    push_token  TEXT    NOT NULL,
    card_id     INTEGER NOT NULL REFERENCES cards(id),
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(device_id, card_id)
  );
`);

// ─── Migrations ───────────────────────────────────────────────────────────────
try { db.exec(`ALTER TABLE referrals ADD COLUMN credited     INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE referrals ADD COLUMN credited_at  TEXT`); } catch {}
try { db.exec(`ALTER TABLE cards ADD COLUMN reminder_sent_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE cards ADD COLUMN pass_expired INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE clients ADD COLUMN phone_normalized TEXT`); } catch {}
try { db.exec(`UPDATE clients SET phone_normalized = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'+34',''),'0034','') WHERE phone_normalized IS NULL`); } catch {}
try { db.exec(`ALTER TABLE clients ADD COLUMN consent_at TEXT`); } catch {}

// ─── Queries ──────────────────────────────────────────────────────────────────

const q = {
  // Clients
  createClient: db.prepare(
    `INSERT INTO clients (name, phone, email, phone_normalized, consent_at)
     VALUES (?, ?, ?, ?, datetime('now')) RETURNING *`
  ),
  getClientByNormalizedPhone: db.prepare(
    `SELECT c.*, ca.id AS card_id, ca.enrollment_token
     FROM clients c LEFT JOIN cards ca ON ca.client_id = c.id
     WHERE c.phone_normalized = ? LIMIT 1`
  ),
  searchClients: db.prepare(
    `SELECT c.*, ca.id AS card_id, ca.stamps, ca.prize_pending, ca.vip_expiry, ca.enrollment_token
     FROM clients c LEFT JOIN cards ca ON ca.client_id = c.id
     WHERE c.name LIKE ? OR c.phone LIKE ?
     ORDER BY c.created_at DESC LIMIT 30`
  ),
  getClient: db.prepare(
    `SELECT c.*, ca.id AS card_id, ca.stamps, ca.prize_pending, ca.vip_expiry,
            ca.last_alisado, ca.google_object_id, ca.apple_serial,
            ca.enrollment_token, ca.enrolled_at
     FROM clients c LEFT JOIN cards ca ON ca.client_id = c.id
     WHERE c.id = ?`
  ),

  // Cards
  createCard: db.prepare(
    `INSERT INTO cards (client_id, enrollment_token) VALUES (?, ?) RETURNING *`
  ),
  getCardById: db.prepare(
    `SELECT ca.*, c.name AS client_name, c.phone AS client_phone
     FROM cards ca JOIN clients c ON c.id = ca.client_id
     WHERE ca.id = ?`
  ),
  getCardByToken: db.prepare(
    `SELECT ca.*, c.name AS client_name
     FROM cards ca JOIN clients c ON c.id = ca.client_id
     WHERE ca.enrollment_token = ?`
  ),
  getCardBySerial: db.prepare(
    `SELECT ca.*, c.name AS client_name
     FROM cards ca JOIN clients c ON c.id = ca.client_id
     WHERE ca.apple_serial = ?`
  ),
  setGoogleObjectId: db.prepare(
    `UPDATE cards SET google_object_id = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  setAppleSerial: db.prepare(
    `UPDATE cards SET apple_serial = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  markEnrolled: db.prepare(
    `UPDATE cards SET enrolled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ),
  updateStamps: db.prepare(
    `UPDATE cards
     SET stamps = ?, last_alisado = COALESCE(?, last_alisado),
         vip_expiry = COALESCE(?, vip_expiry),
         pass_expired = CASE WHEN ? IS NOT NULL THEN 0 ELSE pass_expired END,
         prize_pending = ?, updated_at = datetime('now')
     WHERE id = ?`
  ),
  resetCard: db.prepare(
    `UPDATE cards
     SET stamps = 0, prize_pending = 0, updated_at = datetime('now')
     WHERE id = ?`
  ),

  // Stamp events
  addStampEvent: db.prepare(
    `INSERT INTO stamp_events (card_id, service_type, notes, stamps_before, stamps_after)
     VALUES (?, ?, ?, ?, ?)`
  ),
  getStampHistory: db.prepare(
    `SELECT * FROM stamp_events WHERE card_id = ? ORDER BY created_at DESC LIMIT 20`
  ),

  // Referrals
  addReferral: db.prepare(
    `INSERT INTO referrals (referrer_card_id, referred_client_id, credited) VALUES (?, ?, ?)`
  ),
  getPendingReferralByCard: db.prepare(
    `SELECT r.*, c.name AS referrer_name
     FROM referrals r
     JOIN cards rc ON rc.id = r.referrer_card_id
     JOIN clients c ON c.id = rc.client_id
     WHERE r.referred_client_id = (SELECT client_id FROM cards WHERE id = ?)
       AND r.credited = 0
     LIMIT 1`
  ),
  creditReferral: db.prepare(
    `UPDATE referrals SET credited = 1, credited_at = datetime('now') WHERE id = ?`
  ),
  getReferrerByToken: db.prepare(
    `SELECT ca.id AS card_id, ca.enrollment_token, c.name AS referrer_name
     FROM cards ca JOIN clients c ON c.id = ca.client_id
     WHERE ca.enrollment_token = ?`
  ),

  // Pass expiry
  getExpiredCards: db.prepare(
    `SELECT ca.*, c.name AS client_name
     FROM cards ca JOIN clients c ON c.id = ca.client_id
     WHERE ca.vip_expiry < date('now')
       AND ca.pass_expired = 0
       AND (ca.google_object_id IS NOT NULL OR ca.apple_serial IS NOT NULL)`
  ),
  markPassExpired: db.prepare(`UPDATE cards SET pass_expired = 1 WHERE id = ?`),
  markPassActive:  db.prepare(`UPDATE cards SET pass_expired = 0 WHERE id = ?`),

  // Reminder emails
  getCardsNeedingReminder: db.prepare(
    `SELECT ca.*, c.name AS client_name, c.email AS client_email
     FROM cards ca JOIN clients c ON c.id = ca.client_id
     WHERE ca.vip_expiry BETWEEN date('now', '+55 days') AND date('now', '+65 days')
       AND ca.reminder_sent_at IS NULL
       AND c.email IS NOT NULL AND c.email != ''`
  ),
  markReminderSent: db.prepare(
    `UPDATE cards SET reminder_sent_at = date('now') WHERE id = ?`
  ),
  resetReminder: db.prepare(
    `UPDATE cards SET reminder_sent_at = NULL WHERE id = ?`
  ),

  // Delete client (cascade)
  deleteAppleRegsByCard: db.prepare(`DELETE FROM apple_registrations WHERE card_id = ?`),
  deleteStampEvents:     db.prepare(`DELETE FROM stamp_events WHERE card_id = ?`),
  deleteReferralsByCard: db.prepare(`DELETE FROM referrals WHERE referrer_card_id = ? OR referred_client_id IN (SELECT id FROM clients WHERE id = ?)`),
  deleteCard:            db.prepare(`DELETE FROM cards WHERE client_id = ?`),
  deleteClient:          db.prepare(`DELETE FROM clients WHERE id = ?`),

  // Apple registrations
  upsertAppleReg: db.prepare(
    `INSERT INTO apple_registrations (device_id, push_token, card_id)
     VALUES (?, ?, ?)
     ON CONFLICT(device_id, card_id) DO UPDATE SET push_token = excluded.push_token`
  ),
  deleteAppleReg: db.prepare(
    `DELETE FROM apple_registrations WHERE device_id = ? AND card_id = ?`
  ),
  getAppleRegs: db.prepare(
    `SELECT * FROM apple_registrations WHERE card_id = ?`
  ),
  getCardsUpdatedSince: db.prepare(
    `SELECT ca.apple_serial FROM cards ca
     JOIN apple_registrations ar ON ar.card_id = ca.id
     WHERE ar.device_id = ? AND datetime(ca.updated_at) > datetime(?)`
  ),
};

module.exports = { db, q };
