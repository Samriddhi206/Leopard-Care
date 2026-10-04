// Dashboard: renders the selected patient's day and handles every interaction.
// Tasks, medications, appointments and patient details live on the API server;
// per-patient preferences (care team, care notes, alert toggles, read state)
// live in localStorage on this device.
import * as api from './api.js';
import { isSpeaking, speak, stop as stopSpeaking } from './voice.js';

const screens = document.querySelectorAll('.screen');
const navItems = document.querySelectorAll('.nav-item');
const toast = document.getElementById('toast');
const dialog = document.getElementById('app-dialog');
const dialogForm = document.getElementById('dialog-form');
const dialogTitle = document.getElementById('dialog-title');
const dialogContent = document.getElementById('dialog-content');
const dialogSave = document.getElementById('dialog-save');

const SELECTED_PATIENT_KEY = 'selectedPatientId';
const PATIENTS_CACHE_KEY = 'leopard-care-patients';
const LEGACY_STATE_KEY = 'leopard-care-state';
const DEVICE_KEY = 'leopard-care-device';
const prefsKey = (id) => `leopard-care-prefs:${id}`;
const cacheKey = (id) => `leopard-care-cache:${id}`;

const notificationIds = ['medication', 'hydration', 'family', 'battery'];
const LOW_STOCK = 5;
const APPOINTMENT_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Demo patients shown before the API answers (or if it can't be reached), so the
// caregiver patient switcher always has something to switch between.
const FALLBACK_PATIENTS = [
  { id: 'marta', name: 'Marta Johnson', phone: '', address: 'Room 210', dob: '' },
  { id: 'john', name: 'John Doe', phone: '', address: '48 Elm Street', dob: '' }
];
const RELIEF_VERBS = { 'task-done': 'completed', 'medication-taken': 'took', 'check-in': 'checked in' };
const RELIEF_ICONS = { 'task-done': '✅', 'medication-taken': '💊', 'check-in': '👋' };

let alertFilter = 'all';
let batteryManager = null;
let batteryEventsBound = false;
let batteryWarningShown = false;
let patients = [];
let patientId = null;
let data = emptyData();
let prefs = null;
let closeActivityStream = null;
let activeReadButton = null;
const pendingItems = new Set();

// --- Storage ----------------------------------------------------------------

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function emptyData() {
  return { tasks: [], medications: [], appointments: [], activity: [] };
}

function defaultPrefs(id) {
  const isMarta = id === 'marta';
  return {
    caregivers: isMarta ? [{ id: 'sarah', name: 'Sarah Johnson', role: 'Daughter', phone: '+15035550191' }] : [],
    selectedContactId: isMarta ? 'sarah' : '',
    attentionItems: isMarta
      ? [{ id: 'nurse-update', title: 'Visiting nurse update', detail: 'Check blood pressure log before evening check-in.', status: 'open' }]
      : [],
    dismissedAttention: [],
    alertsDisabled: [],
    readNotifications: [],
    readMissedTasks: [],
    hydration: 6,
    profile: {},
    allergies: isMarta
      ? [{ id: 'penicillin', name: 'Penicillin', note: 'Causes rash' }]
      : [],
    seenActivityAt: ''
  };
}

function loadPrefs(id) {
  const saved = asObject(readJson(prefsKey(id), {}));
  const loaded = { ...defaultPrefs(id) };
  ['caregivers', 'attentionItems', 'dismissedAttention', 'alertsDisabled', 'readNotifications', 'readMissedTasks', 'allergies'].forEach((key) => {
    if (Array.isArray(saved[key])) loaded[key] = saved[key];
  });
  if (typeof saved.selectedContactId === 'string') loaded.selectedContactId = saved.selectedContactId;
  if (Number.isFinite(Number(saved.hydration))) loaded.hydration = Number(saved.hydration);
  if (typeof saved.seenActivityAt === 'string') loaded.seenActivityAt = saved.seenActivityAt;
  loaded.profile = asObject(saved.profile);
  return loaded;
}

function savePrefs() {
  if (!writeJson(prefsKey(patientId), prefs)) showToast('Changes saved for this visit');
}

// Before the API existed, all state lived under one key for Marta. Keep the
// per-device parts (care team, notes, alert toggles, read state, hydration);
// schedule data now comes from the server.
function migrateLegacyState() {
  const legacy = readJson(LEGACY_STATE_KEY, null);
  if (!legacy || localStorage.getItem(prefsKey('marta'))) return;
  const migrated = defaultPrefs('marta');
  if (legacy.version === 2) {
    ['caregivers', 'attentionItems', 'dismissedAttention', 'alertsDisabled', 'readNotifications', 'readMissedTasks'].forEach((key) => {
      if (Array.isArray(legacy[key])) migrated[key] = legacy[key];
    });
    if (typeof legacy.selectedContactId === 'string') migrated.selectedContactId = legacy.selectedContactId;
  } else {
    migrated.caregivers.push(...asArray(legacy.caregivers)
      .filter((caregiver) => caregiver?.name)
      .map((caregiver, index) => ({ ...caregiver, id: caregiver.id || `caregiver-saved-${index}` })));
    if (Array.isArray(legacy.readNotifications)) migrated.readNotifications = legacy.readNotifications;
  }
  if (Number.isFinite(Number(legacy.hydration))) migrated.hydration = Number(legacy.hydration);
  migrated.profile = asObject(legacy.profile);
  const device = asObject(readJson(DEVICE_KEY, {}));
  device.batteryReminderEnabled = Boolean(legacy.batteryReminderEnabled);
  writeJson(DEVICE_KEY, device);
  if (writeJson(prefsKey('marta'), migrated)) localStorage.removeItem(LEGACY_STATE_KEY);
}

function deviceSettings() {
  return asObject(readJson(DEVICE_KEY, {}));
}

function saveDeviceSettings(changes) {
  writeJson(DEVICE_KEY, { ...deviceSettings(), ...changes });
}

// --- Patient data -----------------------------------------------------------

function currentPatient() {
  return patients.find((patient) => patient.id === patientId) || patients[0] || FALLBACK_PATIENTS[0];
}

async function loadPatients() {
  try {
    patients = await api.fetchPatients();
    writeJson(PATIENTS_CACHE_KEY, patients);
  } catch {
    patients = asArray(readJson(PATIENTS_CACHE_KEY, null));
    if (!patients.length) patients = FALLBACK_PATIENTS;
  }
}

// Fetch everything for the selected patient; fall back to the last snapshot when offline.
async function loadPatientData({ quiet = false } = {}) {
  const id = patientId;
  try {
    const [tasks, medications, appointments, activity] = await Promise.all([
      api.fetchTasks(id),
      api.fetchMedications(id),
      api.fetchAppointments(id),
      api.fetchActivity(id)
    ]);
    if (id !== patientId) return; // patient switched while loading
    data = { tasks, medications, appointments, activity };
    writeJson(cacheKey(id), data);
  } catch {
    if (id !== patientId) return;
    data = { ...emptyData(), ...asObject(readJson(cacheKey(id), {})) };
    if (!quiet) showToast('Offline: showing the last saved schedule');
  }
}

function cacheData() {
  writeJson(cacheKey(patientId), data);
}

// One list for rendering: medications and daily tasks share the same row UI.
function catalog() {
  return [
    ...data.medications.map((medication) => ({
      id: medication.id,
      kind: 'medication',
      title: [medication.name, medication.dose].filter(Boolean).join(' · '),
      time: medication.time,
      note: medication.note,
      icon: '💊',
      status: medication.status,
      stock: medication.stock
    })),
    ...data.tasks.map((task) => ({
      id: task.id,
      kind: 'task',
      title: task.title,
      time: task.time,
      icon: task.icon,
      status: task.status
    }))
  ];
}

function isMedication(item) {
  return item?.kind === 'medication';
}

function findItem(id) {
  return catalog().find((item) => item.id === id);
}

function findAppointment(id) {
  return data.appointments.find((appointment) => appointment.id === id);
}

function statusOf(id) {
  return findItem(id)?.status || 'pending';
}

function alertsEnabled(id) {
  return !prefs.alertsDisabled.includes(id);
}

// Saves a status change on the server, which adjusts medication stock and
// records a relief notification when the actor is the patient.
async function setItemStatus(item, status) {
  if (pendingItems.has(item.id)) return null;
  pendingItems.add(item.id);
  try {
    const updated = isMedication(item)
      ? await api.updateMedication(item.id, { status })
      : await api.updateTask(item.id, { status });
    const list = isMedication(item) ? data.medications : data.tasks;
    Object.assign(list.find((record) => record.id === item.id) || {}, updated);
    cacheData();
    return findItem(item.id);
  } catch (error) {
    showToast(`Couldn't save: ${error.message}`);
    return null;
  } finally {
    pendingItems.delete(item.id);
  }
}

// --- Formatting ---------------------------------------------------------------

function currentRole() {
  return document.documentElement.dataset.role;
}

function isCaregiver() {
  return currentRole() === 'caregiver';
}

// Task times are display strings ("9:00 AM", "19:30", "Anytime"); returns minutes after midnight.
function parseTaskTime(text) {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([AP])\.?M\.?)?$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  let hours = Number(match[1]) % 24;
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'P' && hours < 12) hours += 12;
  if (meridiem === 'A' && hours === 12) hours = 0;
  return hours * 60 + Number(match[2]);
}

// Timed items first, in time order; "Anytime" items last.
function byTime(a, b) {
  const aTime = parseTaskTime(a.time);
  const bTime = parseTaskTime(b.time);
  if (aTime === bTime) return 0;
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  return aTime - bTime;
}

function byStart(a, b) {
  return new Date(a.start) - new Date(b.start) || a.title.localeCompare(b.title);
}

function initials(name) {
  return name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function firstName(name) {
  return name.trim().split(/\s+/)[0] || name;
}

function formatPhone(phone) {
  const match = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(String(phone).replace(/[\s().-]/g, ''));
  return match ? `+1 (${match[1]}) ${match[2]}-${match[3]}` : phone;
}

function formatClock(value) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// <input type="time"> gives "HH:MM"; the API stores "h:mm AM/PM" regardless of locale.
function formatTimeInput(value) {
  if (!value) return 'Anytime';
  const [hours, minutes] = value.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function relativeDay(start, now = new Date()) {
  const date = new Date(start);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === now.toDateString()) return 'today';
  if (date.toDateString() === tomorrow.toDateString()) return 'tomorrow';
  return date.toLocaleDateString([], { weekday: 'long' });
}

const STATUS_LABELS = { done: 'Done', late: 'Late', pending: 'Pending' };

function taskDetail(item) {
  return [item.time, item.note].filter(Boolean).join(' • ');
}

function statusToast(item) {
  if (item.status === 'late') return `${item.title} marked late`;
  if (item.status !== 'done') return `${item.title} reopened`;
  if (!isMedication(item) || !item.stock) return `${item.title} completed`;
  if (item.stock.left === 0) return `${item.title} logged · Out of stock, refill needed`;
  return `${item.title} logged · ${item.stock.left} left${item.stock.left <= LOW_STOCK ? ', refill soon' : ''}`;
}

function reliefMessage(entry) {
  const name = firstName(currentPatient().name);
  if (entry.type === 'check-in') return `${name} checked in`;
  return `${name} ${RELIEF_VERBS[entry.type] || 'updated'} ${entry.subject}`;
}

// --- Derived lists -----------------------------------------------------------

function getMissedTasks(now = new Date()) {
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return catalog().filter((item) => {
    if (item.status === 'done' || !alertsEnabled(item.id)) return false;
    const dueAt = parseTaskTime(item.time);
    return dueAt !== null && dueAt < minutesNow;
  }).sort(byTime);
}

function getImminentAppointments(now = new Date()) {
  return data.appointments.filter((appointment) => {
    const startsIn = new Date(appointment.start) - now;
    return alertsEnabled(appointment.id) && startsIn > 0 && startsIn <= APPOINTMENT_ALERT_WINDOW_MS;
  }).sort(byStart);
}

function nextMedication() {
  return catalog().filter(isMedication).sort(byTime).find((item) => item.status !== 'done');
}

// Manual care notes plus automated flags (overdue items, appointments within 24h) whose alerts are on.
function getAttentionItems() {
  const manual = prefs.attentionItems
    .filter((item) => item.status === 'open')
    .map((item) => ({ ...item, kind: 'manual' }));
  const overdue = getMissedTasks().map((item) => ({
    id: `task:${item.id}`,
    kind: 'task',
    sourceId: item.id,
    title: `${item.title} is overdue`,
    detail: `Was due at ${item.time}${item.status === 'late' ? ' • Marked late' : ''}`
  }));
  const upcoming = getImminentAppointments().map((appointment) => ({
    id: `appointment:${appointment.id}`,
    kind: 'appointment',
    sourceId: appointment.id,
    title: `${appointment.title} ${relativeDay(appointment.start)}`,
    detail: appointment.details ? `${formatClock(appointment.start)} • ${appointment.details}` : formatClock(appointment.start)
  }));
  return [
    ...manual,
    ...[...overdue, ...upcoming].filter((item) => !prefs.dismissedAttention.includes(item.id))
  ];
}

function unseenActivity() {
  return data.activity.filter((entry) => entry.at > prefs.seenActivityAt);
}

// --- Rendering ---------------------------------------------------------------

function createButton(className, text, dataset, attributes = {}) {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = text;
  Object.assign(button.dataset, dataset);
  Object.entries(attributes).forEach(([name, value]) => button.setAttribute(name, value));
  return button;
}

function statusPill(status) {
  const pill = document.createElement('span');
  pill.className = `status-pill status-${status}`;
  pill.textContent = STATUS_LABELS[status] || STATUS_LABELS.pending;
  return pill;
}

function buildAlertToggle(id, title) {
  const enabled = alertsEnabled(id);
  return createButton('alert-toggle', enabled ? '🔔' : '🔕', { action: 'toggle-alert', alertId: id }, {
    'aria-pressed': String(enabled),
    'aria-label': `Alerts for ${title}`,
    title: enabled ? 'Alerts on' : 'Alerts off'
  });
}

function buildLateToggle(item) {
  const isLate = item.status === 'late';
  return createButton(`mini-tag late-tag${isLate ? ' is-active' : ''}`, 'Late', { action: 'task-late', taskId: item.id }, {
    'aria-pressed': String(isLate),
    'aria-label': `Mark ${item.title} late`
  });
}

function buildTaskCopy(item) {
  const copy = document.createElement('div');
  copy.className = 'task-copy';
  const title = document.createElement('h3');
  title.textContent = item.title;
  const meta = document.createElement('p');
  meta.className = 'task-meta';
  meta.append(statusPill(item.status), document.createTextNode(taskDetail(item)));
  copy.append(title, meta);
  return copy;
}

function buildIcon(item) {
  const icon = document.createElement('div');
  icon.className = 'task-icon icon-soft';
  icon.textContent = item.icon;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function buildTaskRow(item, { controls = false } = {}) {
  const row = document.createElement('div');
  row.className = 'task-item compact-row check-row';
  row.classList.toggle('is-complete', item.status === 'done');
  row.classList.toggle('is-late', item.status === 'late');

  const label = document.createElement('label');
  label.className = 'check-label';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'task-check';
  checkbox.dataset.taskCheck = item.id;
  checkbox.checked = item.status === 'done';
  label.append(checkbox, buildIcon(item), buildTaskCopy(item));
  row.append(label);

  if (controls) {
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (item.status !== 'done') actions.append(buildLateToggle(item));
    actions.append(buildAlertToggle(item.id, item.title));
    row.append(actions);
  }
  return row;
}

function emptyMessage(text) {
  const empty = document.createElement('p');
  empty.className = 'task-empty';
  empty.textContent = text;
  return empty;
}

function renderSchedule() {
  const sorted = catalog().sort(byTime);
  const controls = isCaregiver();
  const tasks = sorted.filter((item) => !isMedication(item) && item.status !== 'done');
  const medications = sorted.filter(isMedication);
  document.querySelector('[data-schedule-tasks]').replaceChildren(
    ...(tasks.length ? tasks.map((item) => buildTaskRow(item, { controls })) : [emptyMessage('No incomplete tasks')])
  );
  document.querySelector('[data-schedule-medications]').replaceChildren(
    ...(medications.length ? medications.map((item) => buildTaskRow(item, { controls })) : [emptyMessage('No medications yet')])
  );
}

// Home "Today's care": medications have their own prompt above, so only daily tasks show here.
function renderTasks() {
  const taskList = document.querySelector('[data-task-list]');
  const dailyTasks = catalog().filter((item) => !isMedication(item)).sort(byTime);

  if (currentRole() === 'patient') {
    taskList.replaceChildren(...(dailyTasks.length ? dailyTasks.map((item) => buildTaskRow(item)) : [emptyMessage('No tasks today')]));
    return;
  }

  const openTasks = dailyTasks.filter((item) => item.status !== 'done').slice(0, 3);
  if (openTasks.length === 0) {
    taskList.replaceChildren(emptyMessage('All caught up'));
    return;
  }

  taskList.replaceChildren(...openTasks.map((item) => {
    const row = document.createElement('div');
    row.className = 'task-item compact-row';
    row.classList.toggle('is-late', item.status === 'late');
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    actions.append(
      createButton('mini-tag done-tag', 'Done', { action: 'task-done', taskId: item.id }, { 'aria-label': `Mark ${item.title} done` }),
      buildLateToggle(item)
    );
    row.append(buildIcon(item), buildTaskCopy(item), actions);
    return row;
  }));
}

// Reminder card: the next medication not yet taken today, or nothing once all are logged.
function renderMedicationPrompt() {
  const next = nextMedication();
  document.querySelector('[data-med-prompt]').hidden = !next;
  document.querySelector('[data-med-prompt-done]').hidden = Boolean(next);
  document.querySelector('[data-med-prompt-done]').textContent = data.medications.length
    ? 'All medications logged for today.'
    : 'No medications scheduled.';
  if (!next) return;

  document.querySelector('[data-med-title]').textContent = next.title;
  document.querySelector('[data-med-detail]').replaceChildren(statusPill(next.status), document.createTextNode(taskDetail(next)));
  const takenButton = document.querySelector('[data-med-taken]');
  takenButton.dataset.taskId = next.id;
  takenButton.setAttribute('aria-label', `Mark ${next.title} taken`);

  const { stock } = next;
  const supply = document.querySelector('[data-med-prompt] .supply-wrap');
  supply.hidden = !stock;
  if (!stock) return;
  const isLow = stock.left <= LOW_STOCK;
  supply.classList.toggle('is-low', isLow);
  document.querySelector('[data-med-supply]').textContent =
    `${stock.left}/${stock.total} left${stock.left === 0 ? ' · Out of stock' : isLow ? ' · Refill soon' : ''}`;
  document.querySelector('[data-med-supply-fill]').style.width = `${Math.round((stock.left / stock.total) * 100)}%`;
  document.querySelector('[data-med-supply-track]').setAttribute('aria-label', `${stock.left} of ${stock.total} doses left`);
}

function updateSummary() {
  const items = catalog();
  const completed = items.filter((item) => item.status === 'done').length;
  document.querySelector('[data-completed-count]').textContent = `${completed}/${items.length}`;
  document.querySelector('[data-task-total]').textContent = `${items.length} tasks`;
  document.querySelector('[data-hydration-count]').textContent = `${prefs.hydration}/8`;
}

function renderPatient() {
  const patient = currentPatient();
  document.querySelectorAll('[data-patient-name]').forEach((el) => { el.textContent = patient.name; });
  document.querySelectorAll('[data-patient-first-name]').forEach((el) => { el.textContent = firstName(patient.name); });
  document.querySelector('[data-patient-initials]').textContent = initials(patient.name);

  const details = document.querySelector('[data-patient-details]');
  details.replaceChildren();
  [
    ['Phone', patient.phone ? formatPhone(patient.phone) : ''],
    ['Address', patient.address],
    ['Date of birth', patient.dob ? new Date(`${patient.dob}T00:00`).toLocaleDateString([], { dateStyle: 'medium' }) : '']
  ].forEach(([term, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value || 'Not set';
    dd.classList.toggle('is-empty', !value);
    details.append(dt, dd);
  });

  // Topbar: user badge, caregiver patient switcher and relief count.
  const caregiverView = isCaregiver();
  document.querySelector('[data-user-initials]').textContent = caregiverView ? '🤝' : initials(patient.name);
  document.querySelector('[data-user-name]').textContent = caregiverView ? 'Caregiver' : firstName(patient.name);
  document.querySelector('[data-user-role]').textContent = caregiverView ? `${patients.length} patients` : 'Patient';

  const select = document.querySelector('[data-patient-select]');
  select.replaceChildren(...patients.map((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    return option;
  }));
  select.value = patient.id;

  const unseen = caregiverView ? unseenActivity().length : 0;
  const pill = document.querySelector('[data-activity-pill]');
  pill.hidden = unseen === 0;
  document.querySelector('[data-activity-count]').textContent = String(unseen);
  pill.setAttribute('aria-label', `${unseen} new update${unseen === 1 ? '' : 's'} from ${firstName(patient.name)}`);
}

function renderCaregivers() {
  const list = document.querySelector('[data-caregiver-list]');
  if (prefs.caregivers.length === 0) {
    list.replaceChildren(emptyMessage('No caregivers linked yet'));
  } else {
    list.replaceChildren(...prefs.caregivers.map((caregiver) => {
      const row = document.createElement('div');
      row.className = 'caregiver-row';
      const avatar = document.createElement('div');
      avatar.className = 'caregiver-avatar';
      avatar.textContent = initials(caregiver.name);
      avatar.setAttribute('aria-hidden', 'true');

      const details = document.createElement('div');
      details.className = 'caregiver-details';
      const name = document.createElement('strong');
      name.textContent = caregiver.name;
      const contact = document.createElement('span');
      contact.textContent = `${caregiver.role} · ${formatPhone(caregiver.phone)}`;
      details.append(name, contact);

      const actions = document.createElement('div');
      actions.className = 'caregiver-actions';
      actions.append(createButton('caregiver-action', 'Edit', { action: 'edit-caregiver', caregiverId: caregiver.id }, { 'aria-label': `Edit ${caregiver.name}` }));
      if (isCaregiver()) {
        actions.append(createButton('caregiver-action caregiver-remove', 'Remove', { action: 'remove-caregiver', caregiverId: caregiver.id }, { 'aria-label': `Remove ${caregiver.name}` }));
      }
      row.append(avatar, details, actions);
      return row;
    }));
  }
  document.querySelector('[data-caregiver-count]').textContent = String(prefs.caregivers.length);
}

function renderAllergies() {
  const list = document.querySelector('[data-allergy-list]');
  if (prefs.allergies.length === 0) {
    list.replaceChildren(emptyMessage('No allergies recorded'));
    return;
  }

  list.replaceChildren(...prefs.allergies.map((allergy) => {
    const row = document.createElement('div');
    row.className = 'caregiver-row';
    const avatar = document.createElement('div');
    avatar.className = 'caregiver-avatar';
    avatar.textContent = '⚠️';
    avatar.setAttribute('aria-hidden', 'true');

    const details = document.createElement('div');
    details.className = 'caregiver-details';
    const name = document.createElement('strong');
    name.textContent = allergy.name;
    details.append(name);
    if (allergy.note) {
      const note = document.createElement('span');
      note.textContent = allergy.note;
      details.append(note);
    }

    const actions = document.createElement('div');
    actions.className = 'caregiver-actions';
    actions.append(createButton('caregiver-action caregiver-remove', 'Delete', { action: 'remove-allergy', allergyId: allergy.id }, { 'aria-label': `Delete ${allergy.name}` }));
    row.append(avatar, details, actions);
    return row;
  }));
}

function selectedCaregiver() {
  return prefs.caregivers.find((caregiver) => caregiver.id === prefs.selectedContactId) || prefs.caregivers[0] || null;
}

function renderContactCard() {
  const select = document.querySelector('[data-contact-select]');
  const selected = selectedCaregiver();
  select.replaceChildren(...prefs.caregivers.map((caregiver) => {
    const option = document.createElement('option');
    option.value = caregiver.id;
    option.textContent = `${caregiver.name} (${caregiver.role})`;
    return option;
  }));
  select.disabled = !selected;
  if (selected) select.value = selected.id;

  document.querySelector('[data-contact-details]').textContent = selected
    ? `${selected.role} • ${formatPhone(selected.phone)}`
    : 'No caregivers linked yet.';
  document.querySelectorAll('[data-contact-button]').forEach((button) => {
    button.disabled = !selected;
    button.dataset.contactName = selected?.name || '';
    button.dataset.phone = selected?.phone || '';
  });
}

let lastAttentionSignature = '';

function renderAttention() {
  const items = getAttentionItems();
  const caregiverView = isCaregiver();
  // The minute timer calls this too; skip re-rendering (and stealing focus) when nothing changed.
  const signature = JSON.stringify([patientId, caregiverView, items.map(({ id, title, detail }) => [id, title, detail])]);
  if (signature === lastAttentionSignature) return;
  lastAttentionSignature = signature;
  document.querySelector('[data-attention-card]').hidden = items.length === 0 && !caregiverView;

  const list = document.querySelector('[data-attention-list]');
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'attention-empty';
    empty.textContent = 'Nothing needs attention right now.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...items.map((item) => {
    const article = document.createElement('article');
    article.className = 'attention-item';
    article.dataset.attentionItem = item.id;

    const tag = document.createElement('span');
    tag.className = 'attention-source';
    tag.textContent = item.kind === 'manual' ? 'Care note' : 'Automatic alert';
    const title = document.createElement('h3');
    title.textContent = item.title;
    article.append(tag, title);
    if (item.detail) {
      const detail = document.createElement('p');
      detail.textContent = item.detail;
      article.append(detail);
    }

    if (caregiverView) {
      const actions = document.createElement('div');
      actions.className = 'attention-actions';
      const ids = { attentionId: item.id };
      if (item.kind === 'manual') {
        actions.append(createButton('mini-tag', 'Edit', { action: 'edit-attention', ...ids }, { 'aria-label': `Edit ${item.title}` }));
      }
      if (item.kind !== 'appointment') {
        actions.append(createButton('mini-tag done-tag', item.kind === 'task' ? 'Mark done' : 'Resolve', { action: 'resolve-attention', ...ids }, { 'aria-label': `Resolve ${item.title}` }));
      }
      actions.append(createButton('mini-tag pending-tag', 'Dismiss', { action: 'dismiss-attention', ...ids }, { 'aria-label': `Dismiss ${item.title}` }));
      if (item.kind !== 'manual') {
        actions.append(createButton('mini-tag', 'Turn off alerts', { action: 'toggle-alert', alertId: item.sourceId }, { 'aria-label': `Turn off alerts for ${item.title}` }));
      }
      article.append(actions);
    }
    return article;
  }));
}

// Caregiver "Recent activity": relief notifications from the patient's device.
function renderActivity() {
  const list = document.querySelector('[data-activity-list]');
  const entries = data.activity.slice(0, 8);
  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'activity-empty';
    empty.textContent = `No updates from ${firstName(currentPatient().name)} yet.`;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...entries.map((entry) => {
    const item = document.createElement('li');
    item.className = 'activity-item';
    item.classList.toggle('is-new', entry.at > prefs.seenActivityAt);
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = RELIEF_ICONS[entry.type] || '•';
    const text = document.createElement('span');
    text.className = 'activity-text';
    text.textContent = reliefMessage(entry);
    const time = document.createElement('time');
    time.dateTime = entry.at;
    time.textContent = formatClock(entry.at);
    item.append(icon, text, time);
    return item;
  }));
}

const APPOINTMENT_TONES = { teal: ['', 'tag-teal'], amber: ['amber', 'tag-amber'], red: ['red', 'tag-red'] };

function renderAppointments() {
  const appointments = [...data.appointments].sort(byStart);
  const caregiverView = isCaregiver();
  const list = document.querySelector('[data-appointment-list]');
  if (appointments.length === 0) {
    list.replaceChildren(emptyMessage('No appointments scheduled'));
    return;
  }

  list.replaceChildren(...appointments.map((appointment) => {
    const start = new Date(appointment.start);
    const [blockTone, tagTone] = APPOINTMENT_TONES[appointment.tone] || APPOINTMENT_TONES.teal;
    const card = document.createElement('div');
    card.className = 'card schedule-card';
    card.dataset.appointmentId = appointment.id;

    const dateBlock = document.createElement('div');
    dateBlock.className = `date-block ${blockTone}`.trim();
    const month = document.createElement('span');
    month.className = 'month';
    month.textContent = start.toLocaleString([], { month: 'short' }).toUpperCase();
    const day = document.createElement('strong');
    day.textContent = String(start.getDate()).padStart(2, '0');
    dateBlock.append(month, day);

    const copy = document.createElement('div');
    copy.className = 'schedule-copy';
    const title = document.createElement('h3');
    title.textContent = appointment.title;
    const details = document.createElement('p');
    details.textContent = appointment.details ? `${formatClock(start)} • ${appointment.details}` : formatClock(start);
    copy.append(title, details);

    const [datePart, timePart] = appointment.start.split('T');
    const actions = document.createElement('div');
    actions.className = 'appointment-actions';
    actions.append(createButton(`schedule-tag ${tagTone} calendar-action`, 'Add to calendar', {
      event: appointment.title,
      date: datePart.replaceAll('-', ''),
      time: `${timePart.replace(':', '').slice(0, 4)}00`,
      description: appointment.details ? `${appointment.title} · ${appointment.details}` : appointment.title
    }));
    if (caregiverView) actions.append(buildAlertToggle(appointment.id, appointment.title));

    card.append(dateBlock, copy, actions);
    return card;
  }));
}

function syncNotificationState() {
  // The missed-tasks alert only exists while something is overdue, and turns
  // unread again whenever a task the user hasn't seen becomes overdue.
  const missedTasks = getMissedTasks();
  const missedAlert = document.querySelector('[data-missed-alert]');
  missedAlert.querySelector('[data-missed-title]').textContent =
    missedTasks.length === 1 ? '1 task overdue' : `${missedTasks.length} tasks overdue`;
  missedAlert.querySelector('[data-missed-list]').textContent = missedTasks.map((item) => item.title).join(', ');
  const isRead = (id) => id === 'missed-tasks'
    ? missedTasks.every((item) => prefs.readMissedTasks.includes(item.id))
    : prefs.readNotifications.includes(id);
  const activeIds = missedTasks.length ? [...notificationIds, 'missed-tasks'] : notificationIds;

  const unreadCount = activeIds.filter((id) => !isRead(id)).length;
  document.querySelector('[data-unread-count]').textContent = `${unreadCount} unread`;
  const badge = document.querySelector('[data-badge-count]');
  badge.textContent = unreadCount;
  badge.hidden = unreadCount === 0;
  // Lets src/main.js reconcile the server badge count with local read state.
  badge.dataset.localUnread = unreadCount;
  document.dispatchEvent(new CustomEvent('notifications:sync', { detail: { unreadCount } }));

  let visibleCount = 0;
  document.querySelectorAll('[data-notification]').forEach((item) => {
    const id = item.dataset.notificationId;
    const read = isRead(id);
    item.classList.toggle('is-read', read);
    item.hidden = (id === 'missed-tasks' && missedTasks.length === 0) || (alertFilter === 'unread' && read);
    if (!item.hidden) visibleCount += 1;
  });

  document.querySelectorAll('[data-alert-filter]').forEach((button) => {
    const isActive = button.dataset.alertFilter === alertFilter;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  document.querySelector('[data-notification-empty]').hidden = visibleCount > 0;
  const batteryEnabled = Boolean(deviceSettings().batteryReminderEnabled);
  const batteryButton = document.querySelector('[data-action="toggle-battery"]');
  batteryButton.textContent = batteryEnabled ? 'Disable reminder' : 'Enable reminder';
  batteryButton.setAttribute('aria-pressed', String(batteryEnabled));
}

function syncStateToPage() {
  renderPatient();
  renderMedicationPrompt();
  renderTasks();
  updateSummary();
  renderCaregivers();
  renderAllergies();
  renderContactCard();
  renderAppointments();
  renderSchedule();
  renderAttention();
  renderActivity();
  syncNotificationState();
}

// Lists re-render on every change; put keyboard focus back on the matching control.
function syncKeepingFocus(control, selector) {
  const scope = control.closest('[data-task-list], [data-schedule-tasks], [data-schedule-medications], [data-appointment-list], [data-attention-list], [data-med-prompt]');
  syncStateToPage();
  scope?.querySelector(selector)?.focus();
}

// --- Battery ---------------------------------------------------------------

function updateBatteryDisplay() {
  if (!batteryManager) return;
  const percent = Math.round(batteryManager.level * 100);
  const isLow = percent <= 20 && !batteryManager.charging;
  const batteryCard = document.querySelector('[data-notification-id="battery"]');
  document.querySelector('[data-battery-level]').textContent = `${percent}%${batteryManager.charging ? ' · Charging' : ''}`;
  document.querySelector('[data-battery-fill]').style.width = `${percent}%`;
  batteryCard.classList.toggle('is-low', isLow);
  document.querySelector('[data-battery-copy]').textContent = isLow
    ? 'Phone battery is low. Connect a charger before the next care check-in.'
    : batteryManager.charging
      ? 'Phone is charging. The reminder threshold is 20%.'
      : `Battery is at ${percent}%. Reminder threshold is 20%.`;

  if (deviceSettings().batteryReminderEnabled && isLow && !batteryWarningShown) {
    batteryWarningShown = true;
    prefs.readNotifications = prefs.readNotifications.filter((id) => id !== 'battery');
    savePrefs();
    syncNotificationState();
    showToast('Phone battery is low');
  } else if (!isLow) {
    batteryWarningShown = false;
  }
}

async function checkBatteryStatus() {
  if (typeof navigator.getBattery !== 'function') {
    document.querySelector('[data-battery-level]').textContent = 'Unavailable';
    document.querySelector('[data-battery-copy]').textContent = 'This browser does not share battery status. Use your phone’s built-in low-battery alert.';
    showToast('Battery status unavailable in this browser');
    return false;
  }

  try {
    batteryManager ||= await navigator.getBattery();
    if (!batteryEventsBound) {
      batteryManager.addEventListener('levelchange', updateBatteryDisplay);
      batteryManager.addEventListener('chargingchange', updateBatteryDisplay);
      batteryEventsBound = true;
    }
    updateBatteryDisplay();
    return true;
  } catch {
    document.querySelector('[data-battery-level]').textContent = 'Unavailable';
    document.querySelector('[data-battery-copy]').textContent = 'Battery status could not be read on this device.';
    showToast('Could not read battery status');
    return false;
  }
}

async function toggleBatteryReminder() {
  if (!await checkBatteryStatus()) return;
  const enabled = !deviceSettings().batteryReminderEnabled;
  saveDeviceSettings({ batteryReminderEnabled: enabled });
  syncNotificationState();
  if (enabled) updateBatteryDisplay();
  showToast(enabled ? 'Low-battery reminder enabled' : 'Low-battery reminder disabled');
}

// --- Shell -----------------------------------------------------------------

function showScreen(name) {
  screens.forEach((screen) => {
    screen.classList.toggle('active', screen.dataset.screen === name);
  });

  navItems.forEach((button) => {
    button.classList.toggle('active', button.dataset.screen === name);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.remove('show'), 2400);
}

function openDialog(title, content, onSave, saveLabel = 'Save') {
  dialogTitle.textContent = title;
  dialogContent.replaceChildren(content);
  dialogSave.textContent = saveLabel;
  dialogSave.hidden = !onSave;
  dialogSave.dataset.enabled = String(Boolean(onSave));
  dialog.showModal();
  dialogForm.onsubmit = (event) => {
    if (event.submitter?.value !== 'save' || !onSave) return;
    event.preventDefault();
    onSave();
    dialog.close();
  };
}

function openSetting(setting) {
  if (setting !== 'notifications') return;

  const field = document.createElement('select');
  field.className = 'dialog-input';
  field.name = 'value';
  field.setAttribute('aria-label', 'Reminder preference');
  [['all', 'All reminders'], ['important', 'Important only'], ['off', 'Off']].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    field.append(option);
  });
  field.value = prefs.profile.notifications || 'all';

  const labelElement = document.createElement('label');
  labelElement.className = 'dialog-label';
  labelElement.textContent = 'Reminder preference';
  labelElement.append(field);

  openDialog('Notifications', labelElement, () => {
    prefs.profile.notifications = field.value;
    savePrefs();
    showToast('Notifications saved');
  });
}

// specs: [name, label, type, required, initialValue, attributes]
function buildFormFields(specs) {
  const content = document.createElement('div');
  content.className = 'caregiver-form';
  const fields = {};
  specs.forEach(([name, labelText, type, required, value = '', attributes = {}]) => {
    const label = document.createElement('label');
    label.className = 'dialog-label';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'dialog-input';
    input.name = name;
    input.type = type;
    input.required = required;
    input.value = value;
    Object.entries(attributes).forEach(([attribute, attributeValue]) => input.setAttribute(attribute, attributeValue));
    label.append(input);
    content.append(label);
    fields[name] = input;
  });
  return { content, fields };
}

// Runs a server write, re-renders on success and reports failures.
async function saveToServer(action, successMessage) {
  try {
    await action();
    cacheData();
    syncStateToPage();
    showToast(successMessage);
  } catch (error) {
    showToast(`Couldn't save: ${error.message}`);
  }
}

function openAddTaskDialog() {
  const { content, fields } = buildFormFields([
    ['title', 'Task', 'text', true, '', { maxlength: '120' }],
    ['time', 'Time', 'time', false]
  ]);
  openDialog('Add task', content, () => {
    saveToServer(async () => {
      data.tasks.push(await api.createTask({
        patientId,
        title: fields.title.value.trim(),
        time: formatTimeInput(fields.time.value),
        icon: '📝'
      }));
    }, 'Task added');
  }, 'Add task');
  fields.title.focus();
}

function openAddMedicationDialog() {
  const { content, fields } = buildFormFields([
    ['name', 'Medication', 'text', true, '', { maxlength: '80' }],
    ['dose', 'Dose', 'text', false, '', { maxlength: '40' }],
    ['time', 'Time', 'time', true],
    ['stock', 'Doses on hand', 'number', true, '30', { min: '0', max: '999', step: '1' }]
  ]);
  openDialog('Add medication', content, () => {
    saveToServer(async () => {
      data.medications.push(await api.createMedication({
        patientId,
        name: fields.name.value.trim(),
        dose: fields.dose.value.trim(),
        time: formatTimeInput(fields.time.value),
        stock: Number(fields.stock.value)
      }));
    }, 'Medication added');
  }, 'Add medication');
  fields.name.focus();
}

function openAddAppointmentDialog() {
  const { content, fields } = buildFormFields([
    ['title', 'Appointment', 'text', true, '', { maxlength: '120' }],
    ['start', 'Date and time', 'datetime-local', true],
    ['details', 'Provider or location', 'text', false, '', { maxlength: '120' }]
  ]);
  openDialog('Add appointment', content, () => {
    saveToServer(async () => {
      data.appointments.push(await api.createAppointment({
        patientId,
        title: fields.title.value.trim(),
        start: fields.start.value,
        details: fields.details.value.trim()
      }));
    }, 'Appointment added to calendar');
  }, 'Add appointment');
  fields.title.focus();
}

function openPatientDialog() {
  const patient = currentPatient();
  const { content, fields } = buildFormFields([
    ['name', 'Full name', 'text', true, patient.name, { maxlength: '80' }],
    ['phone', 'Phone number', 'tel', false, patient.phone, { maxlength: '25' }],
    ['address', 'Address', 'text', false, patient.address, { maxlength: '160' }],
    ['dob', 'Date of birth', 'date', false, patient.dob, { max: new Date().toISOString().slice(0, 10) }]
  ]);
  openDialog('Edit patient info', content, () => {
    saveToServer(async () => {
      const updated = await api.updatePatient(patient.id, {
        name: fields.name.value.trim(),
        phone: fields.phone.value.trim(),
        address: fields.address.value.trim(),
        dob: fields.dob.value
      });
      Object.assign(patient, updated);
      writeJson(PATIENTS_CACHE_KEY, patients);
    }, 'Patient info saved');
  });
  fields.name.focus();
}

function openCaregiverDialog(caregiver = null) {
  const { content, fields } = buildFormFields([
    ['name', 'Name', 'text', true, caregiver?.name],
    ['role', 'Relationship or role', 'text', false, caregiver?.role],
    ['phone', 'Phone number', 'tel', true, caregiver?.phone]
  ]);
  openDialog(caregiver ? `Edit ${caregiver.name}` : 'Add caregiver', content, () => {
    const values = {
      name: fields.name.value.trim(),
      role: fields.role.value.trim() || 'Caregiver',
      phone: fields.phone.value.trim()
    };
    if (caregiver) {
      Object.assign(caregiver, values);
    } else {
      prefs.caregivers.push({ id: `caregiver-${Date.now()}`, ...values });
    }
    savePrefs();
    syncStateToPage();
    showToast(caregiver ? 'Caregiver updated' : 'Caregiver added');
  }, caregiver ? 'Save' : 'Add caregiver');
  fields.name.focus();
}

function openAllergyDialog() {
  const { content, fields } = buildFormFields([
    ['name', 'Allergy', 'text', true, '', { maxlength: '80' }],
    ['note', 'Reaction or notes', 'text', false, '', { maxlength: '120' }]
  ]);
  openDialog('Add allergy', content, () => {
    prefs.allergies.push({
      id: `allergy-${Date.now()}`,
      name: fields.name.value.trim(),
      note: fields.note.value.trim()
    });
    savePrefs();
    syncStateToPage();
    showToast('Allergy added');
  }, 'Add allergy');
  fields.name.focus();
}

function openRemoveAllergyDialog(allergy) {
  const message = document.createElement('p');
  message.className = 'reset-dialog-copy';
  message.textContent = `${allergy.name} will be removed from the allergy list.`;
  openDialog(`Delete ${allergy.name}?`, message, () => {
    prefs.allergies = prefs.allergies.filter((entry) => entry.id !== allergy.id);
    savePrefs();
    syncStateToPage();
    showToast('Allergy removed');
  }, 'Delete');
}

function openRemoveCaregiverDialog(caregiver) {
  const message = document.createElement('p');
  message.className = 'reset-dialog-copy';
  message.textContent = `${caregiver.name} will no longer appear in the care team or the contact list.`;
  openDialog(`Remove ${caregiver.name}?`, message, () => {
    prefs.caregivers = prefs.caregivers.filter((entry) => entry.id !== caregiver.id);
    if (prefs.selectedContactId === caregiver.id) prefs.selectedContactId = prefs.caregivers[0]?.id || '';
    savePrefs();
    syncStateToPage();
    showToast('Caregiver removed');
  }, 'Remove');
}

function openAttentionDialog(item = null) {
  const { content, fields } = buildFormFields([
    ['title', 'What needs attention', 'text', true, item?.title],
    ['detail', 'Details', 'text', false, item?.detail]
  ]);
  openDialog(item ? 'Edit attention item' : 'Add attention item', content, () => {
    const values = { title: fields.title.value.trim(), detail: fields.detail.value.trim() };
    if (item) {
      Object.assign(item, values);
    } else {
      prefs.attentionItems.push({ id: `attention-${Date.now()}`, status: 'open', ...values });
    }
    savePrefs();
    syncStateToPage();
    showToast(item ? 'Attention item updated' : 'Attention item added');
  }, item ? 'Save' : 'Add');
  fields.title.focus();
}

async function resolveAttention(id) {
  if (id.startsWith('task:')) {
    const item = findItem(id.slice('task:'.length));
    if (!item) return;
    const updated = await setItemStatus(item, 'done');
    syncStateToPage();
    if (updated) showToast(statusToast(updated));
    return;
  }
  const item = prefs.attentionItems.find((entry) => entry.id === id);
  if (!item) return;
  item.status = 'resolved';
  savePrefs();
  syncStateToPage();
  showToast('Marked as resolved');
}

function dismissAttention(id) {
  const item = prefs.attentionItems.find((entry) => entry.id === id);
  if (item) item.status = 'dismissed';
  else if (!prefs.dismissedAttention.includes(id)) prefs.dismissedAttention.push(id);
  savePrefs();
  syncStateToPage();
  showToast('Dismissed');
}

function toggleAlerts(control) {
  const id = control.dataset.alertId;
  const name = findItem(id)?.title || findAppointment(id)?.title || 'this item';
  const enabled = alertsEnabled(id);
  prefs.alertsDisabled = enabled
    ? [...prefs.alertsDisabled, id]
    : prefs.alertsDisabled.filter((entry) => entry !== id);
  savePrefs();
  syncKeepingFocus(control, `[data-action="toggle-alert"][data-alert-id="${CSS.escape(id)}"]`);
  showToast(enabled ? `Alerts off for ${name}` : `Alerts on for ${name}`);
}

function openResetDialog() {
  const message = document.createElement('p');
  message.className = 'reset-dialog-copy';
    message.textContent = 'This clears what this device saved: care team, allergies, alert settings, hydration and notification settings for every patient. Schedules on the server are not changed.';
  openDialog('Reset demo data?', message, () => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith('leopard-care-') || key === SELECTED_PATIENT_KEY)
      .forEach((key) => localStorage.removeItem(key));
    window.location.reload();
  }, 'Reset demo');
}

function exportCalendarEvent(button) {
  const date = button.dataset.date;
  const time = button.dataset.time;
  const eventText = button.dataset.event.replaceAll(',', '\\,');
  const description = button.dataset.description.replaceAll(',', '\\,');
  const calendarData = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Leopard Care//Care Calendar//EN',
    'BEGIN:VEVENT', `UID:${date}-${time}@leopard-care`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART:${date}T${time}`, `SUMMARY:${eventText}`, `DESCRIPTION:${description}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const file = new Blob([calendarData], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = `${button.dataset.event.toLowerCase().replaceAll(' ', '-')}.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  showToast('Calendar event downloaded');
}

function composeMessage(contactName, phoneNumber) {
  const recipient = document.createElement('p');
  recipient.className = 'composer-recipient';
  recipient.textContent = `To ${contactName} · ${formatPhone(phoneNumber)}`;

  const field = document.createElement('textarea');
  field.className = 'dialog-input';
  field.rows = 5;
  field.required = true;
  field.maxLength = 500;
  field.placeholder = 'Write a message';
  field.setAttribute('aria-label', `Message to ${contactName}`);
  field.addEventListener('input', () => {
    field.setCustomValidity(field.value.trim() ? '' : 'Enter a message.');
  });

  const label = document.createElement('label');
  label.className = 'dialog-label';
  label.textContent = 'Message';
  label.append(field);

  const content = document.createElement('div');
  content.className = 'message-composer';
  content.append(recipient, label);
  openDialog(`Message ${contactName}`, content, () => {
    const separator = /iPad|iPhone|iPod/.test(navigator.userAgent) ? '&' : '?';
    const link = document.createElement('a');
    link.href = `sms:${phoneNumber}${separator}body=${encodeURIComponent(field.value.trim())}`;
    link.click();
    showToast('Message opened in your SMS app');
  }, 'Open Messages');
  field.focus();
}

// --- Read aloud --------------------------------------------------------------

function possessive() {
  return currentRole() === 'patient' ? 'your' : `${firstName(currentPatient().name)}'s`;
}

function readAloudText(kind) {
  if (kind === 'schedule') {
    const items = catalog().sort(byTime);
    if (!items.length) return `There is nothing on ${possessive()} schedule today.`;
    const lines = items.map((item) => {
      const state = item.status === 'done' ? 'done' : item.status === 'late' ? 'running late' : 'still to do';
      return `${item.time === 'Anytime' ? 'Any time' : item.time}: ${item.title}, ${state}.`;
    });
    const done = items.filter((item) => item.status === 'done').length;
    return `Here is ${possessive()} schedule for today. ${lines.join(' ')} ${done} of ${items.length} done.`;
  }
  if (kind === 'medication') {
    const next = nextMedication();
    if (!next) return data.medications.length ? `All of ${possessive()} medications are logged for today.` : 'No medications are scheduled.';
    const note = next.note ? `, ${next.note.toLowerCase()}` : '';
    const stock = next.stock
      ? ` ${next.stock.left} doses left.${next.stock.left <= LOW_STOCK ? ' Time to ask for a refill.' : ''}`
      : '';
    return `${possessive()[0].toUpperCase()}${possessive().slice(1)} next medication is ${next.title} at ${next.time}${note}.${stock}`;
  }
  if (kind === 'attention') {
    const items = getAttentionItems();
    if (!items.length) return 'Nothing needs attention right now.';
    return `${items.length} item${items.length === 1 ? '' : 's'} need attention. ${items.map((item) => `${item.title}${item.detail ? `. ${item.detail}` : ''}.`).join(' ')}`;
  }
  if (kind === 'activity') {
    const entries = data.activity.slice(0, 5);
    if (!entries.length) return `No updates from ${firstName(currentPatient().name)} yet.`;
    return entries.map((entry) => `${reliefMessage(entry)} at ${formatClock(entry.at)}.`).join(' ');
  }
  return '';
}

function setReadButtonState(button, playing) {
  button.setAttribute('aria-pressed', String(playing));
  button.textContent = playing ? '⏹ Stop' : '🔊 Read aloud';
}

async function readAloud(button) {
  if (activeReadButton === button && isSpeaking()) {
    stopSpeaking();
    return;
  }
  if (activeReadButton) setReadButtonState(activeReadButton, false);
  activeReadButton = button;
  setReadButtonState(button, true);
  const result = await speak(readAloudText(button.dataset.read), {
    onEnd: () => {
      setReadButtonState(button, false);
      if (activeReadButton === button) activeReadButton = null;
    }
  });
  if (result === 'unavailable') showToast('Read aloud is not available on this device');
}

// --- Patients, relief notifications -----------------------------------------

function connectActivityStream() {
  closeActivityStream?.();
  closeActivityStream = null;
  if (!isCaregiver() || typeof EventSource !== 'function') return;
  const id = patientId;
  closeActivityStream = api.subscribeToActivity(id, async (entry) => {
    if (id !== patientId || data.activity.some((existing) => existing.id === entry.id)) return;
    data.activity.unshift(entry);
    showToast(reliefMessage(entry));
    // The patient changed something: pull the latest schedule too.
    await loadPatientData({ quiet: true });
    syncStateToPage();
  });
}

async function switchPatient(id) {
  if (id === patientId || !patients.some((patient) => patient.id === id)) return;
  stopSpeaking();
  patientId = id;
  writeJson(SELECTED_PATIENT_KEY, id);
  prefs = loadPrefs(id);
  data = { ...emptyData(), ...asObject(readJson(cacheKey(id), {})) };
  syncStateToPage();
  await loadPatientData();
  syncStateToPage();
  connectActivityStream();
  showToast(`Now viewing ${currentPatient().name}`);
}

function markActivitySeen() {
  const newest = data.activity[0]?.at;
  if (newest && newest > prefs.seenActivityAt) {
    prefs.seenActivityAt = newest;
    savePrefs();
  }
}

async function patientCheckIn(button) {
  button.disabled = true;
  try {
    await api.checkIn(patientId);
    showToast('Check-in sent to your care team');
  } catch (error) {
    showToast(`Couldn't check in: ${error.message}`);
  } finally {
    // Brief cooldown so a double tap doesn't send two check-ins.
    setTimeout(() => { button.disabled = false; }, 3000);
  }
}

// --- Events ----------------------------------------------------------------

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.dataset.screen) {
    showScreen(button.dataset.screen);
    return;
  }

  if (button.dataset.setting) {
    openSetting(button.dataset.setting);
    return;
  }

  if (button.dataset.alertFilter) {
    alertFilter = button.dataset.alertFilter;
    syncNotificationState();
    return;
  }

  if (button.classList.contains('calendar-action')) {
    exportCalendarEvent(button);
    return;
  }

  const action = button.dataset.action;
  const item = button.dataset.taskId ? findItem(button.dataset.taskId) : null;
  if ((action === 'medication' || action === 'task-done') && item) {
    const updated = await setItemStatus(item, 'done');
    syncStateToPage();
    if (updated) showToast(statusToast(updated));
  } else if (action === 'task-late' && item) {
    const updated = await setItemStatus(item, item.status === 'late' ? 'pending' : 'late');
    syncKeepingFocus(button, `[data-action="task-late"][data-task-id="${CSS.escape(item.id)}"]`);
    if (updated) showToast(statusToast(updated));
  } else if (action === 'toggle-alert') {
    toggleAlerts(button);
  } else if (action === 'read-aloud') {
    readAloud(button);
  } else if (action === 'check-in') {
    patientCheckIn(button);
  } else if (action === 'show-activity') {
    showScreen('home');
    markActivitySeen();
    renderPatient();
    document.getElementById('recent-activity')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(renderActivity, 4000); // let the "new" highlight be seen first
  } else if (action === 'hydration') {
    prefs.hydration += 1;
    savePrefs();
    updateSummary();
    showToast(prefs.hydration >= 8 ? 'Hydration goal reached' : 'Water logged');
  } else if (action === 'check-battery') {
    checkBatteryStatus();
  } else if (action === 'toggle-battery') {
    toggleBatteryReminder();
  } else if (action === 'add-caregiver') {
    openCaregiverDialog();
  } else if (action === 'edit-caregiver') {
    const caregiver = prefs.caregivers.find((entry) => entry.id === button.dataset.caregiverId);
    if (caregiver) openCaregiverDialog(caregiver);
  } else if (action === 'remove-caregiver') {
    const caregiver = prefs.caregivers.find((entry) => entry.id === button.dataset.caregiverId);
    if (caregiver) openRemoveCaregiverDialog(caregiver);
  } else if (action === 'add-allergy') {
    openAllergyDialog();
  } else if (action === 'remove-allergy') {
    const allergy = prefs.allergies.find((entry) => entry.id === button.dataset.allergyId);
    if (allergy) openRemoveAllergyDialog(allergy);
  } else if (action === 'edit-patient') {
    openPatientDialog();
  } else if (action === 'add-attention') {
    openAttentionDialog();
  } else if (action === 'edit-attention') {
    const note = prefs.attentionItems.find((entry) => entry.id === button.dataset.attentionId);
    if (note) openAttentionDialog(note);
  } else if (action === 'resolve-attention') {
    resolveAttention(button.dataset.attentionId);
  } else if (action === 'dismiss-attention') {
    dismissAttention(button.dataset.attentionId);
  } else if (action === 'add-task') {
    openAddTaskDialog();
  } else if (action === 'add-medication') {
    openAddMedicationDialog();
  } else if (action === 'add-appointment') {
    openAddAppointmentDialog();
  } else if (action === 'reset-demo') {
    openResetDialog();
  } else if (action === 'call') {
    if (button.dataset.phone) window.location.href = `tel:${button.dataset.phone}`;
  } else if (action === 'message') {
    if (button.dataset.phone) composeMessage(button.dataset.contactName, button.dataset.phone);
  } else if (action === 'mark-alerts-read') {
    prefs.readNotifications = [...notificationIds];
    prefs.readMissedTasks = getMissedTasks().map((missed) => missed.id);
    savePrefs();
    syncStateToPage();
    showToast('Notifications marked as read');
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.matches('[data-contact-select]')) {
    prefs.selectedContactId = event.target.value;
    savePrefs();
    renderContactCard();
    return;
  }

  if (event.target.matches('[data-patient-select]')) {
    switchPatient(event.target.value);
    return;
  }

  const checkbox = event.target.closest('[data-task-check]');
  const item = checkbox && findItem(checkbox.dataset.taskCheck);
  if (!item) return;
  const updated = await setItemStatus(item, checkbox.checked ? 'done' : 'pending');
  syncKeepingFocus(checkbox, `[data-task-check="${CSS.escape(item.id)}"]`);
  if (updated) showToast(statusToast(updated));
});

// Fired by src/main.js when the user picks, switches, or clears their role.
document.addEventListener('role:change', async () => {
  stopSpeaking();
  syncStateToPage();
  showScreen('home');
  connectActivityStream();
  // A caregiver may be picking up activity the patient created on this device.
  await loadPatientData({ quiet: true });
  syncStateToPage();
});

// Coming back to the app: refresh in case the other side changed something.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !prefs) return;
  await loadPatientData({ quiet: true });
  syncStateToPage();
});

async function init() {
  migrateLegacyState();
  await loadPatients();
  const saved = readJson(SELECTED_PATIENT_KEY, null);
  patientId = patients.some((patient) => patient.id === saved) ? saved : patients[0].id;
  prefs = loadPrefs(patientId);
  // Render the last snapshot immediately, then refresh from the server.
  data = { ...emptyData(), ...asObject(readJson(cacheKey(patientId), {})) };
  syncStateToPage();
  await loadPatientData();
  syncStateToPage();
  connectActivityStream();
  // Items become overdue and appointments become imminent as time passes.
  setInterval(() => {
    renderAttention();
    syncNotificationState();
  }, 60 * 1000);
}

init();
