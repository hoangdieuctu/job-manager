'use strict';

// Uses Node.js built-in SQLite (node:sqlite) — no native addon needed.
// Requires Node >= 22.5.0. Suppress experimental warning with NODE_NO_WARNINGS=1.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'jobs.db');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations();
  }
  return db;
}

// ── Migrations ────────────────────────────────────────────────────────────────
// Each entry is { id, description, up }.
// - id must be unique and monotonically increasing (use integers).
// - up() runs inside a transaction; throw to abort.
// - Never edit or delete an existing migration — only append new ones.
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATIONS = [
  {
    id: 1,
    description: 'Initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          company TEXT NOT NULL DEFAULT '',
          description TEXT,
          responsibilities TEXT,
          qualifications TEXT,
          jd_filename TEXT,
          jd_original_name TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'screening', 'closed')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          email TEXT,
          cv_filename TEXT,
          cv_original_name TEXT,
          cv_text TEXT,
          status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'reviewing', 'approved', 'rejected')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ai_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
          match_score INTEGER,
          strengths TEXT,
          gaps TEXT,
          red_flags TEXT,
          summary TEXT,
          work_experience TEXT,
          warnings TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
          note TEXT NOT NULL,
          recommendation TEXT CHECK(recommendation IN ('hire', 'reject', 'hold', NULL)),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS warning_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: 2,
    description: 'Seed default config values',
    up(db) {
      const defaults = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
        REVIEW_MODEL: 'claude-opus-4-6',
        EXTRACTION_MODEL: 'claude-haiku-4-5-20251001',
      };
      const insert = db.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`);
      for (const [k, v] of Object.entries(defaults)) insert.run(k, v);
    },
  },
  {
    id: 3,
    description: 'Fix candidates CHECK constraint: replace shortlisted with approved',
    up(db) {
      // Recreate candidates table with corrected CHECK constraint
      db.exec(`PRAGMA foreign_keys = OFF`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS candidates_v3 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          email TEXT,
          cv_filename TEXT,
          cv_original_name TEXT,
          cv_text TEXT,
          status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'reviewing', 'approved', 'rejected')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      // Copy rows, remapping shortlisted → approved
      db.exec(`
        INSERT INTO candidates_v3
        SELECT id, job_id, name, email, cv_filename, cv_original_name, cv_text,
          CASE WHEN status = 'shortlisted' THEN 'approved' ELSE status END,
          created_at, updated_at
        FROM candidates;
      `);
      db.exec(`DROP TABLE candidates`);
      db.exec(`ALTER TABLE candidates_v3 RENAME TO candidates`);
      db.exec(`PRAGMA foreign_keys = ON`);
    },
  },
  // ── Add new migrations here ──────────────────────────────────────────────
  {
    id: 4,
    description: 'Add ai_reviewing flag to candidates',
    up(db) {
      db.exec(`ALTER TABLE candidates ADD COLUMN ai_reviewing INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    id: 5,
    description: 'Add dismissed column to ai_reviews',
    up(db) {
      db.exec(`ALTER TABLE ai_reviews ADD COLUMN dismissed TEXT NOT NULL DEFAULT '{}'`);
    },
  },
  {
    id: 6,
    description: 'Add bonus_rules table and bonuses column to ai_reviews',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS bonus_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`ALTER TABLE ai_reviews ADD COLUMN bonuses TEXT`);
    },
  },
];

function runMigrations() {
  // Bootstrap the migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare(`SELECT id FROM schema_migrations`).all().map(r => r.id)
  );

  const pending = MIGRATIONS.filter(m => !applied.has(m.id));
  if (!pending.length) return;

  const insertMigration = db.prepare(
    `INSERT INTO schema_migrations (id, description) VALUES (?, ?)`
  );

  for (const migration of pending) {
    console.log(`[db] Running migration ${migration.id}: ${migration.description}`);
    // Run inside a transaction so a failure leaves the DB unchanged
    db.exec('BEGIN');
    try {
      migration.up(db);
      insertMigration.run(migration.id, migration.description);
      db.exec('COMMIT');
      console.log(`[db] Migration ${migration.id} applied.`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} failed: ${err.message}`);
    }
  }
}


// --- Jobs ---

function listJobs() {
  return getDb().prepare(`
    SELECT j.*,
      COUNT(c.id) as candidate_count,
      SUM(CASE WHEN c.status = 'new' THEN 1 ELSE 0 END) as count_new,
      SUM(CASE WHEN c.status = 'reviewing' THEN 1 ELSE 0 END) as count_reviewing,
      SUM(CASE WHEN c.status = 'approved' THEN 1 ELSE 0 END) as count_approved,
      SUM(CASE WHEN c.status = 'rejected' THEN 1 ELSE 0 END) as count_rejected,
      COUNT(r.id) as scored_count,
      SUM(CASE WHEN r.match_score < 50 THEN 1 ELSE 0 END) as score_low_count,
      SUM(CASE WHEN r.match_score >= 70 THEN 1 ELSE 0 END) as score_high_count
    FROM jobs j
    LEFT JOIN candidates c ON c.job_id = j.id
    LEFT JOIN (
      SELECT candidate_id, id, match_score
      FROM ai_reviews
      WHERE id IN (
        SELECT MAX(id) FROM ai_reviews GROUP BY candidate_id
      )
    ) r ON r.candidate_id = c.id
    GROUP BY j.id
    ORDER BY j.created_at DESC
  `).all();
}

function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
}

function createJob(data) {
  const { title, company, description, responsibilities, qualifications, jd_filename, jd_original_name, status = 'open' } = data;
  const result = getDb().prepare(`
    INSERT INTO jobs (title, company, description, responsibilities, qualifications, jd_filename, jd_original_name, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, company, description || null, responsibilities || null, qualifications || null, jd_filename || null, jd_original_name || null, status);
  return getJob(result.lastInsertRowid);
}

function updateJob(id, data) {
  const allowed = ['title', 'company', 'description', 'responsibilities', 'qualifications', 'status'];
  const fields = Object.keys(data).filter(k => allowed.includes(k));
  if (!fields.length) return getJob(id);
  const set = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => data[f]);
  getDb().prepare(`UPDATE jobs SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
  return getJob(id);
}

function deleteJob(id) {
  return getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
}

// --- Candidates ---

function listCandidates(jobId) {
  return getDb().prepare(`
    SELECT c.id, c.job_id, c.name, c.email, c.cv_filename, c.cv_original_name, c.status, c.ai_reviewing, c.created_at, c.updated_at,
           (c.cv_text IS NOT NULL AND c.cv_text != '') as has_cv_text,
           r.match_score, r.summary as review_summary, r.warnings, r.red_flags, r.dismissed, r.work_experience, r.bonuses
    FROM candidates c
    LEFT JOIN ai_reviews r ON r.id = (
      SELECT id FROM ai_reviews WHERE candidate_id = c.id ORDER BY created_at DESC LIMIT 1
    )
    WHERE c.job_id = ?
    ORDER BY c.created_at DESC
  `).all(jobId).map(row => {
    const warnings = tryParse(row.warnings, []) || [];
    const redFlags = tryParse(row.red_flags, []) || [];
    const dismissed = tryParse(row.dismissed, {}) || {};
    const dismissedW = dismissed.warnings || [];
    const dismissedR = dismissed.red_flags || [];
    const workExp = tryParse(row.work_experience, []) || [];
    const hasReview = row.match_score != null;
    const bonuses = tryParse(row.bonuses, []) || [];
    const dismissedB = dismissed.bonuses || [];
    return {
      ...row,
      warnings_count: warnings.filter((_, i) => !dismissedW.includes(i)).length,
      red_flags_count: redFlags.filter((_, i) => !dismissedR.includes(i)).length,
      bonuses_count: bonuses.filter((_, i) => !dismissedB.includes(i)).length,
      needs_manual_review: !row.has_cv_text || (hasReview && workExp.length === 0 && !dismissed.no_experience),
    };
  });
}

function getCandidate(id) {
  const candidate = getDb().prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!candidate) return null;
  const review = getLatestReview(id);
  const feedbackList = listFeedback(id);
  return { ...candidate, ai_review: review, feedback: feedbackList };
}

function createCandidate(data) {
  const { job_id, name, email, cv_filename, cv_original_name, cv_text } = data;
  const result = getDb().prepare(`
    INSERT INTO candidates (job_id, name, email, cv_filename, cv_original_name, cv_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(job_id, name, email || null, cv_filename || null, cv_original_name || null, cv_text || null);
  return getCandidate(result.lastInsertRowid);
}

function updateCandidateStatus(id, status) {
  getDb().prepare(`UPDATE candidates SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  return getCandidate(id);
}

function setReviewing(id, flag) {
  getDb().prepare(`UPDATE candidates SET ai_reviewing = ?, updated_at = datetime('now') WHERE id = ?`).run(flag ? 1 : 0, id);
}

function deleteCandidate(id) {
  return getDb().prepare('DELETE FROM candidates WHERE id = ?').run(id).changes > 0;
}

function deleteAllCandidates() {
  return getDb().prepare('DELETE FROM candidates').run().changes;
}

// --- AI Reviews ---

function saveReview(candidateId, reviewData) {
  const { match_score, strengths, gaps, red_flags, summary, work_experience, warnings, bonuses } = reviewData;
  const result = getDb().prepare(`
    INSERT INTO ai_reviews (candidate_id, match_score, strengths, gaps, red_flags, summary, work_experience, warnings, bonuses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    match_score,
    JSON.stringify(strengths || []),
    JSON.stringify(gaps || []),
    JSON.stringify(red_flags || []),
    summary || null,
    JSON.stringify(work_experience || []),
    JSON.stringify(warnings || []),
    JSON.stringify(bonuses || [])
  );
  return getReview(result.lastInsertRowid);
}

function getReview(id) {
  const row = getDb().prepare('SELECT * FROM ai_reviews WHERE id = ?').get(id);
  return row ? parseReview(row) : null;
}

function getLatestReview(candidateId) {
  const row = getDb().prepare('SELECT * FROM ai_reviews WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(candidateId);
  return row ? parseReview(row) : null;
}

function parseReview(row) {
  return {
    ...row,
    strengths: tryParse(row.strengths, []),
    gaps: tryParse(row.gaps, []),
    red_flags: tryParse(row.red_flags, []),
    work_experience: tryParse(row.work_experience, []),
    warnings: tryParse(row.warnings, []),
    dismissed: tryParse(row.dismissed, {}),
    bonuses: tryParse(row.bonuses, []),
  };
}

// --- Feedback ---

function dismissReviewItem(reviewId, type, index, isDismissed) {
  const row = getDb().prepare('SELECT dismissed FROM ai_reviews WHERE id = ?').get(reviewId);
  const d = tryParse(row?.dismissed, {}) || {};
  if (type === 'no_experience') {
    if (isDismissed) d.no_experience = true;
    else delete d.no_experience;
  } else {
    if (!d[type]) d[type] = [];
    if (isDismissed) {
      if (!d[type].includes(index)) d[type].push(index);
    } else {
      d[type] = d[type].filter(i => i !== index);
    }
  }
  getDb().prepare('UPDATE ai_reviews SET dismissed = ? WHERE id = ?').run(JSON.stringify(d), reviewId);
}

function searchCandidates(query) {
  return getDb().prepare(`
    SELECT c.id, c.name, c.email, c.status, c.created_at,
           j.id as job_id, j.title as job_title, j.company as job_company,
           r.match_score
    FROM candidates c
    JOIN jobs j ON j.id = c.job_id
    LEFT JOIN ai_reviews r ON r.id = (
      SELECT id FROM ai_reviews WHERE candidate_id = c.id ORDER BY created_at DESC LIMIT 1
    )
    WHERE c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\'
    ORDER BY c.name ASC
    LIMIT 50
  `).all(`%${query.replace(/[%_\\]/g, '\\$&')}%`, `%${query.replace(/[%_\\]/g, '\\$&')}%`);
}

function addFeedback(candidateId, data) {
  const { note, recommendation } = data;
  const result = getDb().prepare(`
    INSERT INTO feedback (candidate_id, note, recommendation)
    VALUES (?, ?, ?)
  `).run(candidateId, note, recommendation || null);
  return getDb().prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid);
}

function listFeedback(candidateId) {
  return getDb().prepare('SELECT * FROM feedback WHERE candidate_id = ? ORDER BY created_at DESC').all(candidateId);
}

// --- Warning Rules ---

function listWarningRules() {
  return getDb().prepare(`SELECT * FROM warning_rules ORDER BY created_at ASC`).all();
}

function createWarningRule(text) {
  const result = getDb().prepare(`INSERT INTO warning_rules (text) VALUES (?)`).run(text);
  return getDb().prepare(`SELECT * FROM warning_rules WHERE id = ?`).get(result.lastInsertRowid);
}

function updateWarningRule(id, updates) {
  const allowed = ['text', 'enabled'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) return getDb().prepare(`SELECT * FROM warning_rules WHERE id = ?`).get(id);
  const set = fields.map(f => `${f} = ?`).join(', ');
  getDb().prepare(`UPDATE warning_rules SET ${set} WHERE id = ?`).run(...fields.map(f => updates[f]), id);
  return getDb().prepare(`SELECT * FROM warning_rules WHERE id = ?`).get(id);
}

function deleteWarningRule(id) {
  return getDb().prepare(`DELETE FROM warning_rules WHERE id = ?`).run(id).changes > 0;
}

// --- Bonus Rules ---

function listBonusRules() {
  return getDb().prepare(`SELECT * FROM bonus_rules ORDER BY created_at ASC`).all();
}

function createBonusRule(text) {
  const result = getDb().prepare(`INSERT INTO bonus_rules (text) VALUES (?)`).run(text);
  return getDb().prepare(`SELECT * FROM bonus_rules WHERE id = ?`).get(result.lastInsertRowid);
}

function updateBonusRule(id, updates) {
  const allowed = ['text', 'enabled'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) return getDb().prepare(`SELECT * FROM bonus_rules WHERE id = ?`).get(id);
  const set = fields.map(f => `${f} = ?`).join(', ');
  getDb().prepare(`UPDATE bonus_rules SET ${set} WHERE id = ?`).run(...fields.map(f => updates[f]), id);
  return getDb().prepare(`SELECT * FROM bonus_rules WHERE id = ?`).get(id);
}

function deleteBonusRule(id) {
  return getDb().prepare(`DELETE FROM bonus_rules WHERE id = ?`).run(id).changes > 0;
}

function tryParse(val, fallback) {
  try { return JSON.parse(val); } catch { return fallback; }
}

// --- Config ---

function getConfig() {
  const rows = getDb().prepare(`SELECT key, value FROM config`).all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function setConfig(updates) {
  const stmt = getDb().prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(updates)) stmt.run(k, v);
  return getConfig();
}

module.exports = {
  getDb,
  listJobs, getJob, createJob, updateJob, deleteJob,
  listCandidates, getCandidate, createCandidate, updateCandidateStatus, setReviewing, deleteCandidate, deleteAllCandidates,
  saveReview, getReview, getLatestReview, dismissReviewItem,
  searchCandidates,
  addFeedback, listFeedback,
  getConfig, setConfig,
  listWarningRules, createWarningRule, updateWarningRule, deleteWarningRule,
  listBonusRules, createBonusRule, updateBonusRule, deleteBonusRule,
};
