'use strict';

// Uses Node.js built-in SQLite (node:sqlite) — no native addon needed.
// Requires Node >= 22.5.0. Suppress experimental warning with NODE_NO_WARNINGS=1.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'jobs.db');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
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
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'reviewing', 'shortlisted', 'rejected')),
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      recommendation TEXT CHECK(recommendation IN ('hire', 'reject', 'hold', NULL)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate existing DBs: add new columns if missing
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all().map(r => r.name);
  if (!cols.includes('responsibilities'))  db.exec(`ALTER TABLE jobs ADD COLUMN responsibilities TEXT`);
  if (!cols.includes('qualifications'))    db.exec(`ALTER TABLE jobs ADD COLUMN qualifications TEXT`);
  if (!cols.includes('jd_filename'))       db.exec(`ALTER TABLE jobs ADD COLUMN jd_filename TEXT`);
  if (!cols.includes('jd_original_name'))  db.exec(`ALTER TABLE jobs ADD COLUMN jd_original_name TEXT`);
  const reviewCols = db.prepare(`PRAGMA table_info(ai_reviews)`).all().map(r => r.name);
  if (!reviewCols.includes('work_experience')) db.exec(`ALTER TABLE ai_reviews ADD COLUMN work_experience TEXT`);
}


// --- Jobs ---

function listJobs() {
  return getDb().prepare(`
    SELECT j.*, COUNT(c.id) as candidate_count
    FROM jobs j
    LEFT JOIN candidates c ON c.job_id = j.id
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
    SELECT c.*, r.match_score, r.summary as review_summary
    FROM candidates c
    LEFT JOIN ai_reviews r ON r.id = (
      SELECT id FROM ai_reviews WHERE candidate_id = c.id ORDER BY created_at DESC LIMIT 1
    )
    WHERE c.job_id = ?
    ORDER BY c.created_at DESC
  `).all(jobId);
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

function deleteCandidate(id) {
  return getDb().prepare('DELETE FROM candidates WHERE id = ?').run(id).changes > 0;
}

// --- AI Reviews ---

function saveReview(candidateId, reviewData) {
  const { match_score, strengths, gaps, red_flags, summary, work_experience } = reviewData;
  const result = getDb().prepare(`
    INSERT INTO ai_reviews (candidate_id, match_score, strengths, gaps, red_flags, summary, work_experience)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    match_score,
    JSON.stringify(strengths || []),
    JSON.stringify(gaps || []),
    JSON.stringify(red_flags || []),
    summary || null,
    JSON.stringify(work_experience || [])
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
  };
}

// --- Feedback ---

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

function tryParse(val, fallback) {
  try { return JSON.parse(val); } catch { return fallback; }
}

module.exports = {
  getDb,
  listJobs, getJob, createJob, updateJob, deleteJob,
  listCandidates, getCandidate, createCandidate, updateCandidateStatus, deleteCandidate,
  saveReview, getReview, getLatestReview,
  searchCandidates,
  addFeedback, listFeedback,
};
