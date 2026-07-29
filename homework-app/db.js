const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','parent','child')),
  display_name TEXT NOT NULL,
  avatar_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Глобальные настройки приложения (favicon и т.п.), простая таблица ключ-значение
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Кто из родителей видит какого ребёнка.
CREATE TABLE IF NOT EXISTS parent_child (
  parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL DEFAULT 'admin' CHECK(granted_by IN ('creator','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_id, child_id)
);

-- Задание существует независимо от того, кому оно назначено ("библиотека заданий").
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  reward TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Назначение задания конкретному ребёнку: можно скрыть (без потери прогресса)
-- и отметить, что награда выдана.
CREATE TABLE IF NOT EXISTS assignment_children (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden INTEGER NOT NULL DEFAULT 0,
  reward_given INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assignment_id, child_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL -- JSON, содержит правильные ответы, доступен только серверу/родителю
);

-- Каждая попытка ребёнка хранится отдельной строкой (до 3 попыток на задание).
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  answer TEXT NOT NULL,
  is_correct INTEGER, -- 0/1, или NULL если ждёт ручной проверки родителем
  manually_graded INTEGER NOT NULL DEFAULT 0,
  flagged_for_review INTEGER NOT NULL DEFAULT 0, -- ребёнок сам попросил родителя перепроверить
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_task_child ON submissions(task_id, child_id);

-- Монеты: журнал начислений/списаний (баланс = SUM(amount)), а не отдельное поле у users -
-- так проще не потерять историю и не словить рассинхрон при повторных операциях.
CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, -- положительное - начисление, отрицательное - списание (покупка)
  reason TEXT NOT NULL, -- 'task_correct' | 'purchase' | 'buy_attempts' | 'admin_adjust'
  related_type TEXT, -- 'task' | 'shop_purchase'
  related_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Серебряные монеты - отдельная валюта, только на еду для маскота. Та же журнальная схема.
CREATE TABLE IF NOT EXISTS silver_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL, -- 'task_correct' | 'feed_mascot' | 'admin_adjust'
  related_type TEXT,
  related_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Голод маскота: одна строка на ребёнка, значение "протухает" со временем (считается на лету
-- при чтении, а не фоновой задачей) и обновляется при кормлении.
-- decay_hours - за сколько часов голод падает со 100% до 0% без кормления; настраивается родителем.
CREATE TABLE IF NOT EXISTS mascot_hunger (
  child_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hunger REAL NOT NULL DEFAULT 100,
  decay_hours REAL NOT NULL DEFAULT 4,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Докупленные дополнительные попытки на конкретное задание (по 3 за раз, можно несколько раз).
CREATE TABLE IF NOT EXISTS attempt_purchases (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extra_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, child_id)
);

-- Магазин наград: видимость как у книг - от админа глобально, от родителя только его детям.
-- currency: 'gold' - обычные награды (нужна выдача родителем), 'silver' - еда для маскота
-- (списывается и применяется сразу, без участия родителя).
CREATE TABLE IF NOT EXISTS shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  cost INTEGER NOT NULL,
  icon TEXT, -- эмодзи или путь к загруженной картинке
  currency TEXT NOT NULL DEFAULT 'gold' CHECK(currency IN ('gold','silver')),
  restore_amount INTEGER, -- только для currency='silver' - сколько % голода восстанавливает
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shop_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES shop_items(id) ON DELETE SET NULL,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_name_snapshot TEXT NOT NULL, -- на случай если товар потом удалят/переименуют
  cost_at_purchase INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'gold',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fulfilled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at TEXT
);

-- Черновик (рисование) ребёнка по конкретному заданию - сохраняется как список "мазков"
CREATE TABLE IF NOT EXISTS drafts (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strokes TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, child_id)
);

-- Книжная полка (epub)
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  file_path TEXT NOT NULL,
  cover_path TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reading_progress (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location TEXT,
  percentage REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (book_id, child_id)
);

CREATE TABLE IF NOT EXISTS book_favorites (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (book_id, child_id)
);

-- Заметки ребёнка по книге: выделенная цитата + свой комментарий + цвет выделения
CREATE TABLE IF NOT EXISTS book_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cfi_range TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  comment TEXT,
  color TEXT NOT NULL DEFAULT '#ffe066',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- миграция со старой схемы (submissions с UNIQUE(task_id,child_id)) ----------
try {
  const cols = db.prepare("PRAGMA table_info(submissions)").all();
  const hasAttempt = cols.some((c) => c.name === 'attempt_number');
  if (!hasAttempt) {
    console.log('Миграция: обновляю таблицу submissions под множественные попытки...');
    db.exec(`
      ALTER TABLE submissions RENAME TO submissions_old;
      CREATE TABLE submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        answer TEXT NOT NULL,
        is_correct INTEGER,
        manually_graded INTEGER NOT NULL DEFAULT 0,
        submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO submissions (task_id, child_id, attempt_number, answer, is_correct, submitted_at)
        SELECT task_id, child_id, 1, answer, is_correct, submitted_at FROM submissions_old;
      DROP TABLE submissions_old;
      CREATE INDEX IF NOT EXISTS idx_submissions_task_child ON submissions(task_id, child_id);
    `);
  }
} catch (e) {
  console.error('Ошибка миграции submissions (можно игнорировать на первом запуске):', e.message);
}

try {
  const acCols = db.prepare("PRAGMA table_info(assignment_children)").all();
  if (acCols.length && !acCols.some((c) => c.name === 'hidden')) {
    db.exec(`ALTER TABLE assignment_children ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`ALTER TABLE assignment_children ADD COLUMN reward_given INTEGER NOT NULL DEFAULT 0;`);
  }
  const aCols = db.prepare("PRAGMA table_info(assignments)").all();
  if (aCols.length && !aCols.some((c) => c.name === 'reward')) {
    db.exec(`ALTER TABLE assignments ADD COLUMN reward TEXT;`);
  }
  const uCols = db.prepare("PRAGMA table_info(users)").all();
  if (uCols.length && !uCols.some((c) => c.name === 'avatar_path')) {
    db.exec(`ALTER TABLE users ADD COLUMN avatar_path TEXT;`);
  }
  const sCols = db.prepare("PRAGMA table_info(submissions)").all();
  if (sCols.length && !sCols.some((c) => c.name === 'flagged_for_review')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN flagged_for_review INTEGER NOT NULL DEFAULT 0;`);
  }
  const shopCols = db.prepare("PRAGMA table_info(shop_items)").all();
  if (shopCols.length && !shopCols.some((c) => c.name === 'currency')) {
    db.exec(`ALTER TABLE shop_items ADD COLUMN currency TEXT NOT NULL DEFAULT 'gold';`);
    db.exec(`ALTER TABLE shop_items ADD COLUMN restore_amount INTEGER;`);
  }
  const purchaseCols = db.prepare("PRAGMA table_info(shop_purchases)").all();
  if (purchaseCols.length && !purchaseCols.some((c) => c.name === 'currency')) {
    db.exec(`ALTER TABLE shop_purchases ADD COLUMN currency TEXT NOT NULL DEFAULT 'gold';`);
  }
  const hungerCols = db.prepare("PRAGMA table_info(mascot_hunger)").all();
  if (hungerCols.length && !hungerCols.some((c) => c.name === 'decay_hours')) {
    db.exec(`ALTER TABLE mascot_hunger ADD COLUMN decay_hours REAL NOT NULL DEFAULT 4;`);
  }
} catch (e) {
  console.error('Ошибка миграции столбцов (можно игнорировать на первом запуске):', e.message);
}

function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme';
  const name = process.env.ADMIN_NAME || 'Администратор';

  if (count === 0) {
    db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)'
    ).run(username, bcrypt.hashSync(password, 10), 'admin', name);
    console.log(`Создан администратор "${username}". Войдите под этой учёткой и создайте` +
      ' аккаунты родителей и детей в панели администратора.');
    return;
  }

  // Явный сброс пароля администратора из переменной окружения (например, если забыли пароль):
  // поставьте RESET_ADMIN_PASSWORD=true в .env и перезапустите контейнер.
  if (String(process.env.RESET_ADMIN_PASSWORD).toLowerCase() === 'true') {
    const admin = db.prepare("SELECT * FROM users WHERE username=? AND role='admin'").get(username);
    if (admin) {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), admin.id);
      console.log(`Пароль администратора "${username}" сброшен из переменной ADMIN_PASSWORD.` +
        ' Не забудьте убрать RESET_ADMIN_PASSWORD из .env после этого.');
    } else {
      console.log(`RESET_ADMIN_PASSWORD=true, но пользователь "${username}" с ролью admin не найден — пропускаю.`);
    }
  }
}

function seedMascotTreats() {
  const count = db.prepare("SELECT COUNT(*) c FROM shop_items WHERE currency='silver'").get().c;
  if (count > 0) return;
  const treats = [
    ['🍯', 'Медовые кристаллы', 'Маленькая сладкая закуска', 10, 15],
    ['🍓', 'Ягодный смузи', 'Освежающий и полезный', 15, 20],
    ['🍪', 'Звёздное печенье', 'Хрустящее и с блёстками', 20, 25],
    ['🥨', 'Солнечные крендельки', 'Тёплые, прямо с луча', 25, 30],
    ['🍦', 'Радужное мороженое', 'Праздник для маскота', 35, 40],
    ['🎂', 'Праздничный пирог', 'Наедается досыта целиком!', 60, 100],
  ];
  const insert = db.prepare(
    'INSERT INTO shop_items (name, description, cost, icon, currency, restore_amount, created_by) VALUES (?,?,?,?,?,?,NULL)'
  );
  for (const [icon, name, description, cost, restore] of treats) {
    insert.run(name, description, cost, icon, 'silver', restore);
  }
  console.log('Добавлены стандартные лакомства для маскота в магазин.');
}

seedAdmin();
seedMascotTreats();

module.exports = db;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
