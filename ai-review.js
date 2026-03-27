'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');

function getClient() {
  const cfg = db.getConfig();
  return new Anthropic({
    apiKey: cfg.ANTHROPIC_API_KEY || 'dummy',
    baseURL: cfg.ANTHROPIC_BASE_URL || undefined,
  });
}

function getModels() {
  const cfg = db.getConfig();
  return {
    review: cfg.REVIEW_MODEL || 'claude-opus-4-6',
    extraction: cfg.EXTRACTION_MODEL || 'claude-haiku-4-5-20251001',
  };
}

async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    try {
      const data = await pdfParse(buffer);
      const text = (data.text || '').replace(/\0/g, '').trim();
      if (!text) throw new Error('PDF appears to be encrypted or image-only — no extractable text found.');
      return text;
    } catch (err) {
      if (err.message.includes('encrypted') || err.message.includes('no extractable')) throw err;
      throw new Error(`Failed to parse PDF: ${err.message}`);
    }
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    const text = (result.value || '').replace(/\0/g, '').trim();
    if (!text) throw new Error('DOCX appears to be empty or unreadable.');
    return text;
  }

  throw new Error(`Unsupported file type: ${ext}. Only PDF and DOCX are supported.`);
}

async function reviewCv(cvText, job, warningRules = [], bonusRules = []) {
  const truncated = cvText.length > 8000 ? cvText.slice(0, 8000) + '\n\n[...truncated for review...]' : cvText;

  const rulesSection = warningRules.length
    ? `\nWARNING RULES — check each rule and flag any violations in the "warnings" array:\n${warningRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}`
    : '';

  const bonusSection = bonusRules.length
    ? `\nBONUS RULES — check each rule and list any matches in the "bonuses" array:\n${bonusRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}`
    : '';

  const prompt = `You are an expert technical recruiter. Review this CV against the job requirements and provide a structured assessment.

JOB TITLE: ${job.title}
COMPANY: ${job.company}
JOB DESCRIPTION:
${job.description || 'Not provided'}

KEY RESPONSIBILITIES:
${job.responsibilities || 'Not provided'}

QUALIFICATIONS:
${job.qualifications || 'Not provided'}
${rulesSection}${bonusSection}
CV TEXT:
${truncated}

Respond with ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "match_score": <integer 0-100>,
  "strengths": [<string>, ...],
  "gaps": [<string>, ...],
  "red_flags": [<string>, ...],
  "warnings": [<string>, ...],
  "bonuses": [<string>, ...],
  "summary": "<2-3 sentence overall assessment>",
  "work_experience": [
    { "title": "<job title>", "company": "<company name>", "duration": "<e.g. Jan 2020 – Mar 2022>", "summary": "<1-2 sentence description of role and key achievements>" },
    ...
  ]
}

Guidelines:
- match_score: 0-100 percentage fit for this specific role
- strengths: 3-5 specific positives relevant to the job
- gaps: 2-4 missing skills or experience areas (empty array if none)
- red_flags: 0-3 concerns (employment gaps, mismatches, etc.) — empty array if none
- warnings: one entry per violated warning rule, describing the violation — empty array if no rules provided or none violated
- bonuses: one entry per matched bonus rule, describing how the candidate meets it — empty array if no bonus rules provided or none matched
- summary: concise recruiter-style summary
- work_experience: list all roles in reverse chronological order (most recent first), empty array if none found`;

  try {
    const message = await getClient().messages.create({
      model: getModels().review,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].text.trim();
    return parseClaudeResponse(raw);
  } catch (err) {
    if (err.status === 429) throw new Error('Rate limit reached. Please wait a moment and try again.');
    if (err.status === 401) throw new Error('Invalid Anthropic API key. Check your .env file.');
    if (err.status === 400 && err.message?.includes('credit')) throw new Error('Anthropic credit balance too low. Please top up at console.anthropic.com.');
    throw new Error(`AI review failed: ${err.message}`);
  }
}

function parseClaudeResponse(raw) {
  // Strip markdown code fences if present
  let text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to extract JSON object from response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Could not parse AI response as JSON.');
    parsed = JSON.parse(match[0]);
  }

  // Validate and sanitize
  const score = parseInt(parsed.match_score, 10);
  const work_experience = Array.isArray(parsed.work_experience)
    ? parsed.work_experience.slice(0, 20).map(e => ({
        title: typeof e.title === 'string' ? e.title.slice(0, 200) : '',
        company: typeof e.company === 'string' ? e.company.slice(0, 200) : '',
        duration: typeof e.duration === 'string' ? e.duration.slice(0, 100) : '',
        summary: typeof e.summary === 'string' ? e.summary.slice(0, 500) : '',
      }))
    : [];
  return {
    match_score: isNaN(score) ? 50 : Math.max(0, Math.min(100, score)),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 8).map(String) : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 8).map(String) : [],
    red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags.slice(0, 5).map(String) : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 20).map(String) : [],
    bonuses: Array.isArray(parsed.bonuses) ? parsed.bonuses.slice(0, 20).map(String) : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1000) : '',
    work_experience,
  };
}

async function extractJobFromText(text) {
  const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n\n[...truncated...]' : text;

  const prompt = `You are an expert recruiter. Extract structured job posting information from the text below.

JOB POSTING TEXT:
${truncated}

Respond with ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "title": "<job title>",
  "description": "<overview of the role and context>",
  "responsibilities": "<key responsibilities and duties as plain text>",
  "qualifications": "<required and preferred skills, experience, education as plain text>"
}

Guidelines:
- title: concise job title only (e.g. "Senior Backend Engineer")
- description: role overview, team context, what the position is about
- responsibilities: what the person will do day-to-day — plain text, preserve line breaks
- qualifications: skills, years of experience, education, certifications — plain text
- If a field cannot be determined, use an empty string ""`;

  try {
    const message = await getClient().messages.create({
      model: getModels().extraction,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].text.trim();
    let text2 = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(text2);
    } catch {
      const match = text2.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Could not parse AI response as JSON.');
      parsed = JSON.parse(match[0]);
    }
    return {
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 200).trim() : '',
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 3000).trim() : '',
      responsibilities: typeof parsed.responsibilities === 'string' ? parsed.responsibilities.slice(0, 3000).trim() : '',
      qualifications: typeof parsed.qualifications === 'string' ? parsed.qualifications.slice(0, 3000).trim() : '',
    };
  } catch (err) {
    if (err.status === 429) throw new Error('Rate limit reached. Please wait a moment and try again.');
    if (err.status === 401) throw new Error('Invalid Anthropic API key. Check your .env file.');
    if (err.status === 400 && err.message?.includes('credit')) throw new Error('Anthropic credit balance too low. Please top up at console.anthropic.com.');
    throw new Error(`AI extraction failed: ${err.message}`);
  }
}

async function extractNameAndEmail(text, originalName) {
  const snippet = text.slice(0, 3000);

  try {
    const message = await getClient().messages.create({
      model: getModels().extraction,
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: `Extract the candidate's full name and email address from this CV text. Respond with ONLY a JSON object, no markdown:\n{"name": "<full name or null>", "email": "<email or null>"}\n\nCV TEXT:\n${snippet}`,
      }],
    });

    const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(raw);
    const rawName = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
    const name = rawName ? rawName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : null;
    const email = typeof parsed.email === 'string' && parsed.email.includes('@') ? parsed.email.trim() : null;
    if (name) return { name, email };
  } catch {
    // fall through to filename fallback
  }

  // Fallback: derive from filename (john_doe_cv.pdf → John Doe)
  const stem = path.basename(originalName, path.extname(originalName))
    .replace(/[-_\.]/g, ' ')
    .replace(/\b(cv|resume|curriculum|vitae)\b/gi, '')
    .trim();
  const name = stem.split(' ').filter(Boolean).length >= 2
    ? stem.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : null;

  // Email fallback: regex
  const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return { name, email: emailMatch ? emailMatch[0] : null };
}

module.exports = { extractTextFromFile, extractNameAndEmail, reviewCv, extractJobFromText };
