/* Cashflow Tracker — logic matches the original spreadsheet exactly:
   - "Категории" per method (Наличка/Click/Терминал): name + amount, entered manually.
     The checkbox just marks a payment as done — it does not affect any sum.
     Category entries are scoped to the exact day they were added, so the list
     empties out automatically the next day, while still counting toward that
     debt's "Отдали в этом месяце" in the main table (nothing is lost).
   - "Было", "Поступило" and any extra income sources per method are entered
     manually each day.
   - Everything else (Сумма, Остаток, KPIs, Отдали Сегодня/в этом месяце, Разница)
     is calculated automatically. No localStorage seed data. */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
db.settings({ experimentalAutoDetectLongPolling: true });

// state.isAdmin gates every mutating listener/render affordance — only the
// admin can write; everyone else gets the same shared data read-only.
let state = { isAdmin: false, currentUser: null };

const STORAGE = {
  rows: 'cf_rows',           // {id, name, due}
  expenses: 'cf_expenses',   // {id, method, name, amount, checked, date, ts, comment, deleted, deletedAt}
  balances: 'cf_balances',   // { "<method>_<date>": {was, income, sources:[{id,label,amount,ts,comment,deleted,deletedAt}]} }
};

const METHODS = ['Наличка', 'Click', 'Терминал'];
const METHOD_PHRASE = { 'Наличка': 'в наличке', 'Click': 'в Click', 'Терминал': 'по терминалу' };

const fmt = (n) => Math.round(n || 0).toLocaleString('ru-RU');
const fmtSigned = (n) => n > 0 ? `-${fmt(n)}` : '—';
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthOf = (dateStr) => dateStr.slice(0, 7);

// live "1 000 / 10 000 / 100 000" grouping as the user types into any
// [data-amount] field, keeping the cursor in the right spot
function parseAmount(input) {
  return Number((input.value || '').replace(/\D/g, '')) || 0;
}
function formatAmountInput(input) {
  const raw = input.value;
  const cursor = input.selectionStart ?? raw.length;
  const digitsBeforeCursor = raw.slice(0, cursor).replace(/\D/g, '').length;
  const digitsOnly = raw.replace(/\D/g, '');
  const formatted = digitsOnly ? Number(digitsOnly).toLocaleString('ru-RU') : '';
  input.value = formatted;
  if (digitsBeforeCursor === 0) { input.setSelectionRange(0, 0); return; }
  let count = 0, pos = formatted.length;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) count++;
    if (count === digitsBeforeCursor) { pos = i + 1; break; }
  }
  input.setSelectionRange(pos, pos);
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function load(key, fallback) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : fallback;
}

// Shared data now lives in Firestore (collection "cashflow", one doc per
// dataset) so every registered user sees the same live numbers instead of
// their own empty per-browser localStorage. CACHE mirrors the 3 datasets in
// memory, kept in sync by onSnapshot listeners (see attachSnapshotListeners),
// so every existing getRows()/getExpenses()/getBalances() call site and every
// derived-computation helper below keeps working completely unchanged.
const CACHE = { rows: [], expenses: [], balances: {} };
const STORAGE_TO_CACHE_KEY = { [STORAGE.rows]: 'rows', [STORAGE.expenses]: 'expenses', [STORAGE.balances]: 'balances' };

// Guards against the failure mode where a mutation fires before the initial
// onSnapshot data has arrived: CACHE would still be empty, and since save()
// does a full .set() (not a merge), that would wipe the entire shared
// document down to just the one new item. snapshotsLoaded is flipped true
// per-doc the first time attachSnapshotListeners() hears back from Firestore;
// enterApp() also waits on it before wiring up any mutating UI, so this is
// a backstop for anything that could still slip through.
const snapshotsLoaded = { rows: false, expenses: false, balances: false };
function allDataLoaded() {
  return snapshotsLoaded.rows && snapshotsLoaded.expenses && snapshotsLoaded.balances;
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

// A save that drops more than half the records (and more than a handful
// outright) is very unlikely to be one intentional action — single
// deletes only ever remove one item at a time. Catches any future bug of
// this shape, not just the specific race this file already guards against.
function isSuspiciousShrink(previousValue, nextValue) {
  const before = countOf(previousValue), after = countOf(nextValue);
  return before >= 5 && after < before - 3 && after < before * 0.5;
}

// Best-effort "one step back" safety net: stash whatever was live just
// before an overwrite into a separate doc. Fire-and-forget — never blocks
// or delays the real save, so a backup failure can't break normal use.
function backupPreviousValue(cacheKey, previousValue) {
  db.collection('cashflow_backups').doc(cacheKey)
    .set({ data: previousValue, ts: Date.now() })
    .catch((err) => console.error('Backup failed', err));
}

function save(key, value) {
  const cacheKey = STORAGE_TO_CACHE_KEY[key];
  if (!allDataLoaded()) {
    console.error('Blocked save() before initial data finished loading — would have overwritten real data with a partial CACHE', cacheKey, value);
    alert('Данные ещё загружаются. Подождите пару секунд и повторите.');
    return;
  }
  const previous = CACHE[cacheKey];
  if (isSuspiciousShrink(previous, value)) {
    const before = countOf(previous), after = countOf(value);
    if (!confirm(`Это действие уменьшит «${cacheKey}» с ${before} до ${after} записей — заметно больше, чем обычно удаляется за раз. Точно продолжить?`)) {
      renderAll();
      return;
    }
  }
  backupPreviousValue(cacheKey, previous);
  CACHE[cacheKey] = value; // optimistic — renderAll() called right after a mutation sees the change immediately
  db.collection('cashflow').doc(cacheKey).set({ data: value }).catch((err) => {
    console.error('Save failed', err);
    alert('Не удалось сохранить: проверьте соединение.');
  });
}

function getRows() { return CACHE.rows; }
function getExpenses() { return CACHE.expenses; }
function getBalances() { return CACHE.balances; }

// Pure calendar-string arithmetic, all in UTC (both parse and format), so it
// never shifts by a day depending on the browser's local timezone offset —
// consistent with todayStr() elsewhere treating date strings as UTC days.
function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// true if this method has any recorded activity (a saved balance entry or a
// non-deleted expense) strictly before `date` — used to stop the day-by-day
// carry-forward in getBalanceEntry once we're past the method's real history.
function hasEarlierActivity(method, date) {
  const balances = getBalances();
  const prefix = `${method}_`;
  const hasBalanceEntry = Object.keys(balances).some(k => k.startsWith(prefix) && k.slice(prefix.length) < date);
  if (hasBalanceEntry) return true;
  return getExpenses().some(e => e.method === method && e.date < date && !e.deleted);
}

// getBalanceEntry recurses through every day back to the last saved entry,
// and methodTotal/methodNewIncome/sourcesSum each call it again for the same
// (method, date) — without caching, that's 3 calls per recursion level, so a
// gap of N days becomes 3^N calls (a multi-month gap between saved "Было"
// entries — normal usage, since not every day gets touched — made this
// effectively hang). Memoizing collapses it back to one computation per day.
// Cleared at the top of renderAll() so every render still reflects current data.
let balanceEntryCache = new Map();
function getBalanceEntry(method, date) {
  const cacheKey = `${method}_${date}`;
  if (balanceEntryCache.has(cacheKey)) return balanceEntryCache.get(cacheKey);
  const entry = getBalances()[cacheKey];
  let result;
  if (entry) {
    result = { was: entry.was || 0, income: entry.income || 0, sources: entry.sources || [], wasTs: entry.wasTs, incomeTs: entry.incomeTs };
  } else if (!hasEarlierActivity(method, date)) {
    // No record yet for this day and nothing earlier — carry 0 into "Было".
    result = { was: 0, income: 0, sources: [] };
  } else {
    // No record yet for this day — carry the PREVIOUS CALENDAR DAY's Остаток
    // into "Было" (everything else starts at 0). Recurses one day at a time
    // (rather than jumping to the nearest day that happens to have a saved
    // balance entry), so a day nobody touched "Было"/"Поступило" still has
    // its own expenses subtracted before the balance carries forward.
    result = { was: methodRemainder(method, addDays(date, -1)), income: 0, sources: [] };
  }
  balanceEntryCache.set(cacheKey, result);
  return result;
}
function saveBalanceEntry(method, date, entry) {
  const balances = getBalances();
  balances[`${method}_${date}`] = entry;
  save(STORAGE.balances, balances);
}
function setWas(method, date, was) {
  const entry = getBalanceEntry(method, date);
  entry.was = was;
  entry.wasTs = Date.now();
  saveBalanceEntry(method, date, entry);
}
function setIncome(method, date, income) {
  const entry = getBalanceEntry(method, date);
  entry.income = income;
  entry.incomeTs = Date.now();
  saveBalanceEntry(method, date, entry);
}
function addSource(method, date, label, amount) {
  const entry = getBalanceEntry(method, date);
  entry.sources.push({ id: uid(), label, amount, ts: Date.now(), comment: '', deleted: false });
  saveBalanceEntry(method, date, entry);
}
// soft delete — the record stays (with a deletedAt stamp) so История can
// still show it, struck through, instead of just vanishing
function removeSource(method, date, id) {
  const entry = getBalanceEntry(method, date);
  const s = entry.sources.find(x => x.id === id);
  if (s) { s.deleted = true; s.deletedAt = Date.now(); saveBalanceEntry(method, date, entry); }
}
function setSourceComment(method, date, id, comment) {
  const entry = getBalanceEntry(method, date);
  const s = entry.sources.find(x => x.id === id);
  if (s) { s.comment = comment; saveBalanceEntry(method, date, entry); }
}

// ---------- calculations ----------

function expensesFor(method, date) {
  return getExpenses().filter(e => e.method === method && e.date === date && !e.deleted);
}
function categorySum(method, date) {
  return expensesFor(method, date).reduce((s, e) => s + e.amount, 0);
}
function sourcesSum(method, date) {
  return getBalanceEntry(method, date).sources.filter(s => !s.deleted).reduce((s, x) => s + x.amount, 0);
}
function methodNewIncome(method, date) {
  const entry = getBalanceEntry(method, date);
  return entry.income + sourcesSum(method, date);
}
function methodTotal(method, date) {
  const entry = getBalanceEntry(method, date);
  return entry.was + methodNewIncome(method, date);
}
function methodRemainder(method, date) {
  return methodTotal(method, date) - categorySum(method, date);
}

// how much a given debt-row name was paid today, across all 3 methods
function paidTodayByName(name, date) {
  return getExpenses()
    .filter(e => e.name.trim() === name.trim() && e.date === date && !e.deleted)
    .reduce((s, e) => s + e.amount, 0);
}
// how much a given debt-row name was paid this month, across all 3 methods
// (this is why category entries can safely reset daily — history is preserved here)
function paidThisMonthByName(name, month) {
  return getExpenses()
    .filter(e => e.name.trim() === name.trim() && e.date.startsWith(month) && !e.deleted)
    .reduce((s, e) => s + e.amount, 0);
}

// ---------- mutations ----------

function addRow(name, due, payDate, comment) {
  const rows = getRows();
  rows.push({ id: uid(), name, due, payDate: payDate || '', comment: comment || '' });
  save(STORAGE.rows, rows);
}
function editRow(id, name, due, payDate) {
  const rows = getRows();
  const row = rows.find(r => r.id === id);
  if (row) { row.name = name; row.due = due; row.payDate = payDate || ''; save(STORAGE.rows, rows); }
}
function setRowComment(id, comment) {
  const rows = getRows();
  const row = rows.find(r => r.id === id);
  if (row) { row.comment = comment; save(STORAGE.rows, rows); }
}
function toggleRowDebt(id) {
  const rows = getRows();
  const row = rows.find(r => r.id === id);
  if (row) { row.isDebt = !row.isDebt; save(STORAGE.rows, rows); }
}
function deleteRow(id) {
  save(STORAGE.rows, getRows().filter(r => r.id !== id));
}
// "Новый месяц" — soft-deletes every active expense so "Отдали в этом месяце"
// zeroes out for all rows, while История still keeps the full record
function startNewMonth() {
  const list = getExpenses();
  list.forEach(e => { if (!e.deleted) { e.deleted = true; e.deletedAt = Date.now(); } });
  save(STORAGE.expenses, list);
}
function moveRow(id, toIndex) {
  const rows = getRows();
  const fromIndex = rows.findIndex(r => r.id === id);
  if (fromIndex === -1) return;
  const [item] = rows.splice(fromIndex, 1);
  rows.splice(Math.max(0, Math.min(toIndex, rows.length)), 0, item);
  save(STORAGE.rows, rows);
}
function addExpense(method, name, amount) {
  const list = getExpenses();
  list.push({ id: uid(), method, name, amount, checked: false, date: todayStr(), ts: Date.now(), comment: '', deleted: false });
  save(STORAGE.expenses, list);
}
function toggleExpense(id) {
  const list = getExpenses();
  const e = list.find(x => x.id === id);
  if (e) { e.checked = !e.checked; save(STORAGE.expenses, list); }
}
// soft delete — kept (struck through) in История instead of disappearing
function deleteExpense(id) {
  const list = getExpenses();
  const e = list.find(x => x.id === id);
  if (e) { e.deleted = true; e.deletedAt = Date.now(); save(STORAGE.expenses, list); }
}
function setExpenseComment(id, comment) {
  const list = getExpenses();
  const e = list.find(x => x.id === id);
  if (e) { e.comment = comment; save(STORAGE.expenses, list); }
}

// ---------- UI state ----------

let editingRowId = null;
let openSourceForm = null; // method whose "+ добавить источник" form is open
let openRowMenuId = null; // debt-row whose ⋯ actions menu is open

// ---------- category name autocomplete popup ----------

// Lives as a single element directly under <body>, never inside a
// .method-col — those cards have backdrop-filter, which (like transform)
// makes them the containing block for any position:fixed descendant. A menu
// nested inside one would get positioned relative to the card instead of the
// viewport, while the math below assumes viewport coordinates — that
// mismatch is what sent the dropdown flying off to an unrelated card.
let autocompleteMenuEl = null;
let autocompleteTargetInput = null;
function ensureAutocompleteMenu() {
  if (!autocompleteMenuEl) {
    autocompleteMenuEl = document.createElement('div');
    autocompleteMenuEl.className = 'autocomplete-menu hidden';
    document.body.appendChild(autocompleteMenuEl);
  }
  return autocompleteMenuEl;
}

function openAutocompleteFor(input) {
  const menu = ensureAutocompleteMenu();
  autocompleteTargetInput = input;
  const names = [...new Set(getRows().map(r => r.name).filter(Boolean))];
  const f = input.value.trim().toLowerCase();
  const filtered = f ? names.filter(n => n.toLowerCase().startsWith(f)) : names;
  if (!filtered.length) { menu.classList.add('hidden'); menu.innerHTML = ''; return; }
  menu.innerHTML = filtered.map(n => `<div class="autocomplete-item" data-value="${escapeHtml(n)}">${escapeHtml(n)}</div>`).join('');
  menu.classList.remove('hidden');

  // position:fixed, computed from the input itself, so the menu escapes any
  // overflow:hidden ancestor (the rounded cards) and always shows in full
  const rect = input.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const menuHeight = Math.min(280, menu.scrollHeight || 280);
  const openUpward = spaceBelow < menuHeight && rect.top > spaceBelow;
  menu.style.left = `${rect.left}px`;
  menu.style.width = `${rect.width}px`;
  if (openUpward) {
    menu.style.top = 'auto';
    menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${rect.bottom + 6}px`;
  }
}
function closeAllAutocomplete() {
  if (autocompleteMenuEl) autocompleteMenuEl.classList.add('hidden');
  autocompleteTargetInput = null;
}

// ---------- rendering: method blocks ----------

function renderMethods() {
  const date = todayStr();
  const container = document.getElementById('methodsRow');

  container.innerHTML = METHODS.map(method => {
    const entries = expensesFor(method, date);
    const catSum = categorySum(method, date);
    const bal = getBalanceEntry(method, date);
    const total = methodTotal(method, date);
    const remainder = methodRemainder(method, date);
    const sourceFormOpen = openSourceForm === method;

    const rowsHtml = entries.length
      ? entries.map((e, i) => `
          <div class="cat-row ${e.checked ? 'checked' : ''}">
            ${state.isAdmin
              ? `<button type="button" class="cat-index" data-check-expense="${e.id}" title="Отметить оплату">${e.checked ? '✓' : i + 1}</button>`
              : `<span class="cat-index">${e.checked ? '✓' : i + 1}</span>`}
            <span class="cat-name">${escapeHtml(e.name || '—')}</span>
            <span class="cat-amount">${fmt(e.amount)}</span>
            ${state.isAdmin ? `<button class="cat-del" data-del-expense="${e.id}" title="Удалить">✕</button>` : ''}
          </div>
        `).join('')
      : `<div class="empty-hint">Пока нет записей</div>`;

    const sourcesHtml = bal.sources.filter(s => !s.deleted).map(s => `
      <div class="balance-row source-row">
        <span class="balance-label">${escapeHtml(s.label)}</span>
        <span class="source-amount">${fmt(s.amount)}</span>
        ${state.isAdmin ? `<button class="source-del" data-del-source="${s.id}" data-method="${method}" title="Удалить">✕</button>` : ''}
      </div>
    `).join('');

    return `
      <div class="method-block" data-method="${method}">
        <div class="method-col stripe-green">
          <div class="col-head">Доходы ${METHOD_PHRASE[method]}</div>
          <div class="balance-rows">
            <div class="balance-row">
              <span class="balance-label">Было</span>
              ${state.isAdmin
                ? `<input type="text" inputmode="numeric" class="balance-input" data-balance-was="${method}" data-amount value="${bal.was ? fmt(bal.was) : ''}" placeholder="0">`
                : `<span class="balance-input-static">${fmt(bal.was)}</span>`}
              ${state.isAdmin ? `<button type="button" class="balance-save-btn" data-balance-save-was="${method}" title="Сохранить">+</button>` : ''}
            </div>
            <div class="balance-row">
              <span class="balance-label">Поступило</span>
              ${state.isAdmin
                ? `<input type="text" inputmode="numeric" class="balance-input" data-balance-income="${method}" data-amount value="${bal.income ? fmt(bal.income) : ''}" placeholder="0">`
                : `<span class="balance-input-static">${fmt(bal.income)}</span>`}
              ${state.isAdmin ? `<button type="button" class="balance-save-btn" data-balance-save-income="${method}" title="Сохранить">+</button>` : ''}
            </div>
            ${state.isAdmin ? `
            <form class="source-add-row ${sourceFormOpen ? '' : 'hidden'}" data-source-form="${method}">
              <input type="text" placeholder="Название источника" data-source-label required>
              <input type="text" inputmode="numeric" placeholder="Сумма" data-source-amount data-amount required>
              <button type="submit" class="btn btn-primary">Добавить</button>
            </form>` : ''}
            ${sourcesHtml}
          </div>
          <div class="balance-row sum">
            <span>Сумма</span>
            <span>${fmt(total)}</span>
            ${state.isAdmin ? `<button type="button" class="btn-kebab" data-toggle-source="${method}" title="Добавить источник">⋯</button>` : ''}
          </div>
        </div>
        <div class="method-col stripe-red">
          <div class="col-head">Расходы ${METHOD_PHRASE[method]}</div>
          <div class="cat-list">${rowsHtml}</div>
          ${state.isAdmin ? `
          <form class="cat-add-row" data-expense-form="${method}">
            <div class="autocomplete" data-autocomplete>
              <input type="text" placeholder="Категория" data-expense-name autocomplete="off">
            </div>
            <input type="text" inputmode="numeric" placeholder="Сумма" data-expense-amount data-amount required>
            <button type="submit">+</button>
          </form>` : ''}
          <div class="cat-sum-row"><span></span><span>Сумма</span><span>${fmt(catSum)}</span></div>
        </div>
        <div class="method-col stripe-blue">
          <div class="col-head">Остаток ${METHOD_PHRASE[method]}</div>
          <div class="result-value">
            <span class="result-number">${fmt(remainder)}</span>
            <span class="unit">so'm</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

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

  container.querySelectorAll('[data-check-expense]').forEach(btn => {
    btn.addEventListener('click', () => { toggleExpense(btn.dataset.checkExpense); renderAll(); });
  });

  container.querySelectorAll('[data-del-expense]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.delExpense;
      const item = getExpenses().find(e => e.id === id);
      if (!item || !confirm(`Удалить платёж «${item.name || 'без названия'}» (${fmt(item.amount)})?`)) return;
      deleteExpense(id);
      renderAll();
    });
  });

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
  container.querySelectorAll('[data-balance-save-was]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('[data-balance-was]');
      setWas(btn.dataset.balanceSaveWas, date, parseAmount(input));
      renderAll();
    });
  });
  container.querySelectorAll('[data-balance-save-income]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('[data-balance-income]');
      setIncome(btn.dataset.balanceSaveIncome, date, parseAmount(input));
      renderAll();
    });
  });

  container.querySelectorAll('[data-toggle-source]').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.toggleSource;
      openSourceForm = openSourceForm === method ? null : method;
      renderAll();
      if (openSourceForm) {
        const input = container.querySelector(`[data-source-form="${openSourceForm}"] [data-source-label]`);
        if (input) input.focus();
      }
    });
  });
  container.querySelectorAll('[data-source-form]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const method = form.dataset.sourceForm;
      const label = form.querySelector('[data-source-label]').value.trim();
      const amount = parseAmount(form.querySelector('[data-source-amount]'));
      if (!label || !amount || amount <= 0) return;
      addSource(method, date, label, amount);
      openSourceForm = null;
      renderAll();
    });
  });
  container.querySelectorAll('[data-del-source]').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.method;
      const id = btn.dataset.delSource;
      const item = getBalanceEntry(method, date).sources.find(s => s.id === id);
      if (!item || !confirm(`Удалить источник «${item.label}» (${fmt(item.amount)})?`)) return;
      removeSource(method, date, id);
      renderAll();
    });
  });
}

// ---------- rendering: main table ----------

function renderRow(r) {
  const date = todayStr();
  const month = monthOf(date);
  const today = paidTodayByName(r.name, date);
  const monthPaid = paidThisMonthByName(r.name, month);
  const diff = r.due - monthPaid;
  const diffClass = diff === 0 ? 'diff-zero' : (diff > 0 ? 'diff-pos' : 'diff-neg');

  if (state.isAdmin && editingRowId === r.id) {
    return `
      <tr class="editing">
        <td colspan="8">
          <form class="edit-form" data-edit="${r.id}">
            <input type="text" name="payDate" value="${escapeHtml(r.payDate || '')}" placeholder="Дата (любая, 5 число...)">
            <input type="text" name="name" value="${escapeHtml(r.name)}" required placeholder="Название">
            <input type="text" inputmode="numeric" name="due" value="${fmt(r.due)}" data-amount required placeholder="Должны">
            <button type="submit" class="btn-icon" title="Сохранить">✓</button>
            <button type="button" class="btn-icon" data-cancel-edit title="Отмена">✕</button>
          </form>
        </td>
      </tr>
    `;
  }

  return `
    <tr data-row-id="${r.id}">
      <td class="drag-col">${state.isAdmin ? `<span class="drag-handle" draggable="true" title="Перетащить">⋮⋮</span>` : ''}</td>
      <td class="date-cell">${escapeHtml(r.payDate || '—')}</td>
      <td>${r.isDebt ? `<span class="debt-dot" title="Долг"></span>` : ''}${escapeHtml(r.name)}${r.comment ? `<span class="info-icon" data-view-comment="${r.id}" title="${escapeHtml(r.comment)}">i</span>` : ''}</td>
      <td class="num due-cell">${fmt(r.due)}</td>
      <td class="num today-cell">${fmtSigned(today)}</td>
      <td class="num month-cell">${fmt(monthPaid)}</td>
      <td class="num"><span class="diff-value ${diffClass}">${fmt(diff)}</span></td>
      <td class="actions-cell">${state.isAdmin ? `<button class="btn-icon" data-row-menu-toggle="${r.id}" title="Меню">⋯</button>` : ''}</td>
    </tr>
  `;
}

// Lives as a single element directly under <body>, for the same reason as
// the autocomplete menu above: .panel (which wraps the debt table) has
// backdrop-filter, so a position:fixed element nested inside it gets
// positioned relative to the panel instead of the viewport — which is what
// sent this menu somewhere else on screen instead of next to the ⋯ button.
let rowMenuEl = null;
function ensureRowMenuEl() {
  if (!rowMenuEl) {
    rowMenuEl = document.createElement('div');
    rowMenuEl.className = 'row-menu hidden';
    document.body.appendChild(rowMenuEl);
  }
  return rowMenuEl;
}

function renderRowMenu() {
  const menu = ensureRowMenuEl();
  if (!openRowMenuId) { menu.classList.add('hidden'); return; }
  const row = getRows().find(r => r.id === openRowMenuId);
  const toggleBtn = document.querySelector(`[data-row-menu-toggle="${openRowMenuId}"]`);
  if (!row || !toggleBtn) { openRowMenuId = null; menu.classList.add('hidden'); return; }

  menu.innerHTML = `
    <button data-edit-row>✎ Редактировать</button>
    <button data-mark-debt>${row.isDebt ? '● Убрать пометку долга' : '● Пометить как долг'}</button>
    <button data-comment-row>💬 Комментарий</button>
    <button data-fix-month>🔧 Исправить «Отдали в этом месяце»</button>
    <button data-del-row class="danger">✕ Удалить</button>
  `;
  menu.classList.remove('hidden');

  const rect = toggleBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;

  menu.querySelector('[data-edit-row]').addEventListener('click', () => {
    editingRowId = row.id; openRowMenuId = null; renderAll();
  });
  menu.querySelector('[data-mark-debt]').addEventListener('click', () => {
    toggleRowDebt(row.id); openRowMenuId = null; renderAll();
  });
  menu.querySelector('[data-comment-row]').addEventListener('click', () => {
    const next = prompt('Комментарий:', row.comment || '');
    openRowMenuId = null;
    if (next === null) { renderAll(); return; }
    setRowComment(row.id, next.trim());
    renderAll();
  });
  menu.querySelector('[data-fix-month]').addEventListener('click', () => {
    openRowMenuId = null;
    const m = monthOf(todayStr());
    const current = paidThisMonthByName(row.name, m);
    const raw = prompt(`Новое значение «Отдали в этом месяце» для «${row.name}» (сейчас ${fmt(current)}):`, current);
    if (raw === null) { renderAll(); return; }
    const next = Number(String(raw).replace(/\D/g, ''));
    const code = prompt('Код подтверждения:');
    if (code !== '1223') { alert('Неверный код'); renderAll(); return; }
    const delta = next - current;
    if (delta !== 0) addExpense('Корректировка', row.name, delta);
    renderAll();
  });
  menu.querySelector('[data-del-row]').addEventListener('click', () => {
    openRowMenuId = null;
    if (!confirm(`Удалить «${row.name}»?`)) { renderAll(); return; }
    deleteRow(row.id);
    renderAll();
  });
}

function renderExpenseTable() {
  const rows = getRows();
  const tbody = document.getElementById('expenseTableBody');
  const tfoot = document.getElementById('expenseTableFoot');
  const date = todayStr();
  const month = monthOf(date);

  tbody.innerHTML = rows.length
    ? rows.map(renderRow).join('')
    : `<tr><td colspan="8" class="empty-hint">Пока нет статей. Нажмите «+ Добавить», чтобы добавить первую.</td></tr>`;

  const due = rows.reduce((s, r) => s + r.due, 0);
  const today = rows.reduce((s, r) => s + paidTodayByName(r.name, date), 0);
  const monthPaid = rows.reduce((s, r) => s + paidThisMonthByName(r.name, month), 0);
  const diff = due - monthPaid;
  tfoot.innerHTML = rows.length ? `
    <tr>
      <td></td>
      <td></td>
      <td>Итого</td>
      <td class="num">${fmt(due)}</td>
      <td class="num">${fmtSigned(today)}</td>
      <td class="num">${fmt(monthPaid)}</td>
      <td class="num"><span class="diff-value ${diff === 0 ? 'diff-zero' : (diff > 0 ? 'diff-pos' : 'diff-neg')}">${fmt(diff)}</span></td>
      <td></td>
    </tr>
  ` : '';

  tbody.querySelectorAll('[data-cancel-edit]').forEach(btn => {
    btn.addEventListener('click', () => { editingRowId = null; renderAll(); });
  });
  tbody.querySelectorAll('[data-edit]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = form.dataset.edit;
      const name = form.name.value.trim();
      const due = parseAmount(form.due);
      if (!name) return;
      editRow(id, name, due || 0, form.payDate.value.trim());
      editingRowId = null;
      renderAll();
    });
  });
  tbody.querySelectorAll('[data-comment-row]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = rows.find(r => r.id === btn.dataset.commentRow);
      const next = prompt('Комментарий:', row.comment || '');
      openRowMenuId = null;
      if (next === null) { renderAll(); return; }
      setRowComment(row.id, next.trim());
      renderAll();
    });
  });
  tbody.querySelectorAll('[data-view-comment]').forEach(icon => {
    icon.addEventListener('click', () => {
      const row = rows.find(r => r.id === icon.dataset.viewComment);
      if (row) alert(row.comment);
    });
  });
  tbody.querySelectorAll('[data-row-menu-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.rowMenuToggle;
      openRowMenuId = openRowMenuId === id ? null : id;
      renderAll();
    });
  });

  // press-and-drag reordering via the ⋮⋮ handle
  let draggedRow = null;
  tbody.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('dragstart', (e) => {
      draggedRow = handle.closest('tr');
      draggedRow.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    handle.addEventListener('dragend', () => {
      if (draggedRow) draggedRow.classList.remove('dragging');
      tbody.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
      draggedRow = null;
    });
  });
  tbody.querySelectorAll('tr[data-row-id]').forEach(tr => {
    tr.addEventListener('dragover', (e) => {
      if (!draggedRow || tr === draggedRow) return;
      e.preventDefault();
      const rect = tr.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      tr.classList.toggle('drag-over-top', before);
      tr.classList.toggle('drag-over-bottom', !before);
    });
    tr.addEventListener('dragleave', () => {
      tr.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    tr.addEventListener('drop', (e) => {
      if (!draggedRow || tr === draggedRow) return;
      e.preventDefault();
      const draggedId = draggedRow.dataset.rowId;
      const targetId = tr.dataset.rowId;
      const before = tr.classList.contains('drag-over-top');
      tr.classList.remove('drag-over-top', 'drag-over-bottom');
      const currentRows = getRows();
      let targetIndex = currentRows.findIndex(r => r.id === targetId);
      if (!before) targetIndex += 1;
      moveRow(draggedId, targetIndex);
      renderAll();
    });
  });
}

// ---------- KPIs ----------

function renderKpis() {
  const date = todayStr();
  const totalIncome = METHODS.reduce((s, m) => s + methodNewIncome(m, date), 0);
  const totalSpent = METHODS.reduce((s, m) => s + categorySum(m, date), 0);
  const totalLeft = METHODS.reduce((s, m) => s + methodRemainder(m, date), 0);

  document.getElementById('kpiIn').textContent = fmt(totalIncome);
  document.getElementById('kpiOut').textContent = fmt(totalSpent);
  document.getElementById('kpiLeft').textContent = fmt(totalLeft);
}

// ---------- history page: full list of every transaction, newest day first,
// chronological within a day (Было/Поступило in the morning, spending after).
// Soft-deleted records stay, struck through, instead of disappearing. ----------

function timeLabel(ts) {
  return ts ? new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
}
function dateLabel(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
}

function collectAllTransactions() {
  const items = [];
  const balances = getBalances();
  Object.keys(balances).forEach(key => {
    const sep = key.lastIndexOf('_');
    const method = key.slice(0, sep), date = key.slice(sep + 1);
    const entry = balances[key];
    if (entry.was) items.push({ kind: 'income', method, date, label: 'Было', amount: entry.was, ts: entry.wasTs });
    if (entry.income) items.push({ kind: 'income', method, date, label: 'Поступило', amount: entry.income, ts: entry.incomeTs });
    (entry.sources || []).filter(s => !s.deleted).forEach(s => items.push({ kind: 'income', method, date, label: s.label, amount: s.amount, ts: s.ts }));
  });
  getExpenses().filter(e => !e.deleted).forEach(e => items.push({ kind: 'expense', method: e.method, date: e.date, label: e.name, amount: e.amount, ts: e.ts }));
  return items;
}

let historyFilterType = 'all';   // all | income | expense
let historyFilterMethod = 'all'; // all | Наличка | Click | Терминал
let historyFilterDate = '';      // '' | YYYY-MM-DD

function renderHistoryFilters() {
  const bar = document.getElementById('historyFilters');
  const typeBtns = ['all', 'income', 'expense'].map(t => `<button class="filter-chip ${historyFilterType === t ? 'active' : ''}" data-filter-type="${t}">${t === 'all' ? 'Все' : t === 'income' ? 'Доходы' : 'Расходы'}</button>`).join('');
  const methodBtns = ['all', ...METHODS].map(m => `<button class="filter-chip ${historyFilterMethod === m ? 'active' : ''}" data-filter-method="${m}">${m === 'all' ? 'Все' : m}</button>`).join('');
  bar.innerHTML = `
    <div class="filter-group">${typeBtns}</div>
    <div class="filter-group">${methodBtns}</div>
    <input type="date" id="historyDateFilter" min="2020-01-01" max="2099-12-31" value="${historyFilterDate}">
    ${historyFilterDate ? '<button class="btn-icon" id="clearDateFilter" title="Сбросить дату">✕</button>' : ''}
  `;
  bar.querySelectorAll('[data-filter-type]').forEach(b => b.addEventListener('click', () => { historyFilterType = b.dataset.filterType; renderHistoryPage(); }));
  bar.querySelectorAll('[data-filter-method]').forEach(b => b.addEventListener('click', () => { historyFilterMethod = b.dataset.filterMethod; renderHistoryPage(); }));
  bar.querySelector('#historyDateFilter').addEventListener('change', (e) => { historyFilterDate = e.target.value; renderHistoryPage(); });
  const clearBtn = bar.querySelector('#clearDateFilter');
  if (clearBtn) clearBtn.addEventListener('click', () => { historyFilterDate = ''; renderHistoryPage(); });
}

function renderHistoryPage() {
  renderHistoryFilters();
  const container = document.getElementById('historyList');
  let items = collectAllTransactions();
  if (historyFilterType !== 'all') items = items.filter(it => it.kind === historyFilterType);
  if (historyFilterMethod !== 'all') items = items.filter(it => it.method === historyFilterMethod);
  if (historyFilterDate) items = items.filter(it => it.date === historyFilterDate);

  if (!items.length) { container.innerHTML = `<div class="history-empty">Ничего не найдено</div>`; return; }

  const byDate = {};
  items.forEach(it => { (byDate[it.date] = byDate[it.date] || []).push(it); });
  const dates = Object.keys(byDate).sort().reverse();

  container.innerHTML = dates.map(date => {
    const dayItems = byDate[date].slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const cards = dayItems.map(it => `
      <div class="history-card">
        <div class="history-card-top">
          <span class="history-method">${it.kind === 'income' ? 'Доход' : 'Расход'} ${escapeHtml(it.method)}</span>
          <span class="history-name">${escapeHtml(it.label || '—')}</span>
          <span class="history-amount ${it.kind === 'income' ? 'amount-pos' : 'amount-neg'}">${it.kind === 'income' ? '+' : '-'}${fmt(it.amount)}</span>
        </div>
        <div class="history-meta">${timeLabel(it.ts)}</div>
      </div>
    `).join('');
    return `<div class="history-day"><div class="history-day-label">${dateLabel(date)}</div>${cards}</div>`;
  }).join('');
}

// ---------- utils ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---------- events ----------

function setupGlobalEvents() {
  if (!state.isAdmin) return; // admin-only elements are removed from the DOM for everyone else

  const newRowForm = document.getElementById('newRowForm');
  const toggleBtn = document.getElementById('toggleAddRow');
  const cancelBtn = document.getElementById('cancelAddRow');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openRowMenuId) { openRowMenuId = null; renderAll(); }
  });
  document.addEventListener('click', (e) => {
    if (openRowMenuId && !e.target.closest('.row-menu') && !e.target.closest('[data-row-menu-toggle]')) {
      openRowMenuId = null;
      renderAll();
    }
  });

  toggleBtn.addEventListener('click', () => {
    newRowForm.classList.toggle('hidden');
    if (!newRowForm.classList.contains('hidden')) document.getElementById('newRowName').focus();
  });
  document.getElementById('newMonthBtn').addEventListener('click', () => {
    if (!confirm('Перейти к новому месяцу? «Отдали в этом месяце» обнулится для всех статей (история сохранится).')) return;
    startNewMonth();
    renderAll();
  });
  cancelBtn.addEventListener('click', () => {
    newRowForm.reset();
    newRowForm.classList.add('hidden');
  });
  newRowForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('newRowName').value.trim();
    const due = parseAmount(document.getElementById('newRowDue'));
    const payDate = document.getElementById('newRowPayDate').value.trim();
    if (!name) return;
    addRow(name, due || 0, payDate);
    newRowForm.reset();
    newRowForm.classList.add('hidden');
    renderAll();
  });

  // category name autocomplete: delegated so it survives re-renders
  const methodsRow = document.getElementById('methodsRow');
  methodsRow.addEventListener('focusin', (e) => {
    if (e.target.matches('[data-expense-name]')) openAutocompleteFor(e.target);
  });
  methodsRow.addEventListener('input', (e) => {
    if (e.target.matches('[data-expense-name]')) openAutocompleteFor(e.target);
  });
  methodsRow.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-expense-name]') && e.key === 'Escape') closeAllAutocomplete();
  });
  document.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.autocomplete-item');
    if (!item || !autocompleteTargetInput) return;
    e.preventDefault();
    autocompleteTargetInput.value = item.dataset.value;
    closeAllAutocomplete();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-autocomplete]') && !e.target.closest('.autocomplete-menu')) closeAllAutocomplete();
  });

  // live space-grouping for every amount field on the page, delegated so it
  // keeps working after any part of the page re-renders
  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-amount]')) formatAmountInput(e.target);
  });
}

function setDateDisplay() {
  document.getElementById('todayDate').textContent =
    new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function renderDebtSummary() {
  const panel = document.getElementById('debtSummaryPanel');
  const rows = getRows().filter(r => r.isDebt);
  const tbody = document.getElementById('debtSummaryBody');
  const tfoot = document.getElementById('debtSummaryFoot');
  const month = monthOf(todayStr());

  panel.classList.toggle('hidden', rows.length === 0);
  tbody.innerHTML = '';
  if (!rows.length) { tfoot.innerHTML = ''; return; }

  const due = rows.reduce((s, r) => s + r.due, 0);
  const monthPaid = rows.reduce((s, r) => s + paidThisMonthByName(r.name, month), 0);
  const left = due - monthPaid;
  tfoot.innerHTML = `
    <tr>
      <td>Итого</td>
      <td class="num">${fmt(due)}</td>
      <td class="num">${fmt(monthPaid)}</td>
      <td class="num"><span class="diff-value ${left === 0 ? 'diff-zero' : (left > 0 ? 'diff-pos' : 'diff-neg')}">${fmt(left)}</span></td>
    </tr>
  `;
}

function renderAll() {
  balanceEntryCache.clear();
  renderMethods();
  renderExpenseTable();
  renderDebtSummary();
  renderKpis();
  renderRowMenu();
}

// one-time import of the user's real spreadsheet data, requested explicitly —
// only runs if there are no rows yet, never overwrites existing data
function seedIfEmpty() {
  if (getRows().length) return;
  const monthStart = todayStr().slice(0, 8) + '01';
  const r = (payDate, name, due, paid, comment) => {
    addRow(name, due, payDate, comment || '');
    if (paid > 0) addExpense('Наличка', name, paid);
  };
  const bumpDates = () => {
    const list = getExpenses();
    list.forEach(e => { if (e.date === todayStr()) e.date = monthStart; });
    save(STORAGE.expenses, list);
  };
  r('любая', 'Мукаддас июнь (долг)', 3850000, 500000, '24 май-23 июнь');
  r('любая', 'Камолиддин май (долг)', 1500000, 1500000, '25 апрель- 24 май');
  r('любая', 'Камолиддин июнь (долг)', 4500000, 1000000, '25 май - 24 июнь');
  r('любая', 'Хонзода июнь (долг)', 4000000, 4000000, '');
  r('любая', 'Муслима марк июнь (долг)', 2500000, 2000000, '15 май-14 июнь');
  r('любая', 'Аренда май (долг)', 6000000, 6000000, 'Май');
  r('любая', 'Аренда Асф июнь (долг)', 2100000, 2100000, '');
  r('любая', 'Аренда стом июнь (долг)', 1200000, 1200000, '');
  r('любая', 'Аренда июнь (долг)', 18000000, 0, '');
  r('любая', 'Зиеда (долг)', 1700000, 1700000, '');
  r('любая', 'Дониёр май (долг)', 7750000, 6350000, '');
  r('любая', 'Садулло ака май (долг)', 4652000, 4652000, '');
  r('любая', 'Умар (долг)', 1200000, 1200000, '');
  r('любая', 'Налоги Бахти 670$ (долг)', 5550000, 2430000, '');
  r('любая', 'Долг (10 млн)', 10195000, 10195000, '');
  r('любая', 'Баннеры (долг)', 10000000, 0, '');
  r('5 число', 'Кристина', 6250000, 5250000, '');
  r('5 число', 'Санжар', 4500000, 4500000, '(6 по 4)');
  r('6 число', 'Азизбек', 4000000, 4000000, '');
  r('10 число', 'Шахзода', 5773000, 2800000, '');
  r('10 число', 'Огилой', 3410000, 2000000, '-790000');
  r('10 число', 'Огилой утро', 466000, 466000, 'за утро');
  r('10 число', 'Рухшона', 1500000, 1500000, '');
  r('10 число', 'Уборщица', 1500000, 500000, '');
  r('10 число', 'Умар', 1200000, 0, '');
  r('11 число', 'Зиёда', 4000000, 1000000, '(с 11 по 10) (2300-2)');
  r('15 число', 'Муслима админ', 3500000, 0, '');
  r('16 число', 'Тариф', 155000, 0, '');
  r('20 число', 'Мардона', 4700000, 0, '');
  r('20 число', 'Аренда июль', 18000000, 0, '');
  r('23 число', 'Иброхим', 4200000, 0, '');
  r('25 число', 'Камолиддин', 4500000, 0, '');
  r('26 число', 'Мукаддас', 4200000, 0, '-2 дня');
  r('26 число', 'Муслима оператор', 4500000, 0, '');
  r('любая', 'Дониёр июнь', 10000000, 0, '');
  r('любая', 'Садулло ака июнь', 12000000, 4158000, '');
  r('любая', 'HR расходы', 600000, 636000, '');
  r('4 число', 'Wi-fi', 190000, 190000, '');
  r('любая', 'Таргет', 8000000, 4210000, '');
  r('3 число', 'CRM', 0, 0, '');
  r('любая', 'Налоги', 4000000, 0, '');
  r('любая', 'Возврат ученикам', 1000000, 0, '');
  r('любая', 'Книги', 0, 0, '');
  r('любая', 'Вода и станаканы', 160000, 160000, '');
  r('любая', 'Электричество', 0, 0, '');
  r('любая', 'Прочие', 800000, 302000, '');
  bumpDates(); // backdate to the 1st of the month so today's cards stay empty
}

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

// ---------- auth ----------

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

function showAuthGate() {
  document.getElementById('authGate').classList.remove('hidden');
  const app = document.getElementById('app');
  if (app) app.classList.add('hidden');
  renderAuthForm();
}

function renderCurrentPage() {
  if (document.getElementById('methodsRow')) renderAll();
  if (document.getElementById('historyList')) renderHistoryPage();
}

function onSnapshotError(err) {
  console.error('Snapshot listener failed', err);
  alert('Не удалось загрузить данные: проверьте соединение.');
}
// Resolves only once all three docs have delivered their first snapshot, so
// callers can hold off wiring up any mutating UI until CACHE actually
// reflects the real shared data instead of its empty initial state.
function attachSnapshotListeners() {
  return new Promise((resolve) => {
    const markLoaded = (key) => {
      snapshotsLoaded[key] = true;
      if (allDataLoaded()) resolve();
    };
    db.collection('cashflow').doc('rows').onSnapshot((doc) => {
      CACHE.rows = (doc.data() && doc.data().data) || [];
      markLoaded('rows');
      renderCurrentPage();
    }, onSnapshotError);
    db.collection('cashflow').doc('expenses').onSnapshot((doc) => {
      CACHE.expenses = (doc.data() && doc.data().data) || [];
      markLoaded('expenses');
      renderCurrentPage();
    }, onSnapshotError);
    db.collection('cashflow').doc('balances').onSnapshot((doc) => {
      CACHE.balances = (doc.data() && doc.data().data) || {};
      markLoaded('balances');
      renderCurrentPage();
    }, onSnapshotError);
  });
}

// One-time migration: the admin's real, currently-accumulated data lives in
// this browser's localStorage. On the admin's first login after this
// shipped, seed the shared Firestore docs from it — but only if nobody has
// seeded them yet, so this never runs again (and never overwrites live data).
function migrateLocalDataIfNeeded() {
  return db.collection('cashflow').doc('rows').get().then((rowsDoc) => {
    if (rowsDoc.exists) return;
    const batch = db.batch();
    batch.set(db.collection('cashflow').doc('rows'), { data: load(STORAGE.rows, []) });
    batch.set(db.collection('cashflow').doc('expenses'), { data: load(STORAGE.expenses, []) });
    batch.set(db.collection('cashflow').doc('balances'), { data: load(STORAGE.balances, {}) });
    return batch.commit();
  });
}

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
    if (document.getElementById('methodsRow')) { setDateDisplay(); setupGlobalEvents(); }
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

if (document.getElementById('themeToggle')) initTheme();
