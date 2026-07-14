const STORAGE_KEY = 'cashflow_rows_v1';

let rows = loadRows();

const tableBody = document.getElementById('tableBody');
const searchInput = document.getElementById('searchInput');

document.getElementById('newRowBtn').addEventListener('click', addRow);
document.getElementById('newDayBtn').addEventListener('click', startNewDay);
document.getElementById('newMonthBtn').addEventListener('click', startNewMonth);
searchInput.addEventListener('input', render);

function loadRows() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveRows() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}`;
}

function paidToday(row) {
  const key = todayKey();
  return (row.payments || [])
    .filter(p => p.dayKey === key)
    .reduce((sum, p) => sum + p.amount, 0);
}

function paidThisMonth(row) {
  const key = currentMonthKey();
  return (row.payments || [])
    .filter(p => p.monthKey === key)
    .reduce((sum, p) => sum + p.amount, 0);
}

function formatMoney(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  return `${sign}so'm ${abs.toLocaleString('ru-RU')}`;
}

function addRow() {
  rows.push({
    id: crypto.randomUUID(),
    name: '',
    owed: 0,
    payments: []
  });
  saveRows();
  render();
  const inputs = tableBody.querySelectorAll('.name-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function deleteRow(id) {
  const row = rows.find(r => r.id === id);
  if (!row) return;
  if (!confirm(`Удалить строку "${row.name || 'без названия'}"?`)) return;
  rows = rows.filter(r => r.id !== id);
  saveRows();
  render();
}

function addPayment(id, amount) {
  if (!amount || isNaN(amount)) return;
  const row = rows.find(r => r.id === id);
  if (!row) return;
  row.payments = row.payments || [];
  row.payments.push({
    amount,
    dayKey: todayKey(),
    monthKey: currentMonthKey(),
    ts: Date.now()
  });
  saveRows();
  render();
  showToast(`Платёж ${formatMoney(amount)} добавлен`);
}

function undoLastPayment(id) {
  const row = rows.find(r => r.id === id);
  if (!row || !row.payments || row.payments.length === 0) return;
  const key = todayKey();
  const idx = [...row.payments].reverse().findIndex(p => p.dayKey === key);
  if (idx === -1) {
    showToast('Нет сегодняшних платежей для отмены');
    return;
  }
  const realIdx = row.payments.length - 1 - idx;
  row.payments.splice(realIdx, 1);
  saveRows();
  render();
  showToast('Последний платёж отменён');
}

function updateName(id, name) {
  const row = rows.find(r => r.id === id);
  if (!row) return;
  row.name = name;
  saveRows();
}

function updateOwed(id, value) {
  const row = rows.find(r => r.id === id);
  if (!row) return;
  const n = parseFloat(value.replace(/[^\d.-]/g, ''));
  row.owed = isNaN(n) ? 0 : n;
  saveRows();
  render();
}

function startNewDay() {
  showToast('Новый день начат — сегодняшние суммы обнулятся автоматически по дате');
  render();
}

function startNewMonth() {
  if (!confirm('Начать новый месяц? "Отдали в этом месяце" обнулится, "Должны" останется как есть (можно скорректировать вручную с учётом текущей разницы).')) return;
  rows.forEach(row => {
    const diff = row.owed - paidThisMonth(row);
    row.owed = diff;
    row.payments = [];
  });
  saveRows();
  render();
  showToast('Новый месяц начат');
}

let toastTimer;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = rows.filter(r => r.name.toLowerCase().includes(query));

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" class="empty-state">Нет записей. Нажмите "+ Новая строка", чтобы добавить.</td></tr>`;
  } else {
    tableBody.innerHTML = filtered.map(rowTemplate).join('');
  }

  attachRowEvents();
  renderTotals();
}

function rowTemplate(row) {
  const today = paidToday(row);
  const month = paidThisMonth(row);
  const diff = row.owed - month;

  let diffClass = 'diff-pos';
  if (diff === 0) diffClass = 'diff-zero';
  else if (diff < 0) diffClass = 'diff-neg';

  return `
    <tr data-id="${row.id}">
      <td class="col-name">
        <input type="text" class="name-input" placeholder="Название..." value="${escapeHtml(row.name)}" data-action="name" />
      </td>
      <td>
        <input type="text" class="owed-input" value="${formatMoney(row.owed)}" data-action="owed" />
      </td>
      <td>
        <div class="today-cell">
          <span class="today-value">${today !== 0 ? formatMoney(today) : '—'}</span>
          <input type="number" class="today-input" placeholder="0" data-action="today-input" />
          <button class="add-payment-btn" data-action="add-payment" title="Добавить платёж">+</button>
        </div>
      </td>
      <td class="month-value">${formatMoney(month)}</td>
      <td><span class="diff-value ${diffClass}">${formatMoney(diff)}</span></td>
      <td>
        <div class="row-actions">
          <button class="icon-btn undo" data-action="undo" title="Отменить последний платёж сегодня">↺</button>
          <button class="icon-btn" data-action="delete" title="Удалить строку">✕</button>
        </div>
      </td>
    </tr>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function attachRowEvents() {
  tableBody.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;

    const nameInput = tr.querySelector('[data-action="name"]');
    nameInput.addEventListener('input', e => updateName(id, e.target.value));

    const owedInput = tr.querySelector('[data-action="owed"]');
    owedInput.addEventListener('focus', e => { e.target.value = e.target.value.replace(/[^\d.-]/g, ''); });
    owedInput.addEventListener('change', e => updateOwed(id, e.target.value));
    owedInput.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

    const todayInput = tr.querySelector('[data-action="today-input"]');
    const addBtn = tr.querySelector('[data-action="add-payment"]');
    const submit = () => {
      const amount = parseFloat(todayInput.value);
      if (!isNaN(amount) && amount !== 0) {
        addPayment(id, amount);
      }
    };
    addBtn.addEventListener('click', submit);
    todayInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    tr.querySelector('[data-action="undo"]').addEventListener('click', () => undoLastPayment(id));
    tr.querySelector('[data-action="delete"]').addEventListener('click', () => deleteRow(id));
  });
}

function renderTotals() {
  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);
  const totalToday = rows.reduce((s, r) => s + paidToday(r), 0);
  const totalMonth = rows.reduce((s, r) => s + paidThisMonth(r), 0);
  const totalDiff = totalOwed - totalMonth;

  document.getElementById('totalOwed').textContent = formatMoney(totalOwed);
  document.getElementById('totalToday').textContent = formatMoney(totalToday);
  document.getElementById('totalMonth').textContent = formatMoney(totalMonth);
  document.getElementById('totalDiff').textContent = formatMoney(totalDiff);
}

render();
