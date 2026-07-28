// Черновик (рисование) для задания. Хранит "мазки" в координатах, нормализованных
// к размеру холста (0..1), поэтому рисунок корректно масштабируется на любом экране.

const SCRATCH_COLORS = ['#222222', '#e0473b', '#4a6cf7', '#22a06b', '#f5a623'];

function openScratchpad(taskId, promptText) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(20,22,30,0.55); z-index:1000;
      display:flex; align-items:center; justify-content:center; padding:10px;`;
    overlay.innerHTML = `
      <div class="scratch-panel">
        <div class="scratch-toolbar">
          <div class="scratch-colors">
            ${SCRATCH_COLORS.map(c => `<button class="scratch-color" data-color="${c}" style="background:${c}"></button>`).join('')}
          </div>
          <div class="scratch-tools">
            <button class="scratch-tool-btn active" data-tool="pen" title="Карандаш">✏️</button>
            <button class="scratch-tool-btn" data-tool="highlighter" title="Выделение">🖍️</button>
            <button class="scratch-tool-btn" data-tool="eraser" title="Ластик">🧽</button>
            <button class="scratch-tool-btn" data-action="undo" title="Отменить">↺</button>
            <button class="scratch-tool-btn" data-action="redo" title="Вернуть">↻</button>
            <button class="scratch-tool-btn" data-action="clear" title="Стереть всё">🗑️</button>
          </div>
        </div>
        <div class="scratch-canvas-wrap">
          ${promptText ? `
          <div class="scratch-task-bar" id="scratchTaskBar">
            <div class="scratch-task-text" id="scratchTaskText">${escapeHtml(promptText)}</div>
            <button class="scratch-task-toggle" id="scratchTaskToggle">▾</button>
          </div>` : ''}
          <canvas class="scratch-canvas"></canvas>
        </div>
        <div class="scratch-footer">
          <span class="scratch-save-indicator" id="scratchStatus"></span>
          <button class="wizard-btn primary" id="scratchDone">Готово</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const taskBar = overlay.querySelector('#scratchTaskBar');
    if (taskBar) {
      const toggleBtn = overlay.querySelector('#scratchTaskToggle');
      const textEl = overlay.querySelector('#scratchTaskText');
      toggleBtn.onclick = () => {
        const expanded = taskBar.classList.toggle('expanded');
        toggleBtn.textContent = expanded ? '▴' : '▾';
      };
      // короткий текст - сразу без кнопки сворачивания, он и так поместится в 1-2 строки
      requestAnimationFrame(() => {
        if (textEl.scrollHeight <= textEl.clientHeight + 2) {
          toggleBtn.style.display = 'none';
        }
      });
    }

    const canvas = overlay.querySelector('.scratch-canvas');
    const ctx = canvas.getContext('2d');
    let strokes = [];
    let redoStack = [];
    let currentTool = 'pen';
    let currentColor = SCRATCH_COLORS[0];
    let drawing = null;

    function resizeCanvas() {
      const wrap = overlay.querySelector('.scratch-canvas-wrap');
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    function redraw() {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, w, h);
      for (const s of strokes) drawStroke(s, w, h);
    }

    function drawStroke(s, w, h) {
      if (s.points.length < 1) return;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (s.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.lineWidth = 26;
      } else if (s.tool === 'highlighter') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 20;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 3;
      }
      ctx.beginPath();
      s.points.forEach(([nx, ny], i) => {
        const x = nx * w, y = ny * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }

    function pointerPos(e) {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
    }

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drawing = { tool: currentTool, color: currentColor, points: [pointerPos(e)] };
      redoStack = [];
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      drawing.points.push(pointerPos(e));
      redraw();
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);
      drawStroke(drawing, w, h);
    });
    function endStroke() {
      if (!drawing) return;
      if (drawing.points.length > 1) strokes.push(drawing);
      drawing = null;
    }
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointerleave', endStroke);

    overlay.querySelectorAll('.scratch-color').forEach(btn => {
      btn.onclick = () => {
        currentColor = btn.dataset.color;
        overlay.querySelectorAll('.scratch-color').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
    overlay.querySelector('.scratch-color').classList.add('active');

    overlay.querySelectorAll('.scratch-tool-btn[data-tool]').forEach(btn => {
      btn.onclick = () => {
        currentTool = btn.dataset.tool;
        overlay.querySelectorAll('.scratch-tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
    overlay.querySelector('[data-action="undo"]').onclick = () => {
      if (strokes.length === 0) return;
      redoStack.push(strokes.pop());
      redraw();
    };
    overlay.querySelector('[data-action="redo"]').onclick = () => {
      if (redoStack.length === 0) return;
      strokes.push(redoStack.pop());
      redraw();
    };
    overlay.querySelector('[data-action="clear"]').onclick = () => {
      if (strokes.length === 0) return;
      if (!confirm('Стереть весь черновик?')) return;
      redoStack = [];
      strokes = [];
      redraw();
    };

    let saveTimer = null;
    let hideStatusTimer = null;
    function scheduleSave() {
      const statusEl = overlay.querySelector('#scratchStatus');
      clearTimeout(hideStatusTimer);
      statusEl.textContent = '● сохранение…';
      statusEl.classList.remove('saved', 'error');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await api(`/api/tasks/${taskId}/draft`, { method: 'PUT', body: JSON.stringify({ strokes }) });
          statusEl.textContent = '✓ сохранено';
          statusEl.classList.add('saved');
          hideStatusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
        } catch (e) {
          statusEl.textContent = '⚠ не сохранено';
          statusEl.classList.add('error');
        }
      }, 500);
    }
    canvas.addEventListener('pointerup', scheduleSave);

    overlay.querySelector('#scratchDone').onclick = () => {
      clearTimeout(saveTimer);
      api(`/api/tasks/${taskId}/draft`, { method: 'PUT', body: JSON.stringify({ strokes }) }).finally(() => {
        document.body.removeChild(overlay);
        window.removeEventListener('resize', resizeCanvas);
        resolve();
      });
    };

    window.addEventListener('resize', resizeCanvas);

    // загрузка сохранённого черновика
    api(`/api/tasks/${taskId}/draft`).then(({ strokes: saved }) => {
      strokes = saved || [];
      resizeCanvas();
    }).catch(() => resizeCanvas());
  });
}
