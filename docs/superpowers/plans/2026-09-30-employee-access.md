# Employee Access (login/logout, phone accounts, Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace open self-registration with admin-provisioned access: a logout button, phone+password login for employees the admin creates, and a Settings page (theme + employee management) — all specified in [docs/superpowers/specs/2026-09-30-employee-access-design.md](../specs/2026-09-30-employee-access-design.md).

**Architecture:** Phone numbers become synthetic emails (`<digits>@employees.icon-finance.local`) so Firebase Auth's existing email+password flow handles them unmodified. A second, named Firebase App instance creates employee accounts so it never swaps out the admin's own session. Admin rights for a phone-created employee come from a new `employees/{uid}` doc (`role`, `disabled`), never from the client-write-locked `admins` collection — both the client (`state.isAdmin`) and Firestore rules (`isAdmin()`) recognize this second path.

**Tech Stack:** Vanilla JS, Firebase v10 compat SDK (Auth + Firestore), no build step, no test runner — same as the rest of this project.

## Global Constraints

- Synthetic email domain: `employees.icon-finance.local` (spec, "Архитектура").
- Employee creation never touches the primary `auth` session — always via a secondary named app instance (spec, "Архитектура").
- `admins/{uid}` is never written from the client (existing rule `allow write: if false`) — admin rights for employees flow only through `employees/{uid}.role`.
- No SMS, no Firebase Phone Auth — plain password compared via normal `signInWithEmailAndPassword` (spec, decided with user).
- No real account deletion — `disabled: true` gate only (spec, "Вне рамок").
- Same file:// caching gotcha as before this session — bump the `?v=` query on `style.css`/`app.js` in `index.html` and `history.html` every task that changes them, and cannot browser-test a real write against live Firestore (no test/dev project) — verify via `node --check app.js` plus a read-only/wrong-input pass in the browser, and hand off the real accept-path check to the account owner.

---

### Task 1: Login screen — drop self-registration, add Email/Телефон toggle

**Files:**
- Modify: `app.js:1393-1449` (`authMode`, `mapAuthError`, `renderAuthForm`)
- Modify: `index.html:7` (style.css version bump), `index.html:118` (app.js version bump)

**Interfaces:**
- Produces: `let authLoginMode = 'email' | 'phone'` (module-level state), `function phoneDigitsToEmail(digits)` returns `` `${digits}@employees.icon-finance.local` `` — Task 2/6 reuse this exact function for the disabled-gate check and employee creation.
- Consumes: existing `auth`, `escapeHtml`, `mapAuthError` (extended in this task).

- [ ] **Step 1: Replace `authMode`/`mapAuthError`/`renderAuthForm`**

Currently (`app.js:1393-1449`):

```js
let authMode = 'login'; // 'login' | 'register'
let authError = '';

function mapAuthError(err) {
  switch (err && err.code) {
    case 'auth/email-already-in-use': return 'Этот email уже зарегистрирован. Войдите.';
    case 'auth/invalid-email': return 'Введите корректную почту.';
    case 'auth/weak-password': return 'Пароль должен быть не короче 6 символов.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return 'Неверная почта или пароль.';
    default: return 'Что-то пошло не так. Попробуйте ещё раз.';
  }
}

function renderAuthForm() {
  const gate = document.getElementById('authGate');
  const isLogin = authMode === 'login';
  gate.innerHTML = `
    <div class="panel auth-wrap">
      <div class="auth-title">${isLogin ? 'Вход' : 'Регистрация'}</div>
      <form id="authForm">
        <input class="auth-input" type="email" id="authEmail" placeholder="Электронная почта" required>
        <input class="auth-input" type="password" id="authPassword" placeholder="Пароль" required>
        ${isLogin ? '' : '<input class="auth-input" type="password" id="authPassword2" placeholder="Повторите пароль" required>'}
        ${authError ? `<div class="auth-error">${escapeHtml(authError)}</div>` : ''}
        <button type="submit" class="btn btn-primary" style="width:100%;">${isLogin ? 'Войти' : 'Создать аккаунт'}</button>
      </form>
      <div class="auth-toggle">${isLogin
        ? 'Нет аккаунта? <a id="authToggle">Зарегистрироваться</a>'
        : 'Уже есть аккаунт? <a id="authToggle">Войти</a>'}</div>
    </div>
  `;
  gate.querySelector('#authToggle').addEventListener('click', () => {
    authMode = isLogin ? 'register' : 'login';
    authError = '';
    renderAuthForm();
  });
  gate.querySelector('#authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = gate.querySelector('#authEmail').value.trim();
    const password = gate.querySelector('#authPassword').value;
    if (isLogin) {
      auth.signInWithEmailAndPassword(email, password).catch((err) => {
        authError = mapAuthError(err);
        renderAuthForm();
      });
    } else {
      const password2 = gate.querySelector('#authPassword2').value;
      if (password !== password2) { authError = 'Пароли не совпадают.'; renderAuthForm(); return; }
      auth.createUserWithEmailAndPassword(email, password).catch((err) => {
        authError = mapAuthError(err);
        renderAuthForm();
      });
    }
  });
}
```

Replace with:

```js
let authLoginMode = 'email'; // 'email' | 'phone'
let authError = '';

// Employee accounts don't get a real email — this is how their phone
// number becomes one, so ordinary Firebase email+password auth handles
// them unmodified. Same function used at login (Task 2) and at employee
// creation (Task 6), so both sides always agree on the address.
function phoneDigitsToEmail(digits) {
  return `${digits}@employees.icon-finance.local`;
}

function mapAuthError(err, mode) {
  const noun = mode === 'phone' ? 'телефон' : 'почта';
  switch (err && err.code) {
    case 'auth/invalid-email': return mode === 'phone' ? 'Введите номер телефона.' : 'Введите корректную почту.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return `Неверн${mode === 'phone' ? 'ый' : 'ая'} ${noun} или пароль.`;
    default: return 'Что-то пошло не так. Попробуйте ещё раз.';
  }
}

function renderAuthForm() {
  const gate = document.getElementById('authGate');
  const isPhone = authLoginMode === 'phone';
  gate.innerHTML = `
    <div class="panel auth-wrap">
      <div class="auth-title">Вход</div>
      <div class="modal-tabs">
        <button type="button" class="modal-tab ${!isPhone ? 'active' : ''}" data-login-mode="email">Email</button>
        <button type="button" class="modal-tab ${isPhone ? 'active' : ''}" data-login-mode="phone">Телефон</button>
      </div>
      <form id="authForm">
        ${isPhone
          ? '<input class="auth-input" type="tel" id="authPhone" placeholder="+998 90 123 45 67" required>'
          : '<input class="auth-input" type="email" id="authEmail" placeholder="Электронная почта" required>'}
        <input class="auth-input" type="password" id="authPassword" placeholder="Пароль" required>
        ${authError ? `<div class="auth-error">${escapeHtml(authError)}</div>` : ''}
        <button type="submit" class="btn btn-primary" style="width:100%;">Войти</button>
      </form>
    </div>
  `;
  gate.querySelectorAll('[data-login-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      authLoginMode = btn.dataset.loginMode;
      authError = '';
      renderAuthForm();
    });
  });
  gate.querySelector('#authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const password = gate.querySelector('#authPassword').value;
    const identifier = isPhone
      ? phoneDigitsToEmail('998' + gate.querySelector('#authPhone').value.replace(/\D/g, '').replace(/^998/, ''))
      : gate.querySelector('#authEmail').value.trim();
    auth.signInWithEmailAndPassword(identifier, password).catch((err) => {
      authError = mapAuthError(err, authLoginMode);
      renderAuthForm();
    });
  });
}
```

(The phone field only ever collects the number after `+998` — the `.replace(/^998/, '')` handles someone pasting the full `998...` prefix back in, so it doesn't get doubled.)

- [ ] **Step 2: Verify syntax**

```bash
node --check app.js
```
Expected: no output (exits 0).

- [ ] **Step 3: Bump cache-busting versions and verify in browser (read-only)**

In `index.html`, bump both to the next number (check current highest first: `grep -n "?v=" index.html history.html`):

```html
<link rel="stylesheet" href="style.css?v=7">
...
<script src="app.js?v=6"></script>
```

Open `index.html` in the Browser pane (logged out / or after the user signs out). Confirm:
- The login form shows an "Email" / "Телефон" tab pair above the fields, "Email" active by default.
- No "Зарегистрироваться" link anywhere.
- Clicking "Телефон" swaps the email input for a `tel` input with placeholder `+998 90 123 45 67`, and back.
- Submitting an obviously-wrong email+password (or phone+password) shows an error ("Неверная почта или пароль." / "Неверный телефон или пароль.") without navigating away — this only tests the reject path, not a real login, so it's safe against live Firestore.

- [ ] **Step 4: Commit**

```bash
git add app.js index.html
git commit -m "feat: drop self-registration, add Email/Телефон login toggle"
```

---

### Task 2: Logout button + employee disabled-gate

**Files:**
- Modify: `app.js:1509-1538` (`enterApp`, `onAuthStateChanged`), `app.js` near `initDatePicker` (add `initLogoutButton`)
- Modify: `index.html` (logout button markup in `.topbar-right`), `history.html` (same, in its own `.topbar-right`)

**Interfaces:**
- Consumes: `phoneDigitsToEmail` (Task 1, not directly needed here but same `employees` doc shape used in Task 6), `db`, `auth`.
- Produces: `function initLogoutButton()`, extends `enterApp(authUid, isAdmin)` call sites (still 2 args — role resolution happens before calling it, not inside it).

- [ ] **Step 1: Add the logout button next to the date picker in `index.html`**

Currently:

```html
    <div class="topbar-right">
      <div class="date-display" id="todayDate"></div>
      <input type="date" id="viewDateInput" class="date-picker-input" title="Показать данные за день">
    </div>
```

Change to:

```html
    <div class="topbar-right">
      <div class="date-display" id="todayDate"></div>
      <input type="date" id="viewDateInput" class="date-picker-input" title="Показать данные за день">
      <button type="button" id="logoutBtn" class="btn btn-secondary">Выход</button>
    </div>
```

- [ ] **Step 2: Add the same button to `history.html`**

Currently:

```html
    <div class="topbar-right">
      <a href="index.html" class="btn btn-secondary">← Назад</a>
    </div>
```

Change to:

```html
    <div class="topbar-right">
      <a href="index.html" class="btn btn-secondary">← Назад</a>
      <button type="button" id="logoutBtn" class="btn btn-secondary">Выход</button>
    </div>
```

- [ ] **Step 3: Add `initLogoutButton()` in `app.js`**

Currently:

```js
function initDatePicker() {
  const input = document.getElementById('viewDateInput');
```

Change to (new function added just before it):

```js
function initLogoutButton() {
  const btn = document.getElementById('logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    // Reload after sign-out instead of hand-rolling the reset — enterApp()
    // only wires up mutating listeners once per page load
    // (onAuthStateChanged's `if (state.currentUser) return;` guard, further
    // down this file, is there specifically to stop that from double-firing)
    // and unwinding CACHE/state back to their pre-login shape correctly
    // isn't worth it next to a full reload.
    auth.signOut().then(() => location.reload());
  });
}

function initDatePicker() {
  const input = document.getElementById('viewDateInput');
```

- [ ] **Step 4: Wire `initLogoutButton()` unconditionally in `enterApp()`, and resolve admin rights from `employees` too**

Currently:

```js
function enterApp(authUid, isAdmin) {
  state.currentUser = authUid;
  state.isAdmin = isAdmin;
  if (!isAdmin) document.querySelectorAll('.admin-only').forEach((el) => el.remove());

  (isAdmin ? migrateLocalDataIfNeeded() : Promise.resolve()).catch((err) => {
    console.error('Migration failed', err);
  }).then(() => attachSnapshotListeners()).then(() => {
    // only now does CACHE hold the real shared data — safe to reveal the
    // app and let the admin start mutating it
    document.getElementById('authGate').classList.add('hidden');
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    if (document.getElementById('methodsRow')) { setDateDisplay(); initDatePicker(); setupGlobalEvents(); }
  });
}

document.getElementById('authGate').innerHTML = '<div class="auth-wrap empty-hint" style="text-align:center;">Загрузка…</div>';
document.getElementById('authGate').classList.remove('hidden');

auth.onAuthStateChanged((user) => {
  if (state.currentUser) return; // already entered via enterApp() above
  if (!user) { showAuthGate(); return; }
  db.collection('admins').doc(user.uid).get()
    .then((adminDoc) => enterApp(user.uid, adminDoc.exists))
    .catch(() => {
      authError = 'Не удалось загрузить данные. Проверьте соединение.';
      showAuthGate();
    });
});
```

Change to:

```js
function enterApp(authUid, isAdmin) {
  state.currentUser = authUid;
  state.isAdmin = isAdmin;
  if (!isAdmin) document.querySelectorAll('.admin-only').forEach((el) => el.remove());

  (isAdmin ? migrateLocalDataIfNeeded() : Promise.resolve()).catch((err) => {
    console.error('Migration failed', err);
  }).then(() => attachSnapshotListeners()).then(() => {
    // only now does CACHE hold the real shared data — safe to reveal the
    // app and let the admin start mutating it
    document.getElementById('authGate').classList.add('hidden');
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    initLogoutButton();
    if (document.getElementById('methodsRow')) { setDateDisplay(); initDatePicker(); setupGlobalEvents(); }
  });
}

document.getElementById('authGate').innerHTML = '<div class="auth-wrap empty-hint" style="text-align:center;">Загрузка…</div>';
document.getElementById('authGate').classList.remove('hidden');

// Resolves who signed in to: 'admin' (in the admins collection), an
// employee doc (role + disabled), or nothing at all (stale/unknown
// account — treated the same as disabled).
function resolveAccess(uid) {
  return db.collection('admins').doc(uid).get().then((adminDoc) => {
    if (adminDoc.exists) return { allowed: true, isAdmin: true };
    return db.collection('employees').doc(uid).get().then((empDoc) => {
      if (!empDoc.exists || empDoc.data().disabled) return { allowed: false };
      return { allowed: true, isAdmin: empDoc.data().role === 'admin' };
    });
  });
}

auth.onAuthStateChanged((user) => {
  if (state.currentUser) return; // already entered via enterApp() above
  if (!user) { showAuthGate(); return; }
  resolveAccess(user.uid).then((access) => {
    if (!access.allowed) {
      authError = 'Аккаунт отключён или не найден.';
      return auth.signOut().then(() => showAuthGate());
    }
    enterApp(user.uid, access.isAdmin);
  }).catch(() => {
    authError = 'Не удалось загрузить данные. Проверьте соединение.';
    showAuthGate();
  });
});
```

- [ ] **Step 5: Verify syntax**

```bash
node --check app.js
```
Expected: no output.

- [ ] **Step 6: Verify in browser (read-only, plus code-review for the parts that need a real employee doc to exercise)**

1. Log in (as the existing admin account) and confirm the "Выход" button appears next to the date picker, and on `history.html` next to "← Назад".
2. Click it — confirm the page reloads and lands back on the login screen (not stuck logged in, not stuck on a blank page).
3. Code-review `resolveAccess`: confirm an admin (`admins/{uid}` exists) short-circuits to `{allowed: true, isAdmin: true}` without ever reading `employees` — this is the path the existing account still uses, unchanged in effect. The `employees`-doc branch can't be exercised for real until Task 6 has actually created one; it's covered there.

- [ ] **Step 7: Commit**

```bash
git add app.js index.html history.html
git commit -m "feat: add logout button, resolve admin/employee access via employees collection"
```

---

### Task 3: Firestore rules — `employees` collection, two-path `isAdmin()`

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Consumes: nothing from earlier tasks (server-side only).
- Produces: `isAdmin()` now also true for a non-disabled `employees/{uid}` doc with `role == 'admin'` — Task 5/6's client-side writes (toggling `disabled`, creating employees) depend on this being deployed for an admin-role employee's own future writes to work, though the writes in this plan are always performed by the primary admin account, whose `isAdmin()` already returns true via `admins/{uid}` either way.

- [ ] **Step 1: Replace `isAdmin()` and add the `employees` match block**

Currently (`firestore.rules`):

```
    function isAdmin() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    // Список администраторов. Документы сюда добавляются вручную в консоли Firebase —
    // ни один клиент не может сам себя сделать администратором.
    match /admins/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if false;
    }
```

Change to:

```
    function isAdmin() {
      return request.auth != null && (
        exists(/databases/$(database)/documents/admins/$(request.auth.uid)) ||
        (
          exists(/databases/$(database)/documents/employees/$(request.auth.uid)) &&
          get(/databases/$(database)/documents/employees/$(request.auth.uid)).data.role == 'admin' &&
          get(/databases/$(database)/documents/employees/$(request.auth.uid)).data.disabled != true
        )
      );
    }

    // Список администраторов. Документы сюда добавляются вручную в консоли Firebase —
    // ни один клиент не может сам себя сделать администратором.
    match /admins/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if false;
    }

    // Сотрудники, заведённые админом через Настройки (телефон+пароль).
    // Каждый может прочитать только свой документ (нужно на входе — проверка
    // disabled), полный список — только админу. Писать (создать/отключить/
    // сменить роль) может только админ.
    match /employees/{userId} {
      allow get: if isAdmin() || (request.auth != null && request.auth.uid == userId);
      allow list: if isAdmin();
      allow write: if isAdmin();
    }
```

- [ ] **Step 2: Deploy the rules**

```bash
firebase deploy --only firestore:rules
```

Expected: `✔  Deploy complete!`. If the `firebase` CLI isn't installed/authenticated in this environment, tell the user to run this command themselves from the project root (they'll have the Firebase CLI set up already, since the project already has `firestore.rules` under source control) — do not attempt to work around a missing CLI by editing rules through any other channel.

- [ ] **Step 3: Commit**

```bash
git add firestore.rules
git commit -m "feat: recognize employees/{uid}.role admin, add employees collection rules"
```

---

### Task 4: Settings modal shell + Theme section

**Files:**
- Modify: `index.html` (Settings button in `.panel-head-actions`)
- Modify: `app.js` (new `ensureSettingsModal`, `openSettings`, `closeSettings`, `toggleTheme`, wiring in `setupGlobalEvents`)
- Modify: `style.css` (small additions only — the `.modal-*` classes already exist and are unused elsewhere in the project; this task is what finally uses them)

**Interfaces:**
- Produces: `function ensureSettingsModal()` returns the modal root element (creates it once, appends to `document.body` — same pattern as `ensureRowMenuEl`), `function openSettings()`, `function closeSettings()`, `function toggleTheme()`. `function renderSettingsModal()` — body content, extended by Task 5 (employee list) and Task 6 (add-employee form) rather than redefined.
- Consumes: `.modal-overlay`/`.modal`/`.modal-head`/`.modal-body` CSS (`style.css:112-148`, currently unused dead weight left over from a history-as-modal design that became `history.html` instead).

- [ ] **Step 1: Add the Settings button in `index.html`**

Currently:

```html
      <div class="panel-head-actions">
        <a href="history.html" class="btn btn-secondary">История</a>
        <button id="newMonthBtn" class="btn btn-secondary admin-only">Перейти к новому месяцу</button>
        <button id="toggleAddRow" class="btn btn-secondary admin-only">+ Добавить</button>
      </div>
```

Change to:

```html
      <div class="panel-head-actions">
        <a href="history.html" class="btn btn-secondary">История</a>
        <button id="settingsBtn" class="btn btn-secondary admin-only">⚙ Настройки</button>
        <button id="newMonthBtn" class="btn btn-secondary admin-only">Перейти к новому месяцу</button>
        <button id="toggleAddRow" class="btn btn-secondary admin-only">+ Добавить</button>
      </div>
```

- [ ] **Step 2: Add `toggleTheme()`, refactoring `initTheme()` to share it**

Currently:

```js
function initTheme() {
  const saved = localStorage.getItem('cf_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeToggle');
  btn.textContent = saved === 'dark' ? '☀️' : '🌙';
  btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('cf_theme', next);
    btn.textContent = next === 'dark' ? '☀️' : '🌙';
  });
}
```

Change to:

```js
// Shared by the corner theme button and the Settings modal's theme row —
// both call this and each independently re-syncs its own label/text.
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('cf_theme', next);
  syncThemeButtons();
}
function syncThemeButtons() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const corner = document.getElementById('themeToggle');
  if (corner) corner.textContent = dark ? '☀️' : '🌙';
  const settingsLabel = document.getElementById('settingsThemeLabel');
  if (settingsLabel) settingsLabel.textContent = dark ? 'Тёмная' : 'Светлая';
}
function initTheme() {
  const saved = localStorage.getItem('cf_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  syncThemeButtons();
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
}
```

- [ ] **Step 3: Add the modal shell, open/close, and Theme section in `app.js`**

Add this new section right after `renderRowMenu()` (search for `function renderRowMenu` to find it — place these functions after its closing `}`, before the `function renderExpenseTable()` comment block):

```js
// ---------- settings modal ----------

let settingsModalEl = null;
function ensureSettingsModal() {
  if (!settingsModalEl) {
    settingsModalEl = document.createElement('div');
    settingsModalEl.className = 'modal-overlay hidden';
    settingsModalEl.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-head">
          <h2>Настройки</h2>
          <button type="button" class="btn-icon" data-close-settings title="Закрыть">✕</button>
        </div>
        <div class="modal-body" id="settingsBody"></div>
      </div>
    `;
    document.body.appendChild(settingsModalEl);
    settingsModalEl.addEventListener('click', (e) => {
      if (e.target === settingsModalEl) closeSettings();
    });
    settingsModalEl.querySelector('[data-close-settings]').addEventListener('click', closeSettings);
  }
  return settingsModalEl;
}
function openSettings() {
  ensureSettingsModal().classList.remove('hidden');
  renderSettingsModal();
}
function closeSettings() {
  if (settingsModalEl) settingsModalEl.classList.add('hidden');
}
function renderSettingsModal() {
  const body = document.getElementById('settingsBody');
  if (!body) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  body.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Тема</div>
      <button type="button" class="btn btn-secondary" id="settingsThemeBtn">
        <span id="settingsThemeLabel">${dark ? 'Тёмная' : 'Светлая'}</span>
      </button>
    </div>
  `;
  body.querySelector('#settingsThemeBtn').addEventListener('click', toggleTheme);
}
```

- [ ] **Step 4: Wire the Settings button and Escape key, inside `setupGlobalEvents()`**

Currently:

```js
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openRowMenuId) { openRowMenuId = null; renderAll(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
```

Change to:

```js
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openRowMenuId) { openRowMenuId = null; renderAll(); }
    if (e.key === 'Escape' && settingsModalEl && !settingsModalEl.classList.contains('hidden')) closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
```

And right after the `toggleBtn.addEventListener('click', ...)` block for `newRowForm` (search for `toggleBtn.addEventListener('click', () => {` — it's the one right after the two `document.addEventListener` calls at the top of `setupGlobalEvents`), add:

```js
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
```

- [ ] **Step 5: Add `.settings-section` styling to `style.css`**

Append to the end of the file:

```css

.settings-section { margin-bottom: 24px; }
.settings-section:last-child { margin-bottom: 0; }
.settings-section-title { font-size: 13px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 10px; }
```

- [ ] **Step 6: Verify syntax**

```bash
node --check app.js
```
Expected: no output.

- [ ] **Step 7: Verify in browser**

1. Bump `?v=` on `style.css`/`app.js` in `index.html` (and `history.html`'s `style.css` version, since it shares the file) for a fresh fetch.
2. Log in as admin, click "⚙ Настройки" — modal opens over a dimmed backdrop, showing a "Тема" section with a button reading the current theme name.
3. Click the theme button — page theme flips (light/dark), button label updates, and the corner 🌙/☀️ button also updates to match (confirms `syncThemeButtons()` covers both).
4. Press Escape — modal closes. Reopen it, click the dark backdrop outside the white card — modal closes. Click the ✕ — modal closes.

- [ ] **Step 8: Commit**

```bash
git add app.js index.html style.css
git commit -m "feat: add Settings modal shell with a Theme section"
```

---

### Task 5: Employee list in Settings (live list + enable/disable toggle)

**Files:**
- Modify: `app.js` (`renderSettingsModal`, new `employeesCache`/`employeesUnsub`/`renderEmployeeList`)
- Modify: `style.css` (employee card styling)

**Interfaces:**
- Consumes: `openSettings`/`renderSettingsModal` (Task 4), Firestore `employees` collection (Task 3's rules — admin `list` is allowed).
- Produces: `let employeesCache` (array of `{id, name, position, phone, role, disabled, createdAt}`), consumed by Task 6's add-employee form to avoid duplicate phone numbers (optional dedupe check, not required — Task 6 doesn't need to read this, just noting it's now populated for later use if wanted).

- [ ] **Step 1: Subscribe to `employees` when Settings opens, cache the list**

Currently:

```js
let settingsModalEl = null;
```

Change to:

```js
let settingsModalEl = null;
let employeesCache = [];
let employeesUnsub = null;
```

Currently:

```js
function openSettings() {
  ensureSettingsModal().classList.remove('hidden');
  renderSettingsModal();
}
```

Change to:

```js
function openSettings() {
  ensureSettingsModal().classList.remove('hidden');
  if (!employeesUnsub) {
    employeesUnsub = db.collection('employees').onSnapshot((snap) => {
      employeesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderSettingsModal();
    }, (err) => console.error('employees snapshot failed', err));
  } else {
    renderSettingsModal();
  }
}
```

- [ ] **Step 2: Render the employee list inside `renderSettingsModal()`**

Currently:

```js
function renderSettingsModal() {
  const body = document.getElementById('settingsBody');
  if (!body) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  body.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Тема</div>
      <button type="button" class="btn btn-secondary" id="settingsThemeBtn">
        <span id="settingsThemeLabel">${dark ? 'Тёмная' : 'Светлая'}</span>
      </button>
    </div>
  `;
  body.querySelector('#settingsThemeBtn').addEventListener('click', toggleTheme);
}
```

Change to:

```js
const POSITION_LABELS = { admin_role: 'Администратор', teacher: 'Учитель', accountant: 'Бухгалтер', other: 'Другое' };

function renderSettingsModal() {
  const body = document.getElementById('settingsBody');
  if (!body) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const employeeRows = employeesCache.length
    ? employeesCache.map((emp) => `
        <div class="employee-card ${emp.disabled ? 'disabled' : ''}">
          <div class="employee-info">
            <span class="employee-name">${escapeHtml(emp.name || 'Без имени')}</span>
            <span class="employee-meta">${escapeHtml(POSITION_LABELS[emp.position] || emp.position || '')} · +${escapeHtml(emp.phone || '')} · ${emp.role === 'admin' ? 'Админ' : 'Просмотр'}</span>
          </div>
          <button type="button" class="btn btn-secondary" data-toggle-employee="${emp.id}">${emp.disabled ? 'Включить' : 'Отключить'}</button>
        </div>
      `).join('')
    : '<div class="empty-hint">Пока нет сотрудников</div>';
  body.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Тема</div>
      <button type="button" class="btn btn-secondary" id="settingsThemeBtn">
        <span id="settingsThemeLabel">${dark ? 'Тёмная' : 'Светлая'}</span>
      </button>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Сотрудники</div>
      <div id="employeeList">${employeeRows}</div>
      <button type="button" class="btn btn-primary" id="addEmployeeBtn" style="margin-top:12px;">+ Добавить сотрудника</button>
    </div>
  `;
  body.querySelector('#settingsThemeBtn').addEventListener('click', toggleTheme);
  body.querySelectorAll('[data-toggle-employee]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggleEmployee;
      const emp = employeesCache.find((x) => x.id === id);
      if (!emp) return;
      db.collection('employees').doc(id).update({ disabled: !emp.disabled }).catch((err) => {
        console.error('toggle employee failed', err);
        alert('Не удалось сохранить: проверьте соединение.');
      });
    });
  });
}
```

(`addEmployeeBtn`'s click handler is wired in Task 6 — this task only renders the button; Task 6 attaches its listener from inside the same function, added alongside the other `body.querySelector(...)` wiring calls above.)

- [ ] **Step 3: Add employee card styling to `style.css`**

Append:

```css

.employee-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.employee-card:last-child { border-bottom: none; }
.employee-card.disabled { opacity: 0.5; }
.employee-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.employee-name { font-weight: 600; font-size: 14px; }
.employee-meta { font-size: 12px; color: var(--text-muted); }
```

- [ ] **Step 4: Verify syntax**

```bash
node --check app.js
```
Expected: no output.

- [ ] **Step 5: Verify in browser**

1. Open Настройки — "Сотрудники" section shows "Пока нет сотрудников" (empty state, since Task 6 hasn't shipped yet and no employees exist).
2. Code-review `renderSettingsModal`'s toggle handler and `openSettings`'s subscription — confirm they only run for admin (Settings button itself is `.admin-only`, and `db.collection('employees').onSnapshot` is only reachable through `openSettings`, only wired for admins in `setupGlobalEvents`).

- [ ] **Step 6: Commit**

```bash
git add app.js style.css
git commit -m "feat: show live employee list in Settings with enable/disable toggle"
```

---

### Task 6: Add-employee form (secondary Firebase app, account creation)

**Files:**
- Modify: `app.js` (secondary app helper, `openAddEmployeeForm`, wiring)
- Modify: `style.css` (form field spacing, reusing `.auth-input`)

**Interfaces:**
- Consumes: `phoneDigitsToEmail` (Task 1), `employeesCache`/`renderSettingsModal` (Task 5), `POSITION_LABELS` (Task 5).
- Produces: `function getEmployeeCreatorAuth()`, `function createEmployeeAccount(phoneDigits, password)` returning `Promise<uid>`.

- [ ] **Step 1: Add the secondary-app helper**

Currently (near the top of the file, right after the primary Firebase init):

```js
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
db.settings({ experimentalAutoDetectLongPolling: true });
```

Change to:

```js
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
db.settings({ experimentalAutoDetectLongPolling: true });

// A brand-new secondary app instance (not the primary `auth`) so that
// creating an employee's Firebase Auth account never swaps out the
// currently-signed-in admin's own session — the client SDK's
// createUserWithEmailAndPassword() otherwise signs the caller in as the
// user it just created. Lazily created on first use, reused after.
let employeeCreatorApp = null;
function getEmployeeCreatorAuth() {
  if (!employeeCreatorApp) employeeCreatorApp = firebase.initializeApp(firebaseConfig, 'employeeCreator');
  return employeeCreatorApp.auth();
}
function createEmployeeAccount(phoneDigits, password) {
  const creatorAuth = getEmployeeCreatorAuth();
  return creatorAuth.createUserWithEmailAndPassword(phoneDigitsToEmail(phoneDigits), password)
    .then((cred) => {
      const uid = cred.user.uid;
      return creatorAuth.signOut().then(() => uid);
    });
}
```

- [ ] **Step 2: Add the add-employee form renderer and wire the button**

Add this function right after `renderSettingsModal()`:

```js
function openAddEmployeeForm() {
  const body = document.getElementById('settingsBody');
  body.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Добавить сотрудника</div>
      <form id="addEmployeeForm">
        <input class="auth-input" type="text" id="empName" placeholder="Имя" required>
        <select class="auth-input" id="empPosition">
          <option value="admin_role">Администратор</option>
          <option value="teacher" selected>Учитель</option>
          <option value="accountant">Бухгалтер</option>
          <option value="other">Другое</option>
        </select>
        <div style="display:flex; gap:8px;">
          <span class="auth-input" style="flex:0 0 auto; display:flex; align-items:center; color:var(--text-muted);">+998</span>
          <input class="auth-input" type="tel" id="empPhone" placeholder="901234567" required style="flex:1;">
        </div>
        <input class="auth-input" type="text" id="empPassword" placeholder="Пароль (по умолчанию — номер)">
        <select class="auth-input" id="empRole">
          <option value="viewer" selected>Просмотр</option>
          <option value="admin">Админ</option>
        </select>
        <div id="addEmployeeError" class="auth-error hidden"></div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button type="submit" class="btn btn-primary">Добавить</button>
          <button type="button" class="btn btn-secondary" id="cancelAddEmployee">Отмена</button>
        </div>
      </form>
    </div>
  `;
  body.querySelector('#cancelAddEmployee').addEventListener('click', renderSettingsModal);
  body.querySelector('#addEmployeeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = body.querySelector('#empName').value.trim();
    const position = body.querySelector('#empPosition').value;
    const digits = '998' + body.querySelector('#empPhone').value.replace(/\D/g, '');
    const password = body.querySelector('#empPassword').value.trim() || digits;
    const role = body.querySelector('#empRole').value;
    const errorEl = body.querySelector('#addEmployeeError');
    errorEl.classList.add('hidden');
    createEmployeeAccount(digits, password)
      .then((uid) => db.collection('employees').doc(uid).set({
        name, position, phone: digits, role, disabled: false, createdAt: Date.now(),
      }))
      .then(() => renderSettingsModal())
      .catch((err) => {
        console.error('create employee failed', err);
        errorEl.textContent = err && err.code === 'auth/email-already-in-use'
          ? 'Этот номер уже зарегистрирован.'
          : 'Не удалось создать сотрудника: проверьте соединение.';
        errorEl.classList.remove('hidden');
      });
  });
}
```

- [ ] **Step 3: Wire the "+ Добавить сотрудника" button**

In `renderSettingsModal()`, currently:

```js
  body.querySelector('#settingsThemeBtn').addEventListener('click', toggleTheme);
  body.querySelectorAll('[data-toggle-employee]').forEach((btn) => {
```

Change to:

```js
  body.querySelector('#settingsThemeBtn').addEventListener('click', toggleTheme);
  body.querySelector('#addEmployeeBtn').addEventListener('click', openAddEmployeeForm);
  body.querySelectorAll('[data-toggle-employee]').forEach((btn) => {
```

- [ ] **Step 4: Verify syntax**

```bash
node --check app.js
```
Expected: no output.

- [ ] **Step 5: Verify in browser — form UI and validation only, not a real account creation**

Per the project's standing constraint (no test/dev Firebase project — every write here is real), this step only exercises what's safe to click without actually creating a live account:

1. Bump `?v=` on `style.css`/`app.js`.
2. Open Настройки → "+ Добавить сотрудника" — form renders with Имя, Должность (4 options, Учитель pre-selected), `+998` prefix + phone input, Пароль (empty placeholder "по умолчанию — номер"), Права (Просмотр pre-selected, Админ option present).
3. Click "Отмена" — returns to the list view without submitting.
4. Leave "Имя" and "Телефон" empty, click "Добавить" — native `required` validation blocks submission (no network call, confirm via `read_network_requests` that nothing fired).
5. Code-review `createEmployeeAccount`/the submit handler: confirm the secondary app instance is used (`getEmployeeCreatorAuth()`, not `auth`), confirm `creatorAuth.signOut()` runs after creation success before the `employees` doc write, confirm the phone-with-password path matches `phoneDigitsToEmail` exactly (same `'998' + digits` construction as Task 1's login form).

- [ ] **Step 6: Commit**

```bash
git add app.js style.css
git commit -m "feat: add-employee form creates account via secondary Firebase app"
```

---

## Self-Review Notes

- **Spec coverage:** synthetic-email phone login (Task 1/6) — secondary app instance so admin session survives employee creation (Task 6) — `disabled`-gate on login (Task 2) — logout button (Task 2) — Settings modal with Тема (Task 4) and Сотрудники (Task 5/6), matching the "Добавить сотрудника" mockup fields minus the unrelated "карточка" field (Task 6) — `admins` collection never client-written, `employees/{uid}.role` as the second admin path, both client (Task 2) and Firestore rules (Task 3) — self-registration removed (Task 1). All spec sections have a task.
- **Type consistency:** `employees/{uid}` shape is `{name, position, phone, role, disabled, createdAt}` everywhere it's read or written (Task 3's rules reference `role`/`disabled`; Task 2's `resolveAccess` reads `role`/`disabled`; Task 5 renders `name`/`position`/`phone`/`role`/`disabled`; Task 6 writes exactly this shape) — no drift between tasks.
- **Testing approach note:** like the historical-date-view work earlier in this project, there's no test/dev Firebase project, so every task's verification step stays on the safe side of that line (syntax check, read-only browser checks, reject-path checks that provably never reach a write) and defers the real accept-path check (actually creating a working employee login) to the account owner, done once after Task 6 ships.
