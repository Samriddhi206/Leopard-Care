// In-memory data store persisted to server/data/db.json (gitignored).
// Small and synchronous on purpose: this is a single-process demo backend.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), 'data', 'db.json');
const DATA_VERSION = 1;

// Caps keep a misbehaving client from growing memory or the data file without bound.
export const LIMITS = { itemsPerPatient: 200, activityPerPatient: 100 };

function seed() {
  return {
    version: DATA_VERSION,
    patients: [
      { id: 'marta', name: 'Marta Johnson', phone: '', address: 'Room 210', dob: '' },
      { id: 'john', name: 'John Doe', phone: '', address: '48 Elm Street', dob: '' },
    ],
    // Marta's ids match the ids the app used before the API existed, so saved
    // per-item preferences (alert toggles, read state) carry over.
    tasks: [
      { id: 'bath', patientId: 'marta', title: 'Bath routine', time: '9:00 AM', icon: '🧼', status: 'done' },
      { id: 'lunch', patientId: 'marta', title: 'Lunch prep', time: '12:30 PM', icon: '🥗', status: 'pending' },
      { id: 'walk', patientId: 'marta', title: 'Walk & stretch', time: '3:15 PM', icon: '🚶', status: 'pending' },
      { id: 'blood-pressure', patientId: 'marta', title: 'Blood pressure log', time: '6:00 PM', icon: '🩺', status: 'pending' },
      { id: 'bedtime', patientId: 'marta', title: 'Prepare for bed', time: '9:00 PM', icon: '🌙', status: 'pending' },
      { id: 'john-walk', patientId: 'john', title: 'Morning walk', time: '8:00 AM', icon: '🚶', status: 'pending' },
      { id: 'john-physio', patientId: 'john', title: 'Physio exercises', time: '11:00 AM', icon: '🏋️', status: 'pending' },
      { id: 'john-lunch', patientId: 'john', title: 'Lunch', time: '12:00 PM', icon: '🥪', status: 'pending' },
      { id: 'john-glucose', patientId: 'john', title: 'Glucose check', time: '5:00 PM', icon: '🩸', status: 'pending' },
    ],
    medications: [
      { id: 'morning-medication', patientId: 'marta', name: 'Morning medication', dose: '', time: '8:30 AM', note: 'With breakfast', stock: { left: 18, total: 30 }, status: 'pending' },
      { id: 'evening-medication', patientId: 'marta', name: 'Evening medication', dose: '', time: '8:00 PM', note: 'After dinner', stock: { left: 12, total: 30 }, status: 'pending' },
      { id: 'john-metformin', patientId: 'john', name: 'Metformin', dose: '500 mg', time: '8:00 AM', note: 'With breakfast', stock: { left: 40, total: 60 }, status: 'pending' },
      { id: 'john-atorvastatin', patientId: 'john', name: 'Atorvastatin', dose: '20 mg', time: '9:00 PM', note: '', stock: { left: 4, total: 30 }, status: 'pending' },
    ],
    appointments: [
      { id: 'medication-review', patientId: 'marta', title: 'Medication review', start: '2026-10-02T08:30', details: 'Dr. Nguyen', tone: 'teal' },
      { id: 'physical-therapy', patientId: 'marta', title: 'Physical therapy', start: '2026-10-03T10:00', details: 'Home visit', tone: 'amber' },
      { id: 'care-team-meeting', patientId: 'marta', title: 'Care team meeting', start: '2026-10-05T13:30', details: 'Video call', tone: 'red' },
      { id: 'john-labs', patientId: 'john', title: 'Lab work', start: '2026-10-04T08:00', details: 'Fasting blood test', tone: 'amber' },
      { id: 'john-cardiology', patientId: 'john', title: 'Cardiology follow-up', start: '2026-10-06T10:30', details: 'Dr. Patel', tone: 'teal' },
    ],
    activity: [],
  };
}

function load() {
  try {
    const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (data?.version === DATA_VERSION) return data;
  } catch {
    // Missing or unreadable file: start from seed data.
  }
  return seed();
}

const db = load();
let saveTimer = null;

// Debounced, atomic write (temp file + rename) so a crash can't leave half a file.
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      const temp = `${DATA_FILE}.tmp`;
      writeFileSync(temp, JSON.stringify(db, null, 2));
      renameSync(temp, DATA_FILE);
    } catch (error) {
      console.error('Could not save data file:', error.message);
    }
  }, 100);
}

const byPatient = (patientId) => (item) => item.patientId === patientId;

export function getPatients() {
  return db.patients;
}

export function getPatient(id) {
  return db.patients.find((patient) => patient.id === id) ?? null;
}

export function updatePatient(id, changes) {
  const patient = getPatient(id);
  if (!patient) return null;
  Object.assign(patient, changes);
  scheduleSave();
  return patient;
}

export function listItems(collection, patientId) {
  return db[collection].filter(byPatient(patientId));
}

export function findItem(collection, id) {
  return db[collection].find((item) => item.id === id) ?? null;
}

// Returns null when the patient is at the per-patient cap.
export function addItem(collection, item) {
  if (listItems(collection, item.patientId).length >= LIMITS.itemsPerPatient) return null;
  const created = { id: randomUUID(), ...item };
  db[collection].push(created);
  scheduleSave();
  return created;
}

export function updateItem(collection, id, changes) {
  const item = findItem(collection, id);
  if (!item) return null;
  Object.assign(item, changes);
  scheduleSave();
  return item;
}

// --- Relief notifications (patient activity for caregivers) ------------------

const activityListeners = new Set();

export function listActivity(patientId) {
  return db.activity.filter(byPatient(patientId));
}

export function recordActivity(entry) {
  const created = { id: randomUUID(), at: new Date().toISOString(), ...entry };
  db.activity.push(created);
  // Keep only the newest entries per patient.
  const forPatient = listActivity(entry.patientId);
  if (forPatient.length > LIMITS.activityPerPatient) {
    const drop = new Set(forPatient.slice(0, forPatient.length - LIMITS.activityPerPatient));
    db.activity = db.activity.filter((item) => !drop.has(item));
  }
  scheduleSave();
  activityListeners.forEach((listener) => listener(created));
  return created;
}

export function onActivity(listener) {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}
