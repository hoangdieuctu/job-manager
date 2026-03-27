'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const archiver = require('archiver');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./database');
const { extractTextFromFile, extractNameAndEmail, reviewCv, extractJobFromText } = require('./ai-review');
const PDFDocument = require('pdfkit');
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer config
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only PDF and DOCX files are allowed.'));
  },
});

// --- Config Routes ---

app.get('/api/config', (req, res) => {
  const cfg = db.getConfig();
  // Fall back to .env values for any key not yet set in DB
  const apiKey = cfg.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const baseUrl = cfg.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || '';
  const reviewModel = cfg.REVIEW_MODEL || process.env.REVIEW_MODEL || 'claude-opus-4-6';
  const extractionModel = cfg.EXTRACTION_MODEL || process.env.EXTRACTION_MODEL || 'claude-haiku-4-5-20251001';
  res.json({
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    REVIEW_MODEL: reviewModel,
    EXTRACTION_MODEL: extractionModel,
  });
});

app.post('/api/config/reset', (req, res) => {
  const defaults = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
    REVIEW_MODEL: process.env.REVIEW_MODEL || 'claude-opus-4-6',
    EXTRACTION_MODEL: process.env.EXTRACTION_MODEL || 'claude-haiku-4-5-20251001',
  };
  db.setConfig(defaults);
  res.json({
    ANTHROPIC_API_KEY: defaults.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: defaults.ANTHROPIC_BASE_URL,
    REVIEW_MODEL: defaults.REVIEW_MODEL,
    EXTRACTION_MODEL: defaults.EXTRACTION_MODEL,
  });
});

app.put('/api/config', (req, res) => {
  const allowed = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'REVIEW_MODEL', 'EXTRACTION_MODEL'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  db.setConfig(updates);
  const cfg = db.getConfig();
  res.json({
    ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY || '',
    ANTHROPIC_BASE_URL: cfg.ANTHROPIC_BASE_URL || '',
    REVIEW_MODEL: cfg.REVIEW_MODEL || '',
    EXTRACTION_MODEL: cfg.EXTRACTION_MODEL || '',
  });
});

// --- Warning Rules Routes ---

app.get('/api/warning-rules', (req, res) => {
  res.json(db.listWarningRules());
});

app.post('/api/warning-rules', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  res.status(201).json(db.createWarningRule(text.trim()));
});

app.patch('/api/warning-rules/:id', (req, res) => {
  const rule = db.updateWarningRule(Number(req.params.id), req.body);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
});

app.delete('/api/warning-rules/:id', (req, res) => {
  const deleted = db.deleteWarningRule(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Rule not found' });
  res.json({ success: true });
});

app.get('/api/bonus-rules', (req, res) => {
  res.json(db.listBonusRules());
});

app.post('/api/bonus-rules', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  res.status(201).json(db.createBonusRule(text.trim()));
});

app.patch('/api/bonus-rules/:id', (req, res) => {
  const rule = db.updateBonusRule(Number(req.params.id), req.body);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
});

app.delete('/api/bonus-rules/:id', (req, res) => {
  const deleted = db.deleteBonusRule(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Rule not found' });
  res.json({ success: true });
});

// --- Job Routes ---

app.post('/api/jobs/upload-jd', upload.single('jd'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const text = await extractTextFromFile(req.file.path, req.file.originalname);
    const fields = await extractJobFromText(text);
    // Use PDF filename (without extension) as job title if AI didn't extract one
    const stem = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/[-_]/g, ' ').trim();
    const title = stem || 'Untitled Job';
    const job = db.createJob({
      title,
      company: '',
      description: fields.description,
      responsibilities: fields.responsibilities,
      qualifications: fields.qualifications,
      jd_filename: req.file.filename,
      jd_original_name: req.file.originalname,
    });
    res.status(201).json(job);
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(422).json({ error: err.message });
  }
});

app.get('/api/jobs/:id/jd', (req, res) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.jd_filename) return res.status(404).json({ error: 'No JD file on record' });
  const safeName = path.basename(job.jd_filename);
  const filePath = path.join(UPLOADS_DIR, safeName);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
  res.download(filePath, job.jd_original_name || safeName);
});

app.get('/api/jobs', (req, res) => {
  res.json(db.listJobs());
});

app.post('/api/jobs', (req, res) => {
  const { title, company, description, responsibilities, qualifications, status } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const job = db.createJob({ title, company: company || '', description, responsibilities, qualifications, status });
  res.status(201).json(job);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.put('/api/jobs/:id', (req, res) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const updated = db.updateJob(Number(req.params.id), req.body);
  res.json(updated);
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.jd_filename) {
    const filePath = path.join(UPLOADS_DIR, path.basename(job.jd_filename));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.deleteJob(Number(req.params.id));
  res.json({ success: true });
});

// --- Candidate Routes ---

app.post('/api/jobs/:id/review-all', async (req, res) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const candidates = db.listCandidates(Number(req.params.id)).filter(c => c.has_cv_text && c.status === 'new');
  if (!candidates.length) return res.json({ started: 0 });

  // Fire and forget — run in background, don't await
  const rules = db.listWarningRules().filter(r => r.enabled);
  const bonusRules = db.listBonusRules().filter(r => r.enabled);
  Promise.all(candidates.map(async c => {
    try {
      const full = db.getCandidate(c.id);
      const reviewData = await reviewCv(full.cv_text, job, rules, bonusRules);
      db.saveReview(c.id, reviewData);
      db.updateCandidateStatus(c.id, 'reviewing');
    } catch (err) {
      console.warn(`Review failed for candidate ${c.id}:`, err.message);
    }
  }));

  res.json({ started: candidates.length });
});


app.get('/api/jobs/:id/candidates', (req, res) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(db.listCandidates(Number(req.params.id)));
});

app.post('/api/jobs/:id/export-cvs', (req, res) => {
  const job = db.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const ids = Array.isArray(req.body.candidate_ids) ? req.body.candidate_ids.map(Number) : [];
  if (!ids.length) return res.status(400).json({ error: 'No candidate IDs provided' });

  const candidates = ids.map(id => db.getCandidate(id)).filter(Boolean);
  const withFiles = candidates.filter(c => c.cv_filename && fs.existsSync(path.join(UPLOADS_DIR, path.basename(c.cv_filename))));
  if (!withFiles.length) return res.status(404).json({ error: 'No CV files found for selected candidates' });

  const safeName = job.title.replace(/[^a-z0-9_\-\s]/gi, '').trim().replace(/\s+/g, '_') || 'candidates';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}_cvs.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archive error:', err); res.end(); });
  archive.pipe(res);

  // Track used filenames to avoid collisions
  const usedNames = {};
  withFiles.forEach(c => {
    const filePath = path.join(UPLOADS_DIR, path.basename(c.cv_filename));
    const original = c.cv_original_name || path.basename(c.cv_filename);
    const ext = path.extname(original);
    const base = path.basename(original, ext);
    usedNames[base] = (usedNames[base] || 0) + 1;
    const count = usedNames[base];
    const entryName = count > 1 ? `${base}_${count}${ext}` : `${base}${ext}`;
    archive.file(filePath, { name: entryName });
  });

  archive.finalize();
});

app.post('/api/jobs/:id/upload-cv', upload.array('cvs', 500), async (req, res) => {
  const jobId = Number(req.params.id);
  const job = db.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const results = await Promise.all(req.files.map(async (file) => {
    let cvText = null;
    try {
      cvText = await extractTextFromFile(file.path, file.originalname);
    } catch (err) {
      console.warn('Text extraction failed:', err.message);
    }

    const extracted = cvText ? await extractNameAndEmail(cvText, file.originalname) : { name: null, email: null };
    const name = extracted.name || path.basename(file.originalname, path.extname(file.originalname)).replace(/[-_.]/g, ' ').trim() || 'Unknown';
    const email = extracted.email || null;

    try {
      const candidate = db.createCandidate({
        job_id: jobId,
        name,
        email,
        cv_filename: file.filename,
        cv_original_name: file.originalname,
        cv_text: cvText,
      });
      return { success: true, candidate };
    } catch (err) {
      return { success: false, file: file.originalname, error: err.message };
    }
  }));

  res.status(201).json(results);
});

app.get('/api/candidates/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(db.searchCandidates(q));
});

app.get('/api/candidates/:id', (req, res) => {
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  res.json(candidate);
});

app.patch('/api/candidates/:id/status', (req, res) => {
  const { status } = req.body;
  const allowed = ['new', 'reviewing', 'approved', 'rejected'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  res.json(db.updateCandidateStatus(Number(req.params.id), status));
});

app.post('/api/candidates/:id/ai-review', async (req, res) => {
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!candidate.cv_text) return res.status(400).json({ error: 'No CV text available for review. The CV may need to be re-uploaded.' });
  if (candidate.ai_reviewing) return res.status(409).json({ error: 'Review already in progress' });

  const job = db.getJob(candidate.job_id);
  if (!job) return res.status(404).json({ error: 'Associated job not found' });

  db.setReviewing(candidate.id, true);
  res.json({ started: true });

  try {
    const rules = db.listWarningRules().filter(r => r.enabled);
    const bonusRules = db.listBonusRules().filter(r => r.enabled);
    const reviewData = await reviewCv(candidate.cv_text, job, rules, bonusRules);
    db.saveReview(candidate.id, reviewData);
    db.updateCandidateStatus(candidate.id, 'reviewing');
  } catch (err) {
    console.error(`AI review failed for candidate ${candidate.id}:`, err.message);
  } finally {
    db.setReviewing(candidate.id, false);
  }
});

app.patch('/api/candidates/:id/review/dismiss', (req, res) => {
  const { type, index, dismissed } = req.body;
  if (!['red_flags', 'warnings', 'no_experience', 'bonuses'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (type !== 'no_experience' && typeof index !== 'number') return res.status(400).json({ error: 'index must be a number' });
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!candidate.ai_review) return res.status(404).json({ error: 'Review not found' });
  db.dismissReviewItem(candidate.ai_review.id, type, index, !!dismissed);
  res.json(db.getCandidate(Number(req.params.id)));
});

app.post('/api/candidates/:id/feedback', (req, res) => {
  const { note, recommendation } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const fb = db.addFeedback(Number(req.params.id), { note, recommendation });
  res.status(201).json(fb);
});

app.get('/api/candidates/:id/cv', (req, res) => {
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!candidate.cv_filename) return res.status(404).json({ error: 'No CV file on record' });

  // Path traversal check
  const safeName = path.basename(candidate.cv_filename);
  const filePath = path.join(UPLOADS_DIR, safeName);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  res.download(filePath, candidate.cv_original_name || safeName);
});

app.get('/api/candidates/:id/cv-view', (req, res) => {
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!candidate.cv_filename) return res.status(404).json({ error: 'No CV file on record' });

  const safeName = path.basename(candidate.cv_filename);
  const filePath = path.join(UPLOADS_DIR, safeName);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  res.sendFile(filePath);
});

app.delete('/api/candidates/:id', (req, res) => {
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  // Clean up file
  if (candidate.cv_filename) {
    const safeName = path.basename(candidate.cv_filename);
    const filePath = path.join(UPLOADS_DIR, safeName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.deleteCandidate(Number(req.params.id));
  res.json({ success: true });
});

app.delete('/api/candidates', (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR);
  files.forEach(f => {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {}
  });
  db.deleteAllCandidates();
  res.json({ success: true });
});

app.get('/api/candidates/:id/export-review', (req, res) => {
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  const job = db.getJob(candidate.job_id);
  const review = candidate.ai_review;

  const ARIAL_UNICODE = '/Library/Fonts/Arial Unicode.ttf';
  const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
  doc.registerFont('U', ARIAL_UNICODE);
  doc.registerFont('U-Bold', ARIAL_UNICODE);   // Arial Unicode has no separate bold; use same for bold fallback
  const rawName = (candidate.name || 'candidate').trim();
  const asciiFallback = rawName.replace(/[^a-z0-9_\-\s]/gi, '').trim().replace(/\s+/g, '_') || 'candidate';
  const encodedName = encodeURIComponent(rawName.replace(/\s+/g, '_'));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}_review.pdf"; filename*=UTF-8''${encodedName}_review.pdf`);
  doc.pipe(res);

  const C = { accent: '#6366f1', green: '#059669', red: '#e11d48', amber: '#d97706', muted: '#64748b', light: '#94a3b8', dark: '#1e293b', bg: '#f8fafc', border: '#e2e8f0', summarybg: '#f1f5f9' };
  const L = 50, R = 545, W = 495;

  // ── Header ────────────────────────────────────────────────────────────────
  doc.font('U-Bold').fontSize(22).fillColor(C.dark)
    .text(candidate.name || 'Candidate', L, 50, { width: W });
  const metaParts = [
    candidate.email,
    job?.title,
    candidate.created_at ? `Applied ${new Date(candidate.created_at + ' UTC').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : '',
  ].filter(Boolean).join('   ·   ');
  doc.font('U').fontSize(9).fillColor(C.light).text(metaParts, L, doc.y + 4, { width: W });
  doc.moveDown(0.6);
  doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor(C.border).lineWidth(0.75).stroke();
  doc.moveDown(0.8);

  // ── Helpers ───────────────────────────────────────────────────────────────
  // Section group title
  function sectionTitle(label, color) {
    doc.moveDown(0.5);
    doc.font('U-Bold').fontSize(10).fillColor(color)
      .text(label.toUpperCase(), L, doc.y, { characterSpacing: 0.8 });
    doc.moveDown(0.3);
  }

  // Item row with colored dot + text + bottom divider
  function reviewItem(text, color, isLast) {
    const rowY = doc.y;
    doc.circle(L + 3, rowY + 7, 3).fill(color);
    doc.font('U').fontSize(12).fillColor(C.dark)
      .text(text, L + 14, rowY, { width: W - 14, lineGap: 2, align: 'justify' });
    if (!isLast) doc.moveDown(0.35);
  }

  // ── AI Review ─────────────────────────────────────────────────────────────
  if (review) {
    const sc = review.match_score ?? 0;
    const scoreColor = sc >= 75 ? C.green : sc < 50 ? C.red : C.amber;
    const scoreSub = sc >= 75 ? 'Strong match for this role' : sc >= 50 ? 'Moderate match — worth reviewing' : 'Weak match — significant gaps';

    // Score area: fixed-position circle on left, text block on right
    const areaY = doc.y;
    const circleR = 34;
    const cx = L + circleR;
    const cy = areaY + circleR + 4;

    // Circle
    doc.circle(cx, cy, circleR).lineWidth(3).strokeColor(scoreColor).stroke();
    doc.circle(cx, cy, circleR - 1.5).fillOpacity(0.08).fill(scoreColor).fillOpacity(1);

    // Score number — centered in circle, lineBreak:false to suppress cursor move
    doc.font('U-Bold').fontSize(18).fillColor(scoreColor)
      .text(`${sc}`, cx - circleR, cy - 13, { width: circleR * 2, align: 'center', lineBreak: false });
    doc.font('U').fontSize(8).fillColor(scoreColor)
      .text('/ 100', cx - circleR, cy + 8, { width: circleR * 2, align: 'center', lineBreak: false });

    // Right-side text block — all at fixed y positions
    const textX = L + circleR * 2 + 16;
    const textW = W - circleR * 2 - 16;
    doc.font('U-Bold').fontSize(13).fillColor(C.dark)
      .text('Match Score', textX, areaY + 8, { width: textW, lineBreak: false });
    doc.font('U').fontSize(10).fillColor(C.muted)
      .text(scoreSub, textX, areaY + 28, { width: textW, lineBreak: false });
    if (review.created_at) {
      const reviewedStr = new Date(review.created_at + ' UTC').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      doc.font('U').fontSize(8).fillColor(C.light)
        .text(`Reviewed ${reviewedStr}`, textX, areaY + 46, { width: textW, lineBreak: false });
    }

    // Advance cursor past the score area
    doc.y = areaY + circleR * 2 + 16;
    doc.moveDown(0.6);

    // Summary box (mirrors .review-summary)
    if (review.summary) {
      const sumY = doc.y;
      doc.font('U').fontSize(10);
      const sumH = doc.heightOfString(review.summary, { width: W - 24, lineGap: 2 }) + 20;
      doc.rect(L, sumY, W, sumH).fillColor(C.summarybg).fill();
      doc.rect(L, sumY, W, sumH).strokeColor(C.border).lineWidth(0.5).stroke();
      doc.fillColor(C.muted).text(review.summary, L + 12, sumY + 10, { width: W - 24, lineGap: 2, align: 'justify' });
      doc.y = sumY + sumH + 4;
      doc.moveDown(0.4);
    }

    // Strengths
    if (review.strengths?.length) {
      sectionTitle('Strengths', C.green);
      review.strengths.forEach((s, i) => reviewItem(s, C.green, i === review.strengths.length - 1));
    }

    // Gaps
    if (review.gaps?.length) {
      sectionTitle('Gaps', C.amber);
      review.gaps.forEach((g, i) => reviewItem(g, C.amber, i === review.gaps.length - 1));
    }

    // Red Flags
    if (review.red_flags?.length) {
      sectionTitle('Red Flags', C.red);
      review.red_flags.forEach((r, i) => reviewItem(r, C.red, i === review.red_flags.length - 1));
    }

    // Rule Warnings
    if (review.warnings?.length) {
      sectionTitle('Rule Warnings', C.amber);
      review.warnings.forEach((w, i) => reviewItem(w, C.amber, i === review.warnings.length - 1));
    }

    // Bonus Matches
    if (review.bonuses?.length) {
      sectionTitle('Bonus Matches', C.green);
      review.bonuses.forEach((b, i) => reviewItem(b, C.green, i === review.bonuses.length - 1));
    }
  }

  doc.end();
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 10MB)' });
  if (err.message) return res.status(400).json({ error: err.message });
  next(err);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Job Manager running at http://localhost:${PORT}`);
});
