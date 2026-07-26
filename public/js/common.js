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

// HTML аватарки: картинка, если загружена, иначе — кружок с первой буквой имени
function avatarHtml(name, avatarPath, size) {
  size = size || 36;
  if (avatarPath) {
    return `<img src="${avatarPath}" alt="${escapeHtml(name)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" />`;
  }
  const letter = (name || '?').trim()[0]?.toUpperCase() || '?';
  const hue = [...(name || '')].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:hsl(${hue},60%,55%);
    color:white;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;
    font-size:${Math.round(size * 0.45)}px">${letter}</div>`;
}
