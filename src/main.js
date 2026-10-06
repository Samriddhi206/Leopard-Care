// The dashboard renders on import; this module adds roles and the server badge..
import './app.js';
import { fetchUser } from './api.js';

// The unread badge lives on the bottom-nav Alerts button.
export function updateHeader({ badgeCount } = {}) {
  if (badgeCount === undefined) return;
  const badgeEl = document.querySelector('[data-badge-count]');
  if (!badgeEl) return;
  const count = Math.max(0, Number(badgeCount) || 0);
  badgeEl.textContent = String(count);
  badgeEl.hidden = count === 0;
}

// The server count is the baseline; local read/unread changes made after the
// fetch adjust it, so marking alerts read still clears the badge.
let serverBadge = null;

function readLocalUnread() {
  return Number(document.querySelector('[data-badge-count]')?.dataset.localUnread) || 0;
}

function reconciledBadgeCount(localUnread) {
  return serverBadge.count + (localUnread - serverBadge.localUnreadAtFetch);
}

// syncNotificationState() in index.html rewrites the badge from local state,
// then fires this event; re-apply the server-based count on top of it.
document.addEventListener('notifications:sync', (event) => {
  if (serverBadge === null) return;
  updateHeader({ badgeCount: reconciledBadgeCount(event.detail.unreadCount) });
});

// --- Role selection -------------------------------------------------------
// index.html applies the saved role to <html data-role> before first paint;
// CSS uses it to show the role gate and role-only elements.

const ROLE_KEY = 'userRole';
const ROLES = ['patient', 'caregiver'];

// Caregiver-only management shortcuts. Patients get the contact card and
// checklists instead, so they have no panel.
const CAREGIVER_ACTIONS = [
  { label: 'Add task', icon: '📝', data: { action: 'add-task' } },
  { label: 'Add medication', icon: '💊', data: { action: 'add-medication' } },
  { label: 'Add appointment', icon: '📅', data: { action: 'add-appointment' } },
  { label: 'Manage caregivers', icon: '👥', data: { screen: 'profile' } },
];

export function getUserRole() {
  try {
    const role = localStorage.getItem(ROLE_KEY);
    return ROLES.includes(role) ? role : null;
  } catch {
    return null;
  }
}

function storeRole(role) {
  try {
    if (role) localStorage.setItem(ROLE_KEY, role);
    else localStorage.removeItem(ROLE_KEY);
  } catch {
    // Storage blocked (e.g. private mode): the role still applies for this visit.
  }
}

function renderRolePanel(role) {
  const container = document.querySelector('[data-role-panel]');
  if (!container) return;
  container.replaceChildren();
  if (role !== 'caregiver') return;

  const card = document.createElement('div');
  card.className = 'card role-panel role-panel-caregiver';

  const heading = document.createElement('div');
  heading.className = 'section-title-row';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Manage care';
  heading.append(eyebrow);

  const grid = document.createElement('div');
  grid.className = 'role-actions';
  CAREGIVER_ACTIONS.forEach(({ label, icon, data }) => {
    const button = document.createElement('button');
    button.className = 'role-action';
    Object.assign(button.dataset, data);
    const iconEl = document.createElement('span');
    iconEl.className = 'role-action-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = icon;
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    button.append(iconEl, labelEl);
    grid.append(button);
  });

  card.append(heading, grid);
  container.append(card);
}

function applyRole(role) {
  document.documentElement.dataset.role = role ?? 'none';
  renderRolePanel(role);

  const switchLabel = document.querySelector('[data-role-switch-label]');
  if (switchLabel) {
    switchLabel.textContent = role === 'caregiver' ? 'Switch to patient view' : 'Switch to caregiver view';
  }

  if (!role) document.getElementById('role-gate-title')?.focus();
}

export function setUserRole(role) {
  const nextRole = ROLES.includes(role) ? role : null;
  storeRole(nextRole);
  applyRole(nextRole);
  document.dispatchEvent(new CustomEvent('role:change', { detail: { role: nextRole } }));
}

document.addEventListener('click', (event) => {
  const roleButton = event.target.closest('[data-select-role]');
  if (roleButton) {
    setUserRole(roleButton.dataset.selectRole);
    return;
  }

  const roleAction = event.target.closest('[data-role-action]');
  if (roleAction?.dataset.roleAction === 'switch') {
    const current = document.documentElement.dataset.role;
    setUserRole(current === 'caregiver' ? 'patient' : 'caregiver');
  } else if (roleAction?.dataset.roleAction === 'logout') {
    setUserRole(null);
  }
});

// --- Startup --------------------------------------------------------------

async function init() {
  applyRole(getUserRole());

  try {
    const user = await fetchUser();
    if (typeof user.badgeCount === 'number') {
      serverBadge = { count: user.badgeCount, localUnreadAtFetch: readLocalUnread() };
    }
    updateHeader({ badgeCount: user.badgeCount });
  } catch (error) {
    // Keep the locally computed badge if the API is unavailable.
    console.warn('Could not load user data:', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
