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
