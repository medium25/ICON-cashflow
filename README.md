# Cashflow Tracker

Учёт долгов и кассы (Наличка / Click / Терминал) — статичный сайт без бэкенда, все данные хранятся в `localStorage` браузера.

Файлы:
- `index.html` — разметка
- `style.css` — стили
- `app.js` — вся логика (расчёты, история, drag-n-drop)

Никакой сборки не требуется — это обычные HTML/CSS/JS файлы.

## Запуск локально

Открыть `index.html` напрямую через `file://` не всегда работает как надо (некоторые браузерные API это не любят), поэтому проще поднять локальный сервер:

```bash
cd "Cashflow Tracker"
python3 -m http.server 8000
```

Затем открыть в браузере: `http://localhost:8000`

## Как сделать веб-версию (выложить в интернет)

Раз это просто статические файлы, публикация — это буквально "положить эти 3 файла на любой статический хостинг". Три варианта, от простого к продвинутому:

### Вариант 1: GitHub Pages (бесплатно, через сам GitHub)

1. Создать репозиторий на GitHub (например `cashflow-tracker`).
2. Залить файлы:
   ```bash
   cd "Cashflow Tracker"
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<ваш-username>/cashflow-tracker.git
   git push -u origin main
   ```
3. В репозитории на GitHub: **Settings → Pages** → в разделе "Build and deployment" выбрать **Source: Deploy from a branch**, ветку `main`, папку `/ (root)` → **Save**.
4. Через 1–2 минуты сайт появится по адресу `https://<ваш-username>.github.io/cashflow-tracker/`.

Дальше просто: любой `git push` в `main` обновляет сайт автоматически.

### Вариант 2: Netlify (просто перетащить папку)

1. Зайти на [app.netlify.com/drop](https://app.netlify.com/drop).
2. Перетащить папку `Cashflow Tracker` в браузер.
3. Сайт сразу получит ссылку вида `https://random-name.netlify.app`.

Можно позже привязать к своему GitHub-репозиторию для автообновлений при пуше.

### Вариант 3: Vercel

1. `npm i -g vercel` (нужен Node.js) или через сайт [vercel.com](https://vercel.com) → Import Project.
2. Указать папку проекта, framework preset — **Other** (это не React/Next, просто статика).
3. Deploy.

## Важно про данные

Все долги, платежи и история хранятся в `localStorage` **того браузера**, в котором открыт сайт. Это значит:
- На телефоне и на компьютере будут **разные** данные (не синхронизируются).
- Очистка данных браузера / режим инкогнито = потеря данных.
- Экспорта/бэкапа данных пока нет — если это нужно, стоит добавить отдельно (например, кнопку "Скачать резервную копию" в JSON).
