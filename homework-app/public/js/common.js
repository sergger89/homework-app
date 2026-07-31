async function api(url, opts) {
  const res = await fetch(url, {
    headers: opts && opts.isForm ? undefined : { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = '/index.html';
    throw new Error('not_authenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'request_failed');
    err.data = data;
    throw err;
  }
  return data;
}

// для multipart/form-data запросов (загрузка файлов) - не выставляем Content-Type вручную
async function apiForm(url, formData, method = 'POST') {
  let res;
  try {
    res = await fetch(url, { method, body: formData });
  } catch (networkErr) {
    // сеть оборвалась / запрос отклонён ещё до ответа сервера (часто - прокси/ingress режет большие файлы)
    const err = new Error('network_error');
    err.data = { error: 'network_error', status: 0 };
    throw err;
  }
  const rawText = await res.text();
  let data = {};
  try { data = rawText ? JSON.parse(rawText) : {}; } catch (e) { /* ответ не JSON - например, страница ошибки от прокси */ }
  if (!res.ok) {
    const err = new Error(data.error || `http_${res.status}`);
    err.data = { ...data, status: res.status, rawText: data.error ? undefined : rawText.slice(0, 300) };
    throw err;
  }
  return data;
}

async function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  const { user } = await api('/api/me');
  if (!user) {
    window.location.href = '/index.html';
    return;
  }
  if (!allowed.includes(user.role)) {
    window.location.href = roleHome(user.role);
  }
}

function roleHome(role) {
  if (role === 'admin') return '/admin.html';
  if (role === 'parent') return '/parent.html';
  return '/child.html';
}

function logout() {
  api('/api/logout', { method: 'POST' }).then(() => (window.location.href = '/index.html'));
}

const SUBJECT_LABELS = {
  math: 'Математика',
  english: 'Английский',
  russian: 'Русский язык',
  reading: 'Чтение',
  science: 'Окружающий мир',
  history: 'История',
};
function subjectLabel(s) {
  return SUBJECT_LABELS[s] || (s ? s[0].toUpperCase() + s.slice(1) : 'Предмет');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// применяет favicon, загруженный админом (если есть) - вызывать на каждой странице
// сообщает Android-приложению (если открыто в нём), что сейчас идёт жест рисования/пролистывания
// внутри страницы - чтобы нативный "потяни вниз, чтобы обновить" не перехватывал движение.
// В обычном браузере window.AndroidBridge не существует - вызов просто ничего не делает.
function setNativeDrawingActive(active) {
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.setDrawingActive === 'function') {
      window.AndroidBridge.setDrawingActive(active);
    }
  } catch (e) { /* игнорируем - не критично */ }
}

function applyFavicon() {
  fetch('/api/settings').then(r => r.json()).then(({ faviconUrl }) => {
    if (!faviconUrl) return;
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = faviconUrl;
  }).catch(() => {});
}
// ==================== Маскот приложения ====================
const MASCOT_EMOTIONS = ['surprise','disappointment','joy','anger','sadness','kiss','wink','admiration','disgust','boredom','horror','fun'];
const MASCOT_SAD_EMOTIONS = ['sadness','disappointment','horror','disgust','anger'];

function mascotSrc(emotion) {
  return `/mascot/${MASCOT_EMOTIONS.includes(emotion) ? emotion : 'joy'}.png`;
}

// переводит % сытости маскота в подходящую эмоцию (используется везде, где показывается
// "фоновое" настроение маскота - главная ребёнка, книги, профиль)
function hungerMood(pct) {
  if (pct >= 70) return 'joy';
  if (pct >= 40) return 'boredom';
  if (pct >= 15) return 'disappointment';
  return 'sadness';
}

// подгружаем все картинки маскота в фоне разок, чтобы дальше эмоции переключались без задержки
function preloadMascotImages() {
  if (window.__mascotPreloaded) return;
  window.__mascotPreloaded = true;
  MASCOT_EMOTIONS.forEach((e) => { const img = new Image(); img.src = mascotSrc(e); });
}

// небольшая ненавязчивая всплывающая реакция маскота (для страниц, где не нужен постоянный виджет,
// например задание) - появляется в углу и сама пропадает, как уведомление о монетах.
// force=true игнорирует cooldown (для по-настоящему важных событий вроде верного ответа).
let __lastMascotToastAt = 0;
const MASCOT_TOAST_COOLDOWN_MS = 4000;
let __floatingMascotStage = null;
let __floatingMascotBubble = null;
let __floatingMascotHidden = false;

// постоянный плавающий маскот в углу экрана - создаётся один раз на страницу (только для
// роли "ребёнок", не на читалке - см. вызов в конце файла), реагирует на действия через
// showMascotToast(), и может быть скрыт/возвращён пользователем (запоминается в localStorage).
function initFloatingMascot() {
  if (document.getElementById('floatingMascotWrap')) return;
  preloadMascotLayerImages();
  const wrap = document.createElement('div');
  wrap.id = 'floatingMascotWrap';
  wrap.className = 'floating-mascot-wrap';
  wrap.innerHTML = `
    <div class="floating-mascot-card" id="floatingMascotCard">
      <div class="mascot-bubble floating-mascot-bubble" id="floatingMascotBubble"></div>
      <div class="mascot-anim-stage" id="floatingMascotStage"></div>
    </div>
    <button class="floating-mascot-toggle" id="floatingMascotToggle" aria-label="Скрыть/показать маскота" title="Скрыть/показать маскота">🦉</button>
  `;
  document.body.appendChild(wrap);
  __floatingMascotStage = document.getElementById('floatingMascotStage');
  __floatingMascotBubble = document.getElementById('floatingMascotBubble');
  updateMascotAnimated(__floatingMascotStage, 'boredom');

  document.getElementById('floatingMascotToggle').onclick = () => {
    setFloatingMascotHidden(!__floatingMascotHidden);
  };
  setFloatingMascotHidden(localStorage.getItem('mascotHidden') === '1');
}

function setFloatingMascotHidden(hidden) {
  __floatingMascotHidden = hidden;
  try { localStorage.setItem('mascotHidden', hidden ? '1' : '0'); } catch (e) {}
  const card = document.getElementById('floatingMascotCard');
  const toggle = document.getElementById('floatingMascotToggle');
  if (card) card.style.display = hidden ? 'none' : 'flex';
  if (toggle) toggle.classList.toggle('hidden-state', hidden);
}

function showMascotToast(message, emotion, force) {
  if (!__floatingMascotStage) return; // маскота нет на этой странице (например, читалка)
  const now = Date.now();
  if (!force && now - __lastMascotToastAt < MASCOT_TOAST_COOLDOWN_MS) return;
  __lastMascotToastAt = now;
  updateMascotAnimated(__floatingMascotStage, emotion);
  if (__floatingMascotHidden) return; // маскот скрыт - реагирует "про себя", без пузыря
  __floatingMascotBubble.textContent = message;
  __floatingMascotBubble.classList.remove('show');
  void __floatingMascotBubble.offsetWidth;
  __floatingMascotBubble.classList.add('show');
  clearTimeout(__floatingMascotBubble._hideTimer);
  __floatingMascotBubble._hideTimer = setTimeout(() => __floatingMascotBubble.classList.remove('show'), 3200);
}

// постоянный виджет маскота (поза+глаза+рот+румянец+эффект, + речевой пузырь) - для страниц
// вроде магазина, где реакция должна оставаться на экране, а не мелькать всплывающим уведомлением.
function createMascotWidget(containerEl) {
  preloadMascotLayerImages();
  containerEl.classList.add('mascot-wrap');
  containerEl.innerHTML = `<div class="mascot-anim-stage"></div>
    <div class="mascot-bubble"></div>`;
  const stageEl = containerEl.querySelector('.mascot-anim-stage');
  const bubbleEl = containerEl.querySelector('.mascot-bubble');
  updateMascotAnimated(stageEl, 'boredom');
  return {
    say(message, emotion) {
      updateMascotAnimated(stageEl, emotion);
      bubbleEl.textContent = message;
      bubbleEl.classList.remove('show');
      void bubbleEl.offsetWidth;
      bubbleEl.classList.add('show');
    },
  };
}

// сопоставление уровня голода маскота (0-100) с базовым "настроением по умолчанию" -
// используется как фоновое/дежурное состояние маскота на любой странице, поверх которого
// накладываются кратковременные реакции на конкретные события.
function mascotMoodForHunger(hunger) {
  if (hunger >= 70) return 'joy';
  if (hunger >= 40) return 'admiration';
  if (hunger >= 15) return 'boredom';
  return 'sadness';
}

// подставляет во все переданные <img> настроение маскота, соответствующее текущему голоду
// ребёнка. Безопасно вызывать и для родителя/админа (без childId) - тогда просто ничего не делает.
async function applyHungerMood(imgEls, childId) {
  try {
    const qs = childId ? `?childId=${childId}` : '';
    const { hunger } = await api(`/api/me/hunger${qs}`);
    const mood = mascotMoodForHunger(hunger);
    (imgEls.length !== undefined ? [...imgEls] : [imgEls]).forEach((img) => { if (img) img.src = mascotSrc(mood); });
    return hunger;
  } catch (e) { return null; }
}

applyFavicon();


// ==================== Модальные диалоги (замена alert/confirm/prompt) ====================
// Нативные alert()/confirm()/prompt() блокируют страницу, выглядят по-разному на каждой
// платформе и не вписываются в дизайн. Используем один и тот же лёгкий модальный компонент.

function _buildDialogOverlay(innerHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function showAlertDialog(message, title) {
  return new Promise((resolve) => {
    const overlay = _buildDialogOverlay(`
      ${title ? `<h3>${escapeHtml(title)}</h3>` : ''}
      <p class="dialog-message">${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button class="wizard-btn primary" id="dlgOk">Понятно</button>
      </div>
    `);
    const close = () => { document.body.removeChild(overlay); resolve(); };
    overlay.querySelector('#dlgOk').onclick = close;
    overlay.querySelector('#dlgOk').focus();
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  });
}

function showConfirmDialog(message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const overlay = _buildDialogOverlay(`
      ${opts.title ? `<h3>${escapeHtml(opts.title)}</h3>` : ''}
      <p class="dialog-message">${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button class="wizard-btn" id="dlgCancel">${escapeHtml(opts.cancelText || 'Отмена')}</button>
        <button class="wizard-btn ${opts.danger ? 'danger' : 'primary'}" id="dlgConfirm">${escapeHtml(opts.confirmText || 'Да')}</button>
      </div>
    `);
    const finish = (result) => { document.body.removeChild(overlay); resolve(result); };
    overlay.querySelector('#dlgCancel').onclick = () => finish(false);
    overlay.querySelector('#dlgConfirm').onclick = () => finish(true);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
    overlay.querySelector('#dlgConfirm').focus();
  });
}

// Диалог задания нового пароля: маскированное поле + подтверждение + кнопка "показать".
// Возвращает Promise<string|null> (null - если отменили).
// общий диалог с одним текстовым полем (например, смена отображаемого имени)
function showTextInputDialog(title, currentValue, placeholder) {
  return new Promise((resolve) => {
    const overlay = _buildDialogOverlay(`
      <h3>${escapeHtml(title || 'Введите значение')}</h3>
      <div class="field-row">
        <input type="text" id="dlgTextInput" value="${escapeHtml(currentValue || '')}" placeholder="${escapeHtml(placeholder || '')}" />
        <p class="dialog-error" id="dlgTextError"></p>
      </div>
      <div class="dialog-actions">
        <button class="wizard-btn" id="dlgCancel">Отмена</button>
        <button class="wizard-btn primary" id="dlgConfirm">Сохранить</button>
      </div>
    `);
    const finish = (result) => { document.body.removeChild(overlay); resolve(result); };
    overlay.querySelector('#dlgCancel').onclick = () => finish(null);
    overlay.querySelector('#dlgConfirm').onclick = () => {
      const val = overlay.querySelector('#dlgTextInput').value.trim();
      if (!val) { overlay.querySelector('#dlgTextError').textContent = 'Поле не может быть пустым.'; return; }
      finish(val);
    };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); if (e.key === 'Enter') overlay.querySelector('#dlgConfirm').click(); });
    overlay.querySelector('#dlgTextInput').focus();
    overlay.querySelector('#dlgTextInput').select();
  });
}

function showPasswordDialog(title) {
  return new Promise((resolve) => {
    const overlay = _buildDialogOverlay(`
      <h3>${escapeHtml(title || 'Новый пароль')}</h3>
      <div class="field-row">
        <label class="muted">Новый пароль
          <div class="password-field">
            <input type="password" id="dlgPass1" minlength="4" autocomplete="new-password" />
            <button type="button" class="password-toggle" data-target="dlgPass1" aria-label="Показать пароль">👁️</button>
          </div>
        </label>
        <label class="muted">Повторите пароль
          <div class="password-field">
            <input type="password" id="dlgPass2" minlength="4" autocomplete="new-password" />
            <button type="button" class="password-toggle" data-target="dlgPass2" aria-label="Показать пароль">👁️</button>
          </div>
        </label>
        <p class="dialog-error" id="dlgPassError"></p>
      </div>
      <div class="dialog-actions">
        <button class="wizard-btn" id="dlgCancel">Отмена</button>
        <button class="wizard-btn primary" id="dlgConfirm">Сохранить</button>
      </div>
    `);
    wirePasswordToggles(overlay);
    const finish = (result) => { document.body.removeChild(overlay); resolve(result); };
    overlay.querySelector('#dlgCancel').onclick = () => finish(null);
    overlay.querySelector('#dlgConfirm').onclick = () => {
      const p1 = overlay.querySelector('#dlgPass1').value;
      const p2 = overlay.querySelector('#dlgPass2').value;
      const errEl = overlay.querySelector('#dlgPassError');
      if (!p1 || p1.length < 4) { errEl.textContent = 'Минимум 4 символа.'; return; }
      if (p1 !== p2) { errEl.textContent = 'Пароли не совпадают.'; return; }
      finish(p1);
    };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
    overlay.querySelector('#dlgPass1').focus();
  });
}

// вешает кнопку "показать/скрыть" на все .password-toggle внутри контейнера
function wirePasswordToggles(container) {
  (container || document).querySelectorAll('.password-toggle').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '👁️' : '🙈';
      btn.setAttribute('aria-label', showing ? 'Показать пароль' : 'Скрыть пароль');
    };
  });
}

// ==================== Индикатор загрузки ====================
function loadingHtml(text) {
  return `<div class="loading-state"><span class="spinner" aria-hidden="true"></span>${escapeHtml(text || 'Загрузка...')}</div>`;
}

// HTML аватарки: картинка, если загружена, иначе — кружок с первой буквой имени
function avatarHtml(name, avatarPath, size) {
  size = size || 36;
  if (avatarPath) {
    return `<img src="${avatarPath}" alt="Аватар: ${escapeHtml(name)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" />`;
  }
  const letter = (name || '?').trim()[0]?.toUpperCase() || '?';
  const hue = [...(name || '')].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return `<div role="img" aria-label="Аватар: ${escapeHtml(name)}" style="width:${size}px;height:${size}px;border-radius:50%;background:hsl(${hue},60%,55%);
    color:white;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;
    font-size:${Math.round(size * 0.45)}px">${letter}</div>`;
}

// автоматически показываем постоянного плавающего маскота на всех страницах ребёнка,
// кроме читалки (там он мешал бы чтению) - роль проверяем через /api/me, раз мы это
// делаем один раз на загрузку страницы, а не на каждый вызов showMascotToast.
(function () {
  if (window.location.pathname === '/reader.html') return;
  if (window.location.pathname === '/shop.html') return; // там уже есть свой постоянный виджет в контенте
  if (typeof api !== 'function') return;
  api('/api/me').then(({ user }) => {
    if (user && user.role === 'child') initFloatingMascot();
  }).catch(() => {});
})();
