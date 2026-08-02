const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const SqliteSessionStore = require('better-sqlite3-session-store')(session);
const helmet = require('helmet');
const db = require('./db');
const { UPLOADS_DIR } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// приложение обычно стоит за reverse proxy (nginx-ingress и т.п.) с TLS-терминацией -
// без этого Express не увидит, что запрос на самом деле пришёл по https, и secure-cookie
// ниже никогда бы не выставлялась.
app.set('trust proxy', 1);

// Security-заголовки. CSP отключена намеренно: все страницы приложения используют инлайновые
// <script> без nonce (переписывать всё на внешние файлы - отдельная большая задача), а с
// дефолтным CSP от helmet эти скрипты были бы заблокированы браузером и приложение просто
// перестало бы работать. Остальные заголовки (X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy и т.п.) не конфликтуют с инлайновыми скриптами и подключены как есть.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '15mb' }));
app.use(
  session({
    store: new SqliteSessionStore({
      client: db, // та же база SQLite, что и всё приложение - отдельный файл не нужен
      expired: { clear: true, intervalMs: 1000 * 60 * 60 * 12 }, // чистим протухшие сессии дважды в сутки
    }),
    secret: process.env.SESSION_SECRET || 'please-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 дней
      secure: 'auto', // https - если соединение реально защищено (см. trust proxy выше)
      sameSite: 'lax',
      httpOnly: true,
    },
  })
);

app.use('/uploads', express.static(UPLOADS_DIR));

// ---------- роуты, разбитые по группам (раньше всё жило в одном файле на 1400+ строк) ----------
app.use(require('./routes/auth'));
app.use(require('./routes/admin'));
app.use(require('./routes/assignments'));
app.use(require('./routes/shop'));
app.use(require('./routes/books'));

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- health check (для liveness/readiness проб k3s/Docker) ----------
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get(); // заодно проверяем, что база реально отвечает
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

// ---------- обработка ошибок загрузки файлов (multer) и прочих сбоев ----------
// без этого multer/Express при слишком большом файле или сетевом сбое отдавали бы HTML-страницу
// с ошибкой вместо понятного JSON, и фронтенд не мог показать пользователю причину.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file_too_large' });
    }
    return res.status(400).json({ error: 'upload_error', detail: err.message });
  }
  if (err) {
    console.error('Необработанная ошибка:', err);
    return res.status(500).json({ error: 'server_error' });
  }
  next();
});

// ---------- периодический бэкап SQLite ----------
// используем встроенный online-backup SQLite (через better-sqlite3) - безопасно копирует
// базу, даже если в неё в этот момент идёт запись, в отличие от обычного копирования файла.
const BACKUP_DIR = path.join(path.dirname(db.name), 'backups');
const BACKUP_KEEP_COUNT = 7; // хранить только последние 7 - иначе бэкапы будут копиться бесконечно
async function backupDatabase() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `backup-${stamp}.sqlite`);
    await db.backup(dest);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('backup-')).sort();
    while (files.length > BACKUP_KEEP_COUNT) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    console.log(`Бэкап базы данных создан: ${dest}`);
  } catch (e) {
    console.error('Ошибка создания бэкапа базы данных:', e.message);
  }
}
backupDatabase(); // один раз сразу при старте
// .unref() - чтобы этот таймер сам по себе не держал процесс живым (иначе, например,
// в тестах или при штатном завершении процесс мог бы никогда не выйти)
setInterval(backupDatabase, 1000 * 60 * 60 * 24).unref(); // и затем раз в сутки

// ---------- обработчики критических ошибок процесса ----------
// без них неожиданная ошибка вне Express-хендлера (например, в setInterval-колбэке) могла бы
// уронить весь процесс без внятного сообщения в логах, или зависнуть в неопределённом состоянии.
process.on('unhandledRejection', (reason) => {
  console.error('Необработанное отклонение промиса (unhandledRejection):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Неперехваченное исключение (uncaughtException) - завершаем процесс:', err);
  // после uncaughtException состояние процесса не гарантированно корректно - безопаснее
  // завершиться и дать оркестратору (Docker/k3s) перезапустить сервис с чистого листа,
  // чем продолжать работать в потенциально повреждённом состоянии.
  process.exit(1);
});

const server = app.listen(PORT, () => {
  console.log(`Homework app listening on port ${PORT}`);
});

module.exports = { app, server };


