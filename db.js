const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('parent','child')),
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL -- JSON, содержит правильные ответы, доступен только серверу/родителю
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer TEXT NOT NULL, -- JSON ответа ребёнка
  is_correct INTEGER, -- 0/1, или NULL если ждёт ручной проверки родителем
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_id, child_id)
);
`);

function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return;

  const parentUser = process.env.PARENT_USERNAME || 'parent';
  const parentPass = process.env.PARENT_PASSWORD || 'changeme';
  const parentName = process.env.PARENT_NAME || 'Родитель';

  const insert = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)'
  );
  insert.run(parentUser, bcrypt.hashSync(parentPass, 10), 'parent', parentName);

  // CHILDREN='[{"username":"vasya","password":"1234","name":"Вася"}]'
  let children = [];
  try {
    children = JSON.parse(process.env.CHILDREN || '[]');
  } catch (e) {
    console.error('Не удалось разобрать CHILDREN из .env, использую значение по умолчанию', e);
  }
  if (children.length === 0) {
    children = [
      {
        username: process.env.CHILD_USERNAME || 'child',
        password: process.env.CHILD_PASSWORD || 'changeme',
        name: process.env.CHILD_NAME || 'Ребёнок',
      },
    ];
  }
  for (const c of children) {
    insert.run(c.username, bcrypt.hashSync(c.password, 10), 'child', c.name);
  }
  console.log(`Создан родитель "${parentUser}" и ${children.length} ребёнок/детей.`);
}

seedUsers();

module.exports = db;
