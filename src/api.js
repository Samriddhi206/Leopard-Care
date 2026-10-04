// Client for the Express API. All paths are relative so Vite's dev/preview
// proxy forwards them to the API server (see vite.config.js).

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function actorRole() {
  return document.documentElement.dataset.role === 'patient' ? 'patient' : 'caregiver';
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json', 'X-Actor-Role': actorRole() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('Could not reach the server', 0);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status})`, response.status);
  return data;
}

const withPatient = (path, patientId) => `${path}?patientId=${encodeURIComponent(patientId)}`;

export const fetchUser = () => request('GET', '/api/v1/user');

export const fetchPatients = () => request('GET', '/api/v1/patients');
export const updatePatient = (id, changes) => request('PUT', `/api/v1/patients/${encodeURIComponent(id)}`, changes);
export const checkIn = (id) => request('POST', `/api/v1/patients/${encodeURIComponent(id)}/check-in`);

export const fetchTasks = (patientId) => request('GET', withPatient('/api/v1/tasks', patientId));
export const createTask = (task) => request('POST', '/api/v1/tasks', task);
export const updateTask = (id, changes) => request('PUT', `/api/v1/tasks/${encodeURIComponent(id)}`, changes);

export const fetchMedications = (patientId) => request('GET', withPatient('/api/v1/medications', patientId));
export const createMedication = (medication) => request('POST', '/api/v1/medications', medication);
export const updateMedication = (id, changes) => request('PUT', `/api/v1/medications/${encodeURIComponent(id)}`, changes);

export const fetchAppointments = (patientId) => request('GET', withPatient('/api/v1/appointments', patientId));
export const createAppointment = (appointment) => request('POST', '/api/v1/appointments', appointment);

export const fetchActivity = (patientId) => request('GET', withPatient('/api/v1/activity', patientId));

// Live relief notifications. Returns a function that closes the stream.
export function subscribeToActivity(patientId, onEntry) {
  const source = new EventSource(withPatient('/api/v1/activity/stream', patientId));
  source.addEventListener('activity', (event) => {
    try {
      onEntry(JSON.parse(event.data));
    } catch {
      // Ignore malformed events.
    }
  });
  return () => source.close();
}

// Text-to-speech audio (audio/mpeg) for the given text.
export async function fetchSpeech(text, { signal } = {}) {
  let response;
  try {
    response = await fetch('/api/v1/voice/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the server', 0);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(data?.error || `Voice request failed (${response.status})`, response.status);
  }
  return response.blob();
}
