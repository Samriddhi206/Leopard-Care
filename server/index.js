import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import * as store from './store.js';
import {
  cleanDate,
  cleanDateTime,
  cleanEnum,
  cleanId,
  cleanInt,
  cleanPhone,
  cleanText,
  cleanTime,
  requireObject,
} from './validation.js';
import { isVoiceConfigured, synthesize } from './elevenlabs.js';

const app = express();
// Vite's dev server owns 3000 and proxies /api here (see vite.config.js).
const PORT = process.env.PORT || 3001;
const TASK_STATUSES = ['pending', 'done', 'late'];
const ACTOR_ROLES = ['patient', 'caregiver'];
const MAX_STREAM_CLIENTS = 100;

// The Vite proxy runs on this machine and forwards the browser's address in
// X-Forwarded-For; trusting loopback lets rate limits key on the real client.
app.set('trust proxy', 'loopback');
app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((origin) => origin.trim()),
}));
// Small bodies only: nothing in this API needs more, and it bounds memory per request.
app.use(express.json({ limit: '10kb' }));

const json429 = (message) => ({
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: message },
});
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, ...json429('Too many requests, please slow down') }));
// Text-to-speech spends ElevenLabs credits: a tight per-minute and per-day budget per client.
const voiceLimiters = [
  rateLimit({ windowMs: 60 * 1000, limit: 6, ...json429('Read aloud limit reached, try again in a minute') }),
  rateLimit({ windowMs: 24 * 60 * 60 * 1000, limit: 150, ...json429('Daily read aloud limit reached') }),
];

// --- Helpers ---------------------------------------------------------------

function requirePatient(id) {
  const patient = store.getPatient(cleanId(id, 'patientId'));
  if (!patient) throw Object.assign(new Error('Patient not found'), { status: 404, expose: true });
  return patient;
}

function requireItem(collection, id) {
  const item = store.findItem(collection, cleanId(id));
  if (!item) throw Object.assign(new Error('Not found'), { status: 404, expose: true });
  return item;
}

function actorRole(req) {
  const role = req.get('X-Actor-Role');
  return ACTOR_ROLES.includes(role) ? role : 'caregiver';
}

function created(res, item) {
  if (!item) throw Object.assign(new Error('Item limit reached for this patient'), { status: 409, expose: true });
  res.status(201).json(item);
}

// A patient finishing something is a "relief notification" for caregivers.
function recordRelief(req, item, type, subject) {
  if (actorRole(req) !== 'patient') return;
  store.recordActivity({ patientId: item.patientId, type, subject });
}

// --- Routes ----------------------------------------------------------------

app.get('/api/v1/user', (req, res) => {
  res.json({ contactName: 'Sarah', badgeCount: 3 });
});

app.get('/api/v1/patients', (req, res) => {
  res.json(store.getPatients());
});

app.put('/api/v1/patients/:id', (req, res) => {
  const patient = requirePatient(req.params.id);
  const body = requireObject(req.body);
  const changes = {};
  if ('name' in body) changes.name = cleanText(body.name, 'name', { max: 80, required: true });
  if ('phone' in body) changes.phone = cleanPhone(body.phone, 'phone');
  if ('address' in body) changes.address = cleanText(body.address, 'address', { max: 160 });
  if ('dob' in body) changes.dob = cleanDate(body.dob, 'dob');
  res.json(store.updatePatient(patient.id, changes));
});

app.post('/api/v1/patients/:id/check-in', (req, res) => {
  const patient = requirePatient(req.params.id);
  res.status(201).json(store.recordActivity({ patientId: patient.id, type: 'check-in', subject: 'Check-in' }));
});

app.get('/api/v1/tasks', (req, res) => {
  res.json(store.listItems('tasks', requirePatient(req.query.patientId).id));
});

app.post('/api/v1/tasks', (req, res) => {
  const body = requireObject(req.body);
  created(res, store.addItem('tasks', {
    patientId: requirePatient(body.patientId).id,
    title: cleanText(body.title, 'title', { required: true }),
    time: cleanTime(body.time, 'time'),
    icon: cleanText(body.icon, 'icon', { max: 8 }) || '📝',
    status: 'pending',
  }));
});

app.put('/api/v1/tasks/:id', (req, res) => {
  const task = requireItem('tasks', req.params.id);
  const body = requireObject(req.body);
  const changes = {};
  if ('title' in body) changes.title = cleanText(body.title, 'title', { required: true });
  if ('time' in body) changes.time = cleanTime(body.time, 'time');
  if ('status' in body) changes.status = cleanEnum(body.status, 'status', TASK_STATUSES);

  const finished = changes.status === 'done' && task.status !== 'done';
  if ('status' in changes) changes.completedAt = changes.status === 'done' ? new Date().toISOString() : null;
  const updated = store.updateItem('tasks', task.id, changes);
  if (finished) recordRelief(req, updated, 'task-done', updated.title);
  res.json(updated);
});

app.get('/api/v1/medications', (req, res) => {
  res.json(store.listItems('medications', requirePatient(req.query.patientId).id));
});

app.post('/api/v1/medications', (req, res) => {
  const body = requireObject(req.body);
  const stock = cleanInt(body.stock ?? 30, 'stock', { min: 0, max: 999 });
  created(res, store.addItem('medications', {
    patientId: requirePatient(body.patientId).id,
    name: cleanText(body.name, 'name', { max: 80, required: true }),
    dose: cleanText(body.dose, 'dose', { max: 40 }),
    time: cleanTime(body.time, 'time', { required: true }),
    note: cleanText(body.note, 'note', { max: 80 }),
    stock: { left: stock, total: Math.max(stock, 1) },
    status: 'pending',
  }));
});

// Logging a dose uses one from the supply; un-logging it puts it back.
app.put('/api/v1/medications/:id', (req, res) => {
  const medication = requireItem('medications', req.params.id);
  const body = requireObject(req.body);
  const status = cleanEnum(body.status, 'status', TASK_STATUSES);
  const previous = medication.status;
  const stock = { ...medication.stock };
  if (status === 'done' && previous !== 'done') stock.left = Math.max(0, stock.left - 1);
  if (previous === 'done' && status !== 'done') stock.left = Math.min(stock.total, stock.left + 1);

  const updated = store.updateItem('medications', medication.id, {
    status,
    stock,
    takenAt: status === 'done' ? new Date().toISOString() : null,
  });
  if (status === 'done' && previous !== 'done') {
    recordRelief(req, updated, 'medication-taken', [updated.name, updated.dose].filter(Boolean).join(' '));
  }
  res.json(updated);
});

app.get('/api/v1/appointments', (req, res) => {
  const appointments = store.listItems('appointments', requirePatient(req.query.patientId).id);
  res.json([...appointments].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)));
});

app.post('/api/v1/appointments', (req, res) => {
  const body = requireObject(req.body);
  created(res, store.addItem('appointments', {
    patientId: requirePatient(body.patientId).id,
    title: cleanText(body.title, 'title', { required: true }),
    start: cleanDateTime(body.start, 'start'),
    details: cleanText(body.details, 'details', { max: 120 }),
    tone: 'teal',
  }));
});

app.get('/api/v1/activity', (req, res) => {
  const activity = store.listActivity(requirePatient(req.query.patientId).id);
  res.json(activity.slice(-50).reverse());
});

// Server-sent events: caregivers get relief notifications the moment they happen.
let streamClients = 0;
app.get('/api/v1/activity/stream', (req, res) => {
  const patient = requirePatient(req.query.patientId);
  if (streamClients >= MAX_STREAM_CLIENTS) {
    res.status(503).json({ error: 'Too many live connections' });
    return;
  }
  streamClients += 1;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const unsubscribe = store.onActivity((entry) => {
    if (entry.patientId === patient.id) res.write(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    streamClients -= 1;
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post('/api/v1/voice/announce', voiceLimiters, async (req, res) => {
  const text = cleanText(requireObject(req.body).text, 'text', { max: 600, required: true });
  const audio = await synthesize(text);
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
  res.send(audio);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express 5 forwards rejected promises from async handlers here too.
// Only deliberate, client-facing messages are returned; everything else is generic.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  // ValidationError, VoiceError and the 404 helpers set expose; anything else is unexpected.
  if (!err.expose) console.error(err);
  res.status(status).json({ error: err.expose ? err.message : 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  if (!isVoiceConfigured()) console.log('ELEVENLABS_API_KEY not set: read aloud will use browser speech.');
});
