// Input validation: every route builds its own object from known fields only,
// so unexpected keys (including __proto__) never reach the store.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

// Strip control characters, normalise Unicode and whitespace, enforce length.
export function cleanText(value, field, { max = 120, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const cleaned = value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u200C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (required && !cleaned) throw new ValidationError(`${field} is required`);
  if (cleaned.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return cleaned;
}

export function cleanId(value, field = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new ValidationError(`${field} is invalid`);
  }
  return value;
}

export function cleanEnum(value, field, allowed) {
  if (!allowed.includes(value)) throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

// "9:00 AM", "21:30" or "Anytime".
export function cleanTime(value, field, { required = false } = {}) {
  const text = cleanText(value, field, { max: 12, required });
  if (!text) return 'Anytime';
  if (text === 'Anytime' || /^(\d{1,2}):([0-5]\d)(\s?[AP]M)?$/i.test(text)) return text;
  throw new ValidationError(`${field} must look like "9:00 AM" or "21:30"`);
}

// Local date-time from <input type="datetime-local">: YYYY-MM-DDTHH:MM.
export function cleanDateTime(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a date and time like 2026-10-05T13:30`);
  }
  return value;
}

export function cleanDate(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a date like 1941-05-09`);
  }
  return value;
}

export function cleanPhone(value, field) {
  const text = cleanText(value, field, { max: 25 });
  if (text && !/^\+?[\d\s().-]{7,25}$/.test(text)) throw new ValidationError(`${field} must be a phone number`);
  return text;
}

export function cleanInt(value, field, { min = 0, max = 9999 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ValidationError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

export function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Request body must be a JSON object');
  return body;
}
