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

const STORAGE = {
  rows: 'cf_rows',           // {id, name, due}
  expenses: 'cf_expenses',   // {id, method, name, amount, checked, date, ts, comment, deleted, deletedAt}
  balances: 'cf_balances',   // { "<method>_<date>": {was, income, sources:[{id,label,amount,ts,comment,deleted,deletedAt}]} }
};

const METHODS = ['Наличка', 'Click', 'Терминал'];

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
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getRows() { return load(STORAGE.rows, []); }
function getExpenses() { return load(STORAGE.expenses, []); }
function getBalances() { return load(STORAGE.balances, {}); }

function getBalanceEntry(method, date) {
  const entry = getBalances()[`${method}_${date}`];
  return entry ? { was: entry.was || 0, income: entry.income || 0, sources: entry.sources || [] } : { was: 0, income: 0, sources: [] };
}
function saveBalanceEntry(method, date, entry) {
  const balances = getBalances();
  balances[`${method}_${date}`] = entry;
  save(STORAGE.balances, balances);
}
function setWas(method, date, was) {
  const entry = getBalanceEntry(method, date);
  entry.was = was;
  saveBalanceEntry(method, date, entry);
}
function setIncome(method, date, income) {
  const entry = getBalanceEntry(method, date);
  entry.income = income;
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

function addRow(name, due) {
  const rows = getRows();
  rows.push({ id: uid(), name, due });
  save(STORAGE.rows, rows);
}
function editRow(id, name, due) {
  const rows = getRows();
  const row = rows.find(r => r.id === id);
  if (row) { row.name = name; row.due = due; save(STORAGE.rows, rows); }
}
function deleteRow(id) {
  save(STORAGE.rows, getRows().filter(r => r.id !== id));
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

// ---------- category name autocomplete popup ----------

function openAutocompleteFor(input) {
  const wrap = input.closest('[data-autocomplete]');
  const menu = wrap.querySelector('[data-autocomplete-menu]');
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
  document.querySelectorAll('.autocomplete-menu').forEach(m => m.classList.add('hidden'));
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
            <button type="button" class="cat-index" data-check-expense="${e.id}" title="Отметить оплату">${i + 1}</button>
            <span class="cat-name">${escapeHtml(e.name || '—')}</span>
            <span class="cat-amount">${fmt(e.amount)}</span>
            <button class="cat-del" data-del-expense="${e.id}" title="Удалить">✕</button>
          </div>
        `).join('')
      : `<div class="empty-hint">Пока нет записей</div>`;

    const sourcesHtml = bal.sources.filter(s => !s.deleted).map(s => `
      <div class="balance-row source-row">
        <span class="balance-label">${escapeHtml(s.label)}</span>
        <span class="source-amount">${fmt(s.amount)}</span>
        <button class="source-del" data-del-source="${s.id}" data-method="${method}" title="Удалить">✕</button>
      </div>
    `).join('');

    return `
      <div class="method-block" data-method="${method}">
        <div class="method-col stripe-green">
          <div class="col-head">${method}</div>
          <div class="balance-rows">
            <div class="balance-row">
              <span class="balance-label">Было</span>
              <input type="text" inputmode="numeric" class="balance-input" data-balance-was="${method}" data-amount value="${bal.was ? fmt(bal.was) : ''}" placeholder="0">
            </div>
            <div class="balance-row">
              <span class="balance-label">Поступило</span>
              <input type="text" inputmode="numeric" class="balance-input" data-balance-income="${method}" data-amount value="${bal.income ? fmt(bal.income) : ''}" placeholder="0">
            </div>
            <form class="source-add-row ${sourceFormOpen ? '' : 'hidden'}" data-source-form="${method}">
              <input type="text" placeholder="Название источника" data-source-label required>
              <input type="text" inputmode="numeric" placeholder="Сумма" data-source-amount data-amount required>
              <button type="submit" class="btn btn-primary">Добавить</button>
            </form>
            ${sourcesHtml}
          </div>
          <div class="balance-row sum">
            <span>Сумма</span>
            <span>${fmt(total)}</span>
            <button type="button" class="btn-kebab" data-toggle-source="${method}" title="Добавить источник">⋯</button>
          </div>
        </div>
        <div class="method-col stripe-red">
          <div class="col-head">${method}</div>
          <div class="cat-list">${rowsHtml}</div>
          <form class="cat-add-row" data-expense-form="${method}">
            <div class="autocomplete" data-autocomplete>
              <input type="text" placeholder="Категория" data-expense-name autocomplete="off">
              <div class="autocomplete-menu hidden" data-autocomplete-menu></div>
            </div>
            <input type="text" inputmode="numeric" placeholder="Сумма" data-expense-amount data-amount required>
            <button type="submit">+</button>
          </form>
          <div class="cat-sum-row"><span></span><span>Сумма</span><span>${fmt(catSum)}</span></div>
        </div>
        <div class="method-col stripe-blue">
          <div class="col-head">${method}</div>
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
    input.addEventListener('change', () => {
      setWas(input.dataset.balanceWas, date, parseAmount(input));
      renderAll();
    });
  });
  container.querySelectorAll('[data-balance-income]').forEach(input => {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => {
      setIncome(input.dataset.balanceIncome, date, parseAmount(input));
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

  if (editingRowId === r.id) {
    return `
      <tr class="editing">
        <td colspan="7">
          <form class="edit-form" data-edit="${r.id}">
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
      <td class="drag-col"><span class="drag-handle" draggable="true" title="Перетащить">⋮⋮</span></td>
      <td>${escapeHtml(r.name)}</td>
      <td class="num due-cell">${fmt(r.due)}</td>
      <td class="num today-cell">${fmtSigned(today)}</td>
      <td class="num month-cell">${fmt(monthPaid)}</td>
      <td class="num"><span class="diff-value ${diffClass}">${fmt(diff)}</span></td>
      <td class="actions-cell">
        <button class="btn-icon" data-edit-row="${r.id}" title="Редактировать">✎</button>
        <button class="btn-icon" data-del-row="${r.id}" title="Удалить">✕</button>
      </td>
    </tr>
  `;
}

function renderExpenseTable() {
  const rows = getRows();
  const tbody = document.getElementById('expenseTableBody');
  const tfoot = document.getElementById('expenseTableFoot');
  const date = todayStr();
  const month = monthOf(date);

  tbody.innerHTML = rows.length
    ? rows.map(renderRow).join('')
    : `<tr><td colspan="7" class="empty-hint">Пока нет статей. Нажмите «+ Добавить», чтобы добавить первую.</td></tr>`;

  const due = rows.reduce((s, r) => s + r.due, 0);
  const today = rows.reduce((s, r) => s + paidTodayByName(r.name, date), 0);
  const monthPaid = rows.reduce((s, r) => s + paidThisMonthByName(r.name, month), 0);
  const diff = due - monthPaid;
  tfoot.innerHTML = rows.length ? `
    <tr>
      <td></td>
      <td>Итого</td>
      <td class="num">${fmt(due)}</td>
      <td class="num">${fmtSigned(today)}</td>
      <td class="num">${fmt(monthPaid)}</td>
      <td class="num"><span class="diff-value ${diff === 0 ? 'diff-zero' : (diff > 0 ? 'diff-pos' : 'diff-neg')}">${fmt(diff)}</span></td>
      <td></td>
    </tr>
  ` : '';

  tbody.querySelectorAll('[data-edit-row]').forEach(btn => {
    btn.addEventListener('click', () => { editingRowId = btn.dataset.editRow; renderAll(); });
  });
  tbody.querySelectorAll('[data-del-row]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = rows.find(r => r.id === btn.dataset.delRow);
      if (!row || !confirm(`Удалить «${row.name}»?`)) return;
      deleteRow(btn.dataset.delRow);
      renderAll();
    });
  });
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
      editRow(id, name, due || 0);
      editingRowId = null;
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

// ---------- history: answers "where did this Отдали number come from, by date" ----------
// Расходы tab = expense entries (Категории). Доходы tab = extra income sources.
// Both keep soft-deleted records so a removed transaction still shows, struck through.

let historyTab = 'expense';

function timeLabel(ts) {
  return ts ? new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
}
function dateLabel(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
}

function collectIncomeTransactions() {
  const balances = getBalances();
  const out = [];
  Object.keys(balances).forEach(key => {
    const sep = key.lastIndexOf('_');
    const method = key.slice(0, sep);
    const date = key.slice(sep + 1);
    (balances[key].sources || []).forEach(s => out.push({ ...s, method, date, name: s.label }));
  });
  return out;
}

function renderHistory() {
  const body = document.getElementById('historyBody');
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.historyTab === historyTab));

  const items = historyTab === 'expense' ? getExpenses() : collectIncomeTransactions();

  if (!items.length) {
    body.innerHTML = `<div class="history-empty">${historyTab === 'expense' ? 'Пока нет расходов' : 'Пока нет дополнительных поступлений'}</div>`;
    return;
  }

  const byDate = {};
  items.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  const dates = Object.keys(byDate).sort().reverse();

  body.innerHTML = dates.map(date => {
    const dayItems = byDate[date].slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const dayTotal = dayItems.filter(e => !e.deleted).reduce((s, e) => s + e.amount, 0);
    const cards = dayItems.map(e => `
      <div class="history-card ${e.deleted ? 'deleted' : ''}">
        <div class="history-card-top">
          <span class="history-method">${escapeHtml(e.method)}</span>
          <span class="history-name">${escapeHtml(e.name || '—')}</span>
          <span class="history-amount">${fmt(e.amount)}</span>
        </div>
        <div class="history-meta">
          ${timeLabel(e.ts)}${e.checked ? ' · оплачено' : ''}${e.deleted ? `<span class="history-deleted-tag">Удалено ${timeLabel(e.deletedAt)}</span>` : ''}
        </div>
        <input
          type="text"
          class="history-comment"
          placeholder="Комментарий..."
          value="${escapeHtml(e.comment || '')}"
          data-comment-type="${historyTab}"
          data-comment-id="${e.id}"
          data-comment-method="${escapeHtml(e.method)}"
          data-comment-date="${e.date}"
          ${e.deleted ? 'disabled' : ''}
        >
      </div>
    `).join('');
    return `
      <div class="history-day">
        <div class="history-day-label"><span>${dateLabel(date)}</span><span>${fmt(dayTotal)}</span></div>
        ${cards}
      </div>
    `;
  }).join('');

  body.querySelectorAll('[data-comment-id]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.dataset.commentType === 'expense') {
        setExpenseComment(input.dataset.commentId, input.value.trim());
      } else {
        setSourceComment(input.dataset.commentMethod, input.dataset.commentDate, input.dataset.commentId, input.value.trim());
      }
    });
  });
}

// ---------- utils ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---------- events ----------

function setupGlobalEvents() {
  const newRowForm = document.getElementById('newRowForm');
  const toggleBtn = document.getElementById('toggleAddRow');
  const cancelBtn = document.getElementById('cancelAddRow');

  const historyOverlay = document.getElementById('historyOverlay');
  document.getElementById('historyBtn').addEventListener('click', () => {
    renderHistory();
    historyOverlay.classList.remove('hidden');
  });
  document.getElementById('closeHistory').addEventListener('click', () => {
    historyOverlay.classList.add('hidden');
  });
  historyOverlay.addEventListener('click', (e) => {
    if (e.target === historyOverlay) historyOverlay.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') historyOverlay.classList.add('hidden');
  });
  document.querySelectorAll('[data-history-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      historyTab = tab.dataset.historyTab;
      renderHistory();
    });
  });

  toggleBtn.addEventListener('click', () => {
    newRowForm.classList.toggle('hidden');
    if (!newRowForm.classList.contains('hidden')) document.getElementById('newRowName').focus();
  });
  cancelBtn.addEventListener('click', () => {
    newRowForm.reset();
    newRowForm.classList.add('hidden');
  });
  newRowForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('newRowName').value.trim();
    const due = parseAmount(document.getElementById('newRowDue'));
    if (!name) return;
    addRow(name, due || 0);
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
  methodsRow.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.autocomplete-item');
    if (!item) return;
    e.preventDefault();
    const wrap = item.closest('[data-autocomplete]');
    wrap.querySelector('[data-expense-name]').value = item.dataset.value;
    closeAllAutocomplete();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-autocomplete]')) closeAllAutocomplete();
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

function renderAll() {
  renderMethods();
  renderExpenseTable();
  renderKpis();
}

setDateDisplay();
setupGlobalEvents();
renderAll();
