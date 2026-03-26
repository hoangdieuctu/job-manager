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

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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
  const candidates = db.listCandidates(Number(req.params.id)).filter(c => c.cv_text && c.status === 'new');
  if (!candidates.length) return res.json({ started: 0 });

  // Fire and forget — run in background, don't await
  Promise.all(candidates.map(async c => {
    try {
      const reviewData = await reviewCv(c.cv_text, job);
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
    const ext = path.extname(c.cv_original_name || c.cv_filename);
    const base = c.name.replace(/[^a-z0-9_\-\s]/gi, '').trim().replace(/\s+/g, '_') || 'candidate';
    usedNames[base] = (usedNames[base] || 0) + 1;
    const count = usedNames[base];
    const entryName = count > 1 ? `${base}_${count}${ext}` : `${base}${ext}`;
    archive.file(filePath, { name: entryName });
  });

  archive.finalize();
});

app.post('/api/jobs/:id/upload-cv', upload.array('cvs', 20), async (req, res) => {
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
  const allowed = ['new', 'reviewing', 'shortlisted', 'rejected'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  res.json(db.updateCandidateStatus(Number(req.params.id), status));
});

app.post('/api/candidates/:id/ai-review', async (req, res) => {
  const candidate = db.getCandidate(Number(req.params.id));
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!candidate.cv_text) return res.status(400).json({ error: 'No CV text available for review. The CV may need to be re-uploaded.' });

  const job = db.getJob(candidate.job_id);
  if (!job) return res.status(404).json({ error: 'Associated job not found' });

  try {
    const reviewData = await reviewCv(candidate.cv_text, job);
    const review = db.saveReview(candidate.id, reviewData);
    db.updateCandidateStatus(candidate.id, 'reviewing');
    res.json(review);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
