async function api(url, opts) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
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

async function requireRole(role) {
  const { user } = await api('/api/me');
  if (!user) {
    window.location.href = '/index.html';
    return;
  }
  if (user.role !== role) {
    window.location.href = user.role === 'parent' ? '/parent.html' : '/child.html';
  }
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
