const USERNAME_MAX_LEN = 16;
const USERNAME_MIN_LEN = 2;
const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/; // no spaces

// Keep short + high-signal. Server enforces the same style of checks.
const INAPPROPRIATE_USERNAME_SUBSTRINGS = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'cunt',
  'nigger',
  'fag',
  'rape',
  'hitler',
  'nazi'
];

function normalizeForNameFilter(name) {
  if (!name || typeof name !== 'string') return '';
  const leetMap = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };
  return name
    .toLowerCase()
    .split('')
    .map((ch) => leetMap[ch] || ch)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

export function isInappropriateUsername(username) {
  const normalized = normalizeForNameFilter(username);
  if (!normalized) return false;
  return INAPPROPRIATE_USERNAME_SUBSTRINGS.some((bad) => normalized.includes(bad));
}

export function sanitizeUsernameInput(raw) {
  if (raw == null) return '';
  return String(raw)
    .trim()
    .replace(/\s+/g, '') // no spaces
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, USERNAME_MAX_LEN);
}

export function validateUsername(username) {
  const u = sanitizeUsernameInput(username);
  if (!u) return { ok: false, reason: 'Please enter a username' };
  if (u.length < USERNAME_MIN_LEN) return { ok: false, reason: `Username must be at least ${USERNAME_MIN_LEN} characters` };
  if (u.length > USERNAME_MAX_LEN) return { ok: false, reason: `Username must be ${USERNAME_MAX_LEN} characters or less` };
  if (!USERNAME_REGEX.test(u)) return { ok: false, reason: 'Use only letters, numbers, _ or -. No spaces.' };
  if (isInappropriateUsername(u)) return { ok: false, reason: 'Please choose a different username' };
  return { ok: true, username: u };
}

export const USERNAME_RULES = { USERNAME_MAX_LEN, USERNAME_MIN_LEN };


