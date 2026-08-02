// Интеграционные тесты ключевых сценариев приложения. Запускаются встроенным test runner'ом
// Node (node --test), без дополнительных зависимостей. Поднимают реальный сервер на отдельном
// порту с временной базой данных (удаляется после прогона) и стучатся в него через fetch,
// как это делал бы настоящий браузер - проверяем поведение end-to-end, а не отдельные функции
// в изоляции.
//
// Запуск: npm test (из папки homework-app)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_PORT = 3999;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homework-app-test-'));

process.env.PORT = String(TEST_PORT);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testadminpass';
process.env.SESSION_SECRET = 'test-secret';

const BASE_URL = `http://localhost:${TEST_PORT}`;
let serverHandle;

before(() => {
  serverHandle = require('../server');
});

after(() => {
  serverHandle.server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  // библиотека better-sqlite3-session-store оставляет setInterval без .unref() (не наш код,
  // поправить нельзя) - без принудительного выхода процесс тестов никогда бы не завершился.
  setImmediate(() => process.exit(0));
});

// извлекает "имя=значение" из Set-Cookie ответа, для передачи в следующий запрос
function extractCookie(response) {
  const raw = response.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

async function login(username, password) {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = extractCookie(res);
  const data = await res.json();
  return { res, cookie, data };
}

test('health check отвечает ok', async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
});

test('логин с неверным паролем отклоняется (401)', async () => {
  const { res, data } = await login('testadmin', 'wrong-password');
  assert.equal(res.status, 401);
  assert.equal(data.error, 'invalid_credentials');
});

test('логин с верными данными администратора (из ADMIN_USERNAME/ADMIN_PASSWORD) проходит', async () => {
  const { res, cookie, data } = await login('testadmin', 'testadminpass');
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.user.role, 'admin');
  assert.ok(cookie, 'сессионная кука должна быть выставлена');
});

test('слишком короткий пароль (< 6 символов) отклоняется при создании аккаунта', async () => {
  const { cookie } = await login('testadmin', 'testadminpass');
  const res = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ role: 'parent', username: 'shortpw', password: '123', displayName: 'Short' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, 'password_too_short');
});

test('создание родителя и ребёнка, полный цикл: назначение задания -> верный ответ -> награда', async () => {
  const admin = await login('testadmin', 'testadminpass');

  // создаём родителя
  const createParentRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ role: 'parent', username: 'parent1', password: 'parentpass', displayName: 'Родитель' }),
  });
  assert.equal(createParentRes.status, 200);

  const parent = await login('parent1', 'parentpass');
  assert.equal(parent.res.status, 200);

  // родитель создаёт ребёнка
  const createChildRes = await fetch(`${BASE_URL}/api/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: parent.cookie },
    body: JSON.stringify({ username: 'child1', password: 'childpass', displayName: 'Ребёнок' }),
  });
  assert.equal(createChildRes.status, 200);
  const { childId } = await createChildRes.json();

  // родитель назначает простое задание
  const importRes = await fetch(`${BASE_URL}/api/assignments/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: parent.cookie },
    body: JSON.stringify({
      subject: 'math',
      title: 'Тестовое задание',
      childIds: [childId],
      tasks: [{ type: 'open_number', prompt: 'Сколько будет 2+2?', correctValue: 4, tolerance: 0, explanation: 'Это 4' }],
    }),
  });
  assert.equal(importRes.status, 200);

  const child = await login('child1', 'childpass');
  assert.equal(child.res.status, 200);

  const coinsBefore = await fetch(`${BASE_URL}/api/me/coins`, { headers: { Cookie: child.cookie } }).then((r) => r.json());

  // отправляем ВЕРНЫЙ ответ на задание с id=1 (первое созданное в чистой тестовой базе)
  const submitRes = await fetch(`${BASE_URL}/api/tasks/1/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: child.cookie },
    body: JSON.stringify({ answer: 4 }),
  });
  assert.equal(submitRes.status, 200);
  const submitData = await submitRes.json();
  assert.equal(submitData.isCorrect, true, 'верный ответ должен быть отмечен как правильный');

  const coinsAfter = await fetch(`${BASE_URL}/api/me/coins`, { headers: { Cookie: child.cookie } }).then((r) => r.json());
  assert.ok(coinsAfter.balance > coinsBefore.balance, 'за верный ответ должны начислиться монеты');
});

test('неверный ответ на задание не засчитывается и не даёт монет', async () => {
  const parent = await login('parent1', 'parentpass');
  const importRes = await fetch(`${BASE_URL}/api/assignments/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: parent.cookie },
    body: JSON.stringify({
      subject: 'math',
      title: 'Второе задание',
      childIds: [3], // ребёнок из предыдущего теста
      tasks: [{ type: 'open_number', prompt: 'Сколько будет 3+3?', correctValue: 6, tolerance: 0, explanation: 'Это 6' }],
    }),
  });
  assert.equal(importRes.status, 200);

  const child = await login('child1', 'childpass');
  const coinsBefore = await fetch(`${BASE_URL}/api/me/coins`, { headers: { Cookie: child.cookie } }).then((r) => r.json());

  const submitRes = await fetch(`${BASE_URL}/api/tasks/2/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: child.cookie },
    body: JSON.stringify({ answer: 999 }),
  });
  const submitData = await submitRes.json();
  assert.equal(submitData.isCorrect, false);

  const coinsAfter = await fetch(`${BASE_URL}/api/me/coins`, { headers: { Cookie: child.cookie } }).then((r) => r.json());
  assert.equal(coinsAfter.balance, coinsBefore.balance, 'за неверный ответ монеты начисляться не должны');
});

test('покупка в магазине списывает монеты и создаёт запись, ожидающую выдачи', async () => {
  const parent = await login('parent1', 'parentpass');
  const createItemRes = await fetch(`${BASE_URL}/api/shop/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: parent.cookie },
    body: JSON.stringify({ name: 'Тестовая награда', cost: 5, currency: 'gold' }),
  });
  assert.equal(createItemRes.status, 200);
  const { itemId } = await createItemRes.json();

  const child = await login('child1', 'childpass');
  const coinsBefore = await fetch(`${BASE_URL}/api/me/coins`, { headers: { Cookie: child.cookie } }).then((r) => r.json());
  assert.ok(coinsBefore.balance >= 5, 'у ребёнка должно быть достаточно монет из предыдущих тестов');

  const buyRes = await fetch(`${BASE_URL}/api/shop/purchase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: child.cookie },
    body: JSON.stringify({ itemId }),
  });
  assert.equal(buyRes.status, 200);

  const coinsAfter = await fetch(`${BASE_URL}/api/me/coins`, { headers: { Cookie: child.cookie } }).then((r) => r.json());
  assert.equal(coinsAfter.balance, coinsBefore.balance - 5);

  const pendingRes = await fetch(`${BASE_URL}/api/parent/pending-fulfillment`, { headers: { Cookie: parent.cookie } });
  const pending = await pendingRes.json();
  assert.ok(pending.items.some((i) => i.itemName === 'Тестовая награда'), 'покупка должна появиться в списке ожидающих выдачи');
});

test('обычный родитель не может пользоваться админскими endpoint-ами (проверка requireRole)', async () => {
  const parent = await login('parent1', 'parentpass');
  const res = await fetch(`${BASE_URL}/api/admin/users`, { headers: { Cookie: parent.cookie } });
  assert.equal(res.status, 403);
});

test('без сессии защищённые endpoint-ы недоступны (401/403, не 200)', async () => {
  const res = await fetch(`${BASE_URL}/api/me/coins`);
  assert.notEqual(res.status, 200);
});

test('выход из аккаунта (logout) корректно завершает сессию', async () => {
  const { cookie } = await login('testadmin', 'testadminpass');
  const before = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.ok(before.user, 'до логаута пользователь должен быть виден');

  await fetch(`${BASE_URL}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const after = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(after.user, null, 'после логаута сессия должна быть недействительна');
});
