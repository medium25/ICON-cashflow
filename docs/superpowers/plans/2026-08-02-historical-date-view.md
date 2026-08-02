# Historical Date View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone viewing the page pick any date from the last 30 days and see every number (debt table, Было/Поступило, категории, KPIs) as it stood that day, with edits to a past day gated behind a confirmation code.

**Architecture:** Single new global `viewDate` (default: today) that every render function reads instead of calling `todayStr()` directly. A `<input type="date">` next to "Перейти к новому месяцу" changes `viewDate` and triggers the existing `renderAll()`. No new Firestore fields or collections — the data is already stored per-day (`expense.date`, `cf_balances` keyed by `<method>_<date>`); this is a pure read/write-target retargeting.

**Tech Stack:** Vanilla JS (no framework, no bundler), Firebase Firestore v10 compat SDK, static `index.html`/`app.js`/`style.css`. No test runner is configured in this project.

## Global Constraints

- Date picker range: `min` = today − 30 days, `max` = today (from the approved spec, [docs/superpowers/specs/2026-08-02-historical-date-view-design.md](../specs/2026-08-02-historical-date-view-design.md)).
- Editing a past day's Было/Поступило/источники/категории requires typing the code `1223` — the exact same code already used by the existing "Исправить «Отдали в этом месяце»" tool ([app.js:731-732](../../../app.js#L731)). Do not invent a new code.
- Editing a past day is a per-action prompt, not a session-wide "unlock" toggle.
- Row-level admin actions (add/edit/delete row, mark debt, comment, drag-reorder, "Новый месяц", "Исправить «Отдали в этом месяце»") are **never** editable while viewing a past date — no code bypasses this, the controls are simply hidden/disabled.
- `viewDate` is in-memory only — always resets to today on page reload.
- The date picker and past-date banner are visible to every user, not just admins (the rest of the page is already read-only for non-admins via `state.isAdmin`).
- **cashflow-company is a live production Firebase project with no test/dev environment** — every `save()`/`addExpense()`/`setWas()`/etc. call writes straight into the real shared data. See project memory `firestore_no_test_env`.

## Testing approach (read this before Task 1)

This project has no test runner, no `package.json`, and no CI — verification is manual, via the Claude Browser tool against the app running from the local files. Because of the constraint above, **verification steps in this plan never submit a mutation with the correct `1223` code and never click a live mutating control on today's date** — those code paths are unchanged by this plan (traced by code review instead) or are handed off to the account owner in the Final Manual Acceptance section at the end. Every in-plan browser check either reads the DOM/values, or triggers a mutation attempt that is provably rejected before it reaches Firestore (wrong code → early `return`, never reaches `save()`).

---

### Task 1: `viewDate` state, date picker, banner

**Files:**
- Modify: `index.html:13` (banner markup), `index.html:45-48` (date input)
- Modify: `app.js:33` (add `viewDate` global + helpers), `app.js:1072-1079` (`renderAll`), `app.js:1288` (`enterApp` wiring)
- Modify: `style.css` (banner + date input styling)

**Interfaces:**
- Produces: global `let viewDate` (a `YYYY-MM-DD` string, defaults to `todayStr()`), `function isViewingPast()` returns bool, `function requirePastEditCode()` returns bool (used by Task 4), `function renderViewDateBanner()`, `function initDatePicker()`.
- Consumes: existing `todayStr()`, `addDays(dateStr, delta)` ([app.js:148](../../../app.js#L148)), `renderAll()`.

- [ ] **Step 1: Add the banner markup to `index.html`**

In `index.html`, the app shell currently opens like this:

```html
<div class="app hidden" id="app">

  <header class="topbar">
```

Change it to:

```html
<div class="app hidden" id="app">

  <div class="view-date-banner hidden" id="viewDateBanner">
    <span id="viewDateBannerText"></span>
    <button type="button" id="viewDateTodayBtn" class="btn btn-secondary">Сегодня</button>
  </div>

  <header class="topbar">
```

- [ ] **Step 2: Add the date input to `index.html`**

Currently:

```html
      <div class="panel-head-actions">
        <button id="newMonthBtn" class="btn btn-secondary admin-only">Перейти к новому месяцу</button>
        <button id="toggleAddRow" class="btn btn-secondary admin-only">+ Добавить</button>
      </div>
```

Change to:

```html
      <div class="panel-head-actions">
        <input type="date" id="viewDateInput" class="date-picker-input" title="Показать данные за день">
        <button id="newMonthBtn" class="btn btn-secondary admin-only">Перейти к новому месяцу</button>
        <button id="toggleAddRow" class="btn btn-secondary admin-only">+ Добавить</button>
      </div>
```

- [ ] **Step 3: Add banner/input styling to `style.css`**

Append to the end of `style.css`:

```css

/* ---------- historical date view ---------- */

.view-date-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 0 0 16px;
  padding: 10px 16px;
  background: rgba(255, 159, 10, 0.14);
  border: 1px solid rgba(255, 159, 10, 0.4);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
}

.date-picker-input {
  font-family: inherit;
  font-size: 14px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
}
```

(The page already has a global `.hidden { display: none; }` rule at [style.css:1019](../../../style.css#L1019) — the banner's `hidden` class relies on that, nothing extra needed for it.)

- [ ] **Step 4: Add `viewDate` global and helper functions in `app.js`**

Currently:

```js
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthOf = (dateStr) => dateStr.slice(0, 7);
```

Change to:

```js
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthOf = (dateStr) => dateStr.slice(0, 7);

// The date the whole page is currently showing. Defaults to today and only
// ever changes via the date picker (initDatePicker) — never persisted, so a
// reload always comes back to today.
let viewDate = todayStr();
function isViewingPast() { return viewDate !== todayStr(); }
// Same confirmation code as the existing "Исправить «Отдали в этом месяце»"
// admin tool (see the data-fix-month handler below). Editing a past day's
// Было/Поступило/источники/категории goes through this so it can't happen
// from an accidental click while just browsing history — asked fresh on
// every attempt, not a session-wide unlock.
function requirePastEditCode() {
  if (!isViewingPast()) return true;
  const code = prompt('Просмотр прошлой даты. Код подтверждения для правки:');
  if (code === null) return false;
  if (code !== '1223') { alert('Неверный код'); return false; }
  return true;
}
```

- [ ] **Step 5: Add `renderViewDateBanner()` and call it from `renderAll()`**

Currently:

```js
function renderAll() {
  balanceEntryCache.clear();
  renderMethods();
  renderExpenseTable();
  renderDebtSummary();
  renderKpis();
  renderRowMenu();
}
```

Change to:

```js
function renderViewDateBanner() {
  const banner = document.getElementById('viewDateBanner');
  const text = document.getElementById('viewDateBannerText');
  if (!banner) return;
  banner.classList.toggle('hidden', !isViewingPast());
  if (isViewingPast()) {
    const [y, m, d] = viewDate.split('-');
    text.textContent = `Просмотр: ${d}.${m}.${y} — только просмотр`;
  }
}

function renderAll() {
  balanceEntryCache.clear();
  renderViewDateBanner();
  renderMethods();
  renderExpenseTable();
  renderDebtSummary();
  renderKpis();
  renderRowMenu();
}
```

- [ ] **Step 6: Add `initDatePicker()` and wire it up in `enterApp()`**

Add this function right after `setDateDisplay()`:

```js
function setDateDisplay() {
  document.getElementById('todayDate').textContent =
    new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function initDatePicker() {
  const input = document.getElementById('viewDateInput');
  const todayBtn = document.getElementById('viewDateTodayBtn');
  if (!input) return;
  const today = todayStr();
  input.min = addDays(today, -30);
  input.max = today;
  input.value = viewDate;
  input.addEventListener('change', () => {
    viewDate = input.value || today;
    renderAll();
  });
  if (todayBtn) {
    todayBtn.addEventListener('click', () => {
      viewDate = today;
      input.value = today;
      renderAll();
    });
  }
}
```

Then in `enterApp()`, currently:

```js
    if (document.getElementById('methodsRow')) { setDateDisplay(); setupGlobalEvents(); }
```

Change to (this must run for every user, not just admins — `setupGlobalEvents()` itself early-returns for non-admins, `initDatePicker()` must not):

```js
    if (document.getElementById('methodsRow')) { setDateDisplay(); initDatePicker(); setupGlobalEvents(); }
```

- [ ] **Step 7: Verify in the browser (read-only — safe, no Firestore writes)**

Open `index.html` in the Browser pane (`preview_start` with a `url` pointing at the local file, or the project's existing dev/hosting setup if one is already configured — check for `.claude/launch.json` first).

1. `read_page` on the panel-head-actions area — confirm the date input is present with `min` = 30 days before today and `max` = today, value = today.
2. `computer` click the date input, pick a date 5 days before today.
3. `read_page` — confirm `#viewDateBanner` no longer has the `hidden` class and its text reads `Просмотр: <дата> — только просмотр`.
4. Confirm none of the debt table / Было-Поступило numbers changed yet (expected at this point — Task 2 wires that up).
5. `computer` click "Сегодня" — confirm the banner gets the `hidden` class back and the date input value returns to today.

- [ ] **Step 8: Commit**

```bash
git add index.html style.css app.js
git commit -m "feat: add date picker and past-date banner (viewDate state)"
```

---

### Task 2: Wire every render function to `viewDate`

**Files:**
- Modify: `app.js:280` (`liveBalanceValues`), `app.js:457` (`renderMethods`), `app.js:639` (`renderRow`), `app.js:749-750` (`renderExpenseTable`), `app.js:858` (`renderKpis`), `app.js:1053` (`renderDebtSummary`)

**Interfaces:**
- Consumes: `viewDate` (from Task 1).
- Produces: nothing new — same function signatures, just a different date source.

- [ ] **Step 1: `liveBalanceValues`**

Currently:

```js
function liveBalanceValues(method) {
  const date = todayStr();
```

Change to:

```js
function liveBalanceValues(method) {
  const date = viewDate;
```

- [ ] **Step 2: `renderMethods`**

Currently:

```js
function renderMethods() {
  const date = todayStr();
  const container = document.getElementById('methodsRow');
```

Change to:

```js
function renderMethods() {
  const date = viewDate;
  const container = document.getElementById('methodsRow');
```

- [ ] **Step 3: `renderRow`**

Currently:

```js
function renderRow(r) {
  const date = todayStr();
  const month = monthOf(date);
```

Change to:

```js
function renderRow(r) {
  const date = viewDate;
  const month = monthOf(date);
```

- [ ] **Step 4: `renderExpenseTable`**

Currently:

```js
function renderExpenseTable() {
  const rows = getRows();
  const tbody = document.getElementById('expenseTableBody');
  const tfoot = document.getElementById('expenseTableFoot');
  const date = todayStr();
  const month = monthOf(date);
```

Change to:

```js
function renderExpenseTable() {
  const rows = getRows();
  const tbody = document.getElementById('expenseTableBody');
  const tfoot = document.getElementById('expenseTableFoot');
  const date = viewDate;
  const month = monthOf(date);
```

- [ ] **Step 5: `renderKpis`**

Currently:

```js
function renderKpis() {
  const date = todayStr();
```

Change to:

```js
function renderKpis() {
  const date = viewDate;
```

- [ ] **Step 6: `renderDebtSummary`**

Currently:

```js
  const tfoot = document.getElementById('debtSummaryFoot');
  const month = monthOf(todayStr());
```

Change to:

```js
  const tfoot = document.getElementById('debtSummaryFoot');
  const month = monthOf(viewDate);
```

- [ ] **Step 7: Verify in the browser (read-only)**

1. Reload the page, `computer` screenshot — note the numbers shown for today (baseline).
2. Pick a date a few days in the past via the date picker.
3. `read_page` on the debt table (`#expenseTableBody`), the KPI row, and one method block — confirm at least the "Отдали сегодня" and "Отдали в этом месяце" values differ from the today baseline for rows that have expenses recorded on/around that date (they should reflect that day's data, not today's).
4. Click "Сегодня" — confirm the table returns to exactly the baseline from step 1 (`read_page` diff, or a second screenshot).

- [ ] **Step 8: Commit**

```bash
git add app.js
git commit -m "feat: drive every render function from viewDate instead of todayStr()"
```

---

### Task 3: Hard-lock non-date-scoped admin controls while viewing a past date

**Files:**
- Modify: `app.js:638-644` (`renderRow` — add `canEditRows`), `app.js:664` (drag handle), `app.js:671` (row-menu toggle button), `app.js:646` (editing-row branch), `app.js:1072-1079` (`renderAll` — add `updateStaticAdminLocks()`)
- Modify: `style.css` (disabled-button styling)

**Interfaces:**
- Consumes: `isViewingPast()` (Task 1).
- Produces: `function updateStaticAdminLocks()`.

- [ ] **Step 1: Add `canEditRows` to `renderRow` and use it instead of `state.isAdmin` for row-level admin affordances**

Currently:

```js
function renderRow(r) {
  const date = viewDate;
  const month = monthOf(date);
  const today = paidTodayByName(r.name, date);
  const monthPaid = paidThisMonthByName(r.name, month);
  const diff = r.due - monthPaid;
  const diffClass = diff === 0 ? 'diff-zero' : (diff > 0 ? 'diff-pos' : 'diff-neg');

  if (state.isAdmin && editingRowId === r.id) {
```

Change to:

```js
function renderRow(r) {
  const date = viewDate;
  const month = monthOf(date);
  const today = paidTodayByName(r.name, date);
  const monthPaid = paidThisMonthByName(r.name, month);
  const diff = r.due - monthPaid;
  const diffClass = diff === 0 ? 'diff-zero' : (diff > 0 ? 'diff-pos' : 'diff-neg');
  // Row add/edit/delete/reorder are never day-scoped, so unlike the
  // Было/Поступило/категории gate (requirePastEditCode) there is no code
  // that unlocks these while browsing a past date — they're just hidden.
  const canEditRows = state.isAdmin && !isViewingPast();

  if (canEditRows && editingRowId === r.id) {
```

- [ ] **Step 2: Use `canEditRows` for the drag handle and row-menu button**

Currently:

```js
      <td class="drag-col">${state.isAdmin ? `<span class="drag-handle" draggable="true" title="Перетащить">⋮⋮</span>` : ''}</td>
      <td class="date-cell">${escapeHtml(r.payDate || '—')}</td>
      <td>${r.isDebt ? `<span class="debt-dot" title="Долг"></span>` : ''}${escapeHtml(r.name)}${r.comment ? `<span class="info-icon" data-view-comment="${r.id}" title="${escapeHtml(r.comment)}">i</span>` : ''}</td>
      <td class="num due-cell">${fmt(r.due)}</td>
      <td class="num today-cell">${fmtSigned(today)}</td>
      <td class="num month-cell">${fmt(monthPaid)}</td>
      <td class="num"><span class="diff-value ${diffClass}">${fmt(diff)}</span></td>
      <td class="actions-cell">${state.isAdmin ? `<button class="btn-icon" data-row-menu-toggle="${r.id}" title="Меню">⋯</button>` : ''}</td>
```

Change to:

```js
      <td class="drag-col">${canEditRows ? `<span class="drag-handle" draggable="true" title="Перетащить">⋮⋮</span>` : ''}</td>
      <td class="date-cell">${escapeHtml(r.payDate || '—')}</td>
      <td>${r.isDebt ? `<span class="debt-dot" title="Долг"></span>` : ''}${escapeHtml(r.name)}${r.comment ? `<span class="info-icon" data-view-comment="${r.id}" title="${escapeHtml(r.comment)}">i</span>` : ''}</td>
      <td class="num due-cell">${fmt(r.due)}</td>
      <td class="num today-cell">${fmtSigned(today)}</td>
      <td class="num month-cell">${fmt(monthPaid)}</td>
      <td class="num"><span class="diff-value ${diffClass}">${fmt(diff)}</span></td>
      <td class="actions-cell">${canEditRows ? `<button class="btn-icon" data-row-menu-toggle="${r.id}" title="Меню">⋯</button>` : ''}</td>
```

- [ ] **Step 3: Add `updateStaticAdminLocks()` and call it from `renderAll()`**

Currently:

```js
function renderAll() {
  balanceEntryCache.clear();
  renderViewDateBanner();
  renderMethods();
  renderExpenseTable();
  renderDebtSummary();
  renderKpis();
  renderRowMenu();
}
```

Change to:

```js
function updateStaticAdminLocks() {
  const past = isViewingPast();
  const newMonthBtn = document.getElementById('newMonthBtn');
  const toggleAddRow = document.getElementById('toggleAddRow');
  const newRowForm = document.getElementById('newRowForm');
  if (newMonthBtn) newMonthBtn.disabled = past;
  if (toggleAddRow) toggleAddRow.disabled = past;
  if (newRowForm && past) newRowForm.classList.add('hidden');
}

function renderAll() {
  balanceEntryCache.clear();
  renderViewDateBanner();
  updateStaticAdminLocks();
  renderMethods();
  renderExpenseTable();
  renderDebtSummary();
  renderKpis();
  renderRowMenu();
}
```

- [ ] **Step 4: Add disabled-button styling to `style.css`**

Append:

```css

.btn:disabled,
.btn:disabled:hover {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}
```

- [ ] **Step 5: Verify in the browser (read-only — buttons are disabled, nothing to click)**

As an admin user:

1. On today's date, `read_page` — confirm `#newMonthBtn` and `#toggleAddRow` have no `disabled` attribute, and at least one row shows a drag handle and a `⋯` button.
2. Switch the date picker to a past date.
3. `read_page` again — confirm `#newMonthBtn` and `#toggleAddRow` now have `disabled`, and no row renders a drag handle or `⋯` button.
4. Click "Сегодня" — confirm both buttons lose `disabled` again and the drag handles / `⋯` buttons reappear.

- [ ] **Step 6: Commit**

```bash
git add app.js style.css
git commit -m "feat: hard-lock row-level admin controls while viewing a past date"
```

---

### Task 4: Code-gate the date-scoped mutations (Было/Поступило/источники/категории)

**Files:**
- Modify: `app.js` inside `renderMethods()`: the `data-expense-form` submit handler, `data-check-expense` click handler, `data-del-expense` click handler, `data-balance-was` handlers, `data-balance-income` handlers, `data-source-form` submit handler, `data-del-source` click handler (all currently between roughly lines 544-634)

**Interfaces:**
- Consumes: `requirePastEditCode()` (Task 1).

- [ ] **Step 1: Gate `addExpense` (add category)**

Currently:

```js
  container.querySelectorAll('[data-expense-form]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const method = form.dataset.expenseForm;
      const name = form.querySelector('[data-expense-name]').value.trim();
      const amount = parseAmount(form.querySelector('[data-expense-amount]'));
      if (!amount || amount <= 0) return;
      addExpense(method, name, amount);
      closeAllAutocomplete();
      renderAll();
    });
  });
```

Change to:

```js
  container.querySelectorAll('[data-expense-form]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const method = form.dataset.expenseForm;
      const name = form.querySelector('[data-expense-name]').value.trim();
      const amount = parseAmount(form.querySelector('[data-expense-amount]'));
      if (!amount || amount <= 0) return;
      if (!requirePastEditCode()) return;
      addExpense(method, name, amount);
      closeAllAutocomplete();
      renderAll();
    });
  });
```

- [ ] **Step 2: Gate `toggleExpense` (check off a category payment)**

Currently:

```js
  container.querySelectorAll('[data-check-expense]').forEach(btn => {
    btn.addEventListener('click', () => { toggleExpense(btn.dataset.checkExpense); renderAll(); });
  });
```

Change to:

```js
  container.querySelectorAll('[data-check-expense]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!requirePastEditCode()) return;
      toggleExpense(btn.dataset.checkExpense);
      renderAll();
    });
  });
```

- [ ] **Step 3: Gate `deleteExpense` (delete a category payment)**

Currently:

```js
  container.querySelectorAll('[data-del-expense]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.delExpense;
      const item = getExpenses().find(e => e.id === id);
      if (!item || !confirm(`Удалить платёж «${item.name || 'без названия'}» (${fmt(item.amount)})?`)) return;
      deleteExpense(id);
      renderAll();
    });
  });
```

Change to:

```js
  container.querySelectorAll('[data-del-expense]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.delExpense;
      const item = getExpenses().find(e => e.id === id);
      if (!item || !confirm(`Удалить платёж «${item.name || 'без названия'}» (${fmt(item.amount)})?`)) return;
      if (!requirePastEditCode()) return;
      deleteExpense(id);
      renderAll();
    });
  });
```

- [ ] **Step 4: Gate `setWas` (Было)**

Currently:

```js
  container.querySelectorAll('[data-balance-was]').forEach(input => {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      setWas(input.dataset.balanceWas, date, parseAmount(input));
      renderAll();
    });
    input.addEventListener('change', () => {
      setWas(input.dataset.balanceWas, date, parseAmount(input));
      renderAll();
    });
  });
```

Change to:

```js
  container.querySelectorAll('[data-balance-was]').forEach(input => {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!requirePastEditCode()) { renderAll(); return; }
      setWas(input.dataset.balanceWas, date, parseAmount(input));
      renderAll();
    });
    input.addEventListener('change', () => {
      if (!requirePastEditCode()) { renderAll(); return; }
      setWas(input.dataset.balanceWas, date, parseAmount(input));
      renderAll();
    });
  });
```

(The `renderAll()` on rejection resets the input back to the real stored value, discarding the typed-but-blocked edit.)

- [ ] **Step 5: Gate `setIncome` (Поступило)**

Currently:

```js
  container.querySelectorAll('[data-balance-income]').forEach(input => {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      setIncome(input.dataset.balanceIncome, date, parseAmount(input));
      renderAll();
    });
    input.addEventListener('change', () => {
      setIncome(input.dataset.balanceIncome, date, parseAmount(input));
      renderAll();
    });
  });
```

Change to:

```js
  container.querySelectorAll('[data-balance-income]').forEach(input => {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!requirePastEditCode()) { renderAll(); return; }
      setIncome(input.dataset.balanceIncome, date, parseAmount(input));
      renderAll();
    });
    input.addEventListener('change', () => {
      if (!requirePastEditCode()) { renderAll(); return; }
      setIncome(input.dataset.balanceIncome, date, parseAmount(input));
      renderAll();
    });
  });
```

- [ ] **Step 6: Gate `addSource` (add income source)**

Currently:

```js
  container.querySelectorAll('[data-source-form]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const method = form.dataset.sourceForm;
      const label = form.querySelector('[data-source-label]').value.trim() || 'Доход';
      const amount = parseAmount(form.querySelector('[data-source-amount]'));
      if (!amount || amount <= 0) {
        alert('Укажите сумму больше нуля.');
        return;
      }
      addSource(method, date, label, amount);
      openSourceForm = null;
      renderAll();
    });
  });
```

Change to:

```js
  container.querySelectorAll('[data-source-form]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const method = form.dataset.sourceForm;
      const label = form.querySelector('[data-source-label]').value.trim() || 'Доход';
      const amount = parseAmount(form.querySelector('[data-source-amount]'));
      if (!amount || amount <= 0) {
        alert('Укажите сумму больше нуля.');
        return;
      }
      if (!requirePastEditCode()) return;
      addSource(method, date, label, amount);
      openSourceForm = null;
      renderAll();
    });
  });
```

- [ ] **Step 7: Gate `removeSource` (delete income source)**

Currently:

```js
  container.querySelectorAll('[data-del-source]').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.method;
      const id = btn.dataset.delSource;
      const item = getExpenses().find(e => e.id === id);
      if (!item || !confirm(`Удалить источник «${item.label}» (${fmt(item.amount)})?`)) return;
      removeSource(method, date, id);
      renderAll();
    });
  });
}
```

Change to:

```js
  container.querySelectorAll('[data-del-source]').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.method;
      const id = btn.dataset.delSource;
      const item = getExpenses().find(e => e.id === id);
      if (!item || !confirm(`Удалить источник «${item.label}» (${fmt(item.amount)})?`)) return;
      if (!requirePastEditCode()) return;
      removeSource(method, date, id);
      renderAll();
    });
  });
}
```

- [ ] **Step 8: Verify in the browser — wrong-code path only (safe: never reaches Firestore)**

As an admin user, on a **past** date:

1. Open the "+" add-source form for one method (`data-toggle-source` — this only toggles local UI state, no write). Fill in a label and amount, submit. A `prompt()` appears — type an obviously wrong code (e.g. `0000`) and confirm.
2. `read_console_messages` / `read_network_requests` — confirm no Firestore write request fired and an `alert('Неверный код')` was shown.
3. `read_page` — confirm the "Сумма"/"Остаток" numbers for that method are unchanged from before the attempt.
4. Repeat the same wrong-code check for one category (`+` under Расходы) and for typing into "Было" and pressing Enter — same expectation each time: prompt appears, wrong code rejected, no write, numbers unchanged.
5. Do **not** enter `1223` during this check, and do not test the accept path here — see "Final Manual Acceptance" below.

- [ ] **Step 9: Code-review check that today's date is completely unaffected**

Read back every handler touched in Steps 1-7 and confirm: when `isViewingPast()` is `false` (today), `requirePastEditCode()` returns `true` immediately with no `prompt()` call, so the code path to `addExpense`/`setWas`/`setIncome`/`addSource`/`removeSource`/`toggleExpense`/`deleteExpense` is byte-for-byte the same as before this task. This is a reasoning check, not a live click test — today's mutation path already worked before this plan and is not being changed.

- [ ] **Step 10: Commit**

```bash
git add app.js
git commit -m "feat: gate past-date edits to Было/Поступило/источники/категории behind confirmation code"
```

---

## Self-Review Notes

- **Spec coverage:** date picker + range (Task 1) — full-page scope (Tasks 2-4 cover debt table, method blocks, KPIs, Долги summary) — read-only banner (Task 1) — hard lock on non-date-scoped controls (Task 3) — code-gated edit on date-scoped controls (Task 4, same `1223` code as existing tool) — `viewDate` not persisted (Task 1, plain `let`, no localStorage/Firestore write) — 30-day range (Task 1 `min`/`max`). All spec sections have a task.
- **Type consistency:** `viewDate` is always a `YYYY-MM-DD` string end to end, same shape `todayStr()` already produced everywhere it's substituted in.
- **Extra fix found during file-structure mapping not in the original spec conversation:** `renderDebtSummary()` ([app.js:1053](../../../app.js#L1053), the second "Долги" panel) also hardcoded `todayStr()` for its month calculation — included in Task 2 Step 6 since it's the same mechanical substitution and the spec's "вся страница" (whole page) scope covers it.

## Final Manual Acceptance (do this yourself, not via automated browser control)

This plan's automated verification deliberately never supplies the correct `1223` code or edits live data (see "Testing approach" above — this project has no dev/test Firebase project, only the real one). Once all 4 tasks are merged, please do this final check yourself, logged in as admin:

1. Pick a past date within the last 30 days.
2. Try editing "Было" (or any category/source) — confirm the code prompt appears, enter `1223`, confirm the edit actually saves and shows correctly both immediately and after switching away and back to that date.
3. Click "Сегодня" and confirm today's data still edits normally with no prompt at all, exactly as before.
