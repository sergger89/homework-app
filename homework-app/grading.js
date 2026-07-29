// Проверка ответа ребёнка против правильного ответа, в зависимости от типа задания.
// task = { type, ...данные с правильными ответами }
// answer = то, что прислал ребёнок (структура зависит от типа)

function normalizeText(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Типы, для которых у самого задания в принципе нет единственно верного ответа -
// они ВСЕГДА идут на ручную проверку родителем, независимо от флага needsManualReview.
const ALWAYS_MANUAL_TYPES = ['word_table'];

function gradeTask(task, answer) {
  // "ждёт проверки родителем" может быть явно указано (needsManualReview:true) для
  // любого типа задания, либо подразумеваться самим типом (например, word_table).
  if (task.needsManualReview || ALWAYS_MANUAL_TYPES.includes(task.type)) {
    return { isCorrect: null };
  }

  switch (task.type) {
    case 'choice_single': {
      const idx = Number(answer);
      return { isCorrect: idx === task.correctIndex };
    }
    case 'choice_multiple': {
      const given = Array.isArray(answer) ? [...answer].map(Number).sort() : [];
      const correct = [...task.correctIndices].sort();
      const isCorrect =
        given.length === correct.length && given.every((v, i) => v === correct[i]);
      return { isCorrect };
    }
    case 'open_text': {
      const given = normalizeText(answer);
      const accepted = (task.acceptedAnswers || []).map((a) =>
        task.caseSensitive ? String(a).trim() : normalizeText(a)
      );
      const givenCmp = task.caseSensitive ? String(answer ?? '').trim() : given;
      return { isCorrect: accepted.includes(givenCmp) };
    }
    case 'open_number': {
      const given = Number(answer);
      const tol = Number(task.tolerance || 0);
      if (Number.isNaN(given)) return { isCorrect: false };
      return { isCorrect: Math.abs(given - Number(task.correctValue)) <= tol };
    }
    case 'matching': {
      // answer: массив пар [leftIdx, rightIdx], в любом порядке
      const given = Array.isArray(answer) ? answer : [];
      const correctSet = new Set(task.correctPairs.map((p) => p.join(':')));
      const givenSet = new Set(given.map((p) => p.join(':')));
      const isCorrect =
        correctSet.size === givenSet.size &&
        [...correctSet].every((p) => givenSet.has(p));
      return { isCorrect };
    }
    case 'cloze': {
      // answer: массив строк, по одной на каждый пропуск, в порядке task.blanks
      const given = Array.isArray(answer) ? answer : [];
      const blanks = task.blanks || [];
      if (given.length !== blanks.length) return { isCorrect: false };
      const allCorrect = blanks.every((b, i) => {
        const accepted = (b.acceptedAnswers || []).map(normalizeText);
        return accepted.includes(normalizeText(given[i]));
      });
      return { isCorrect: allCorrect };
    }
    case 'word_table':
      // сюда не должны попадать - word_table всегда обрабатывается веткой needsManualReview выше.
      return { isCorrect: null };
    default:
      return { isCorrect: false, error: 'unknown_task_type' };
  }
}

const VALID_TYPES = ['choice_single', 'choice_multiple', 'open_text', 'open_number', 'matching', 'cloze', 'word_table'];

// Базовая валидация структуры присланного assignment JSON перед вставкой в БД.
function validateAssignment(assignment) {
  const errors = [];
  if (!assignment || typeof assignment !== 'object') {
    return ['assignment должен быть объектом'];
  }
  if (!assignment.subject || typeof assignment.subject !== 'string') {
    errors.push('поле "subject" обязательно (строка)');
  }
  if (!assignment.title || typeof assignment.title !== 'string') {
    errors.push('поле "title" обязательно (строка)');
  }
  if (!Array.isArray(assignment.tasks) || assignment.tasks.length === 0) {
    errors.push('поле "tasks" должно быть непустым массивом');
    return errors;
  }
  assignment.tasks.forEach((t, i) => {
    if (!VALID_TYPES.includes(t.type)) {
      errors.push(`tasks[${i}]: неизвестный тип "${t.type}"`);
      return;
    }
    if (!t.prompt && !t.promptTemplate) {
      errors.push(`tasks[${i}]: нужно поле "prompt" (или "promptTemplate" для cloze)`);
    }
    const manual = !!t.needsManualReview || ALWAYS_MANUAL_TYPES.includes(t.type);

    // Структурные поля (варианты/пары/пропуски) нужны всегда - без них нечего рендерить.
    // А вот сами "правильные ответы" внутри этой структуры обязательны только если
    // задание НЕ отправлено на ручную проверку.
    if (t.type === 'choice_single') {
      if (!Array.isArray(t.options) || t.options.length < 2)
        errors.push(`tasks[${i}]: нужно минимум 2 "options"`);
      if (!manual && typeof t.correctIndex !== 'number')
        errors.push(`tasks[${i}]: нужно числовое "correctIndex" (или needsManualReview:true)`);
    }
    if (t.type === 'choice_multiple') {
      if (!Array.isArray(t.options) || t.options.length < 2)
        errors.push(`tasks[${i}]: нужно минимум 2 "options"`);
      if (!manual && (!Array.isArray(t.correctIndices) || t.correctIndices.length === 0))
        errors.push(`tasks[${i}]: нужен непустой массив "correctIndices" (или needsManualReview:true)`);
    }
    if (t.type === 'open_text' && !manual) {
      if (!Array.isArray(t.acceptedAnswers) || t.acceptedAnswers.length === 0)
        errors.push(`tasks[${i}]: нужен непустой массив "acceptedAnswers" (или needsManualReview:true)`);
    }
    if (t.type === 'open_number' && !manual) {
      if (typeof t.correctValue !== 'number')
        errors.push(`tasks[${i}]: нужно числовое "correctValue" (или needsManualReview:true)`);
    }
    if (t.type === 'matching') {
      if (!Array.isArray(t.left) || !Array.isArray(t.right))
        errors.push(`tasks[${i}]: нужны массивы "left" и "right"`);
      if (!manual && (!Array.isArray(t.correctPairs) || t.correctPairs.length === 0))
        errors.push(`tasks[${i}]: нужен непустой массив "correctPairs" (или needsManualReview:true)`);
    }
    if (t.type === 'cloze') {
      if (!t.promptTemplate) errors.push(`tasks[${i}]: нужно "promptTemplate" с ___ на месте пропусков`);
      if (!Array.isArray(t.blanks) || t.blanks.length === 0)
        errors.push(`tasks[${i}]: нужен непустой массив "blanks" (описывающий сами пропуски)`);
      if (!manual && Array.isArray(t.blanks) && t.blanks.some((b) => !Array.isArray(b.acceptedAnswers) || b.acceptedAnswers.length === 0)) {
        errors.push(`tasks[${i}]: у каждого пропуска нужен непустой "acceptedAnswers" (или needsManualReview:true на всё задание)`);
      }
    }
    if (t.type === 'word_table') {
      if (!Array.isArray(t.columns) || t.columns.length === 0) {
        errors.push(`tasks[${i}]: нужен непустой массив "columns" (описание колонок таблицы)`);
      } else {
        t.columns.forEach((c, ci) => {
          if (!c.label) errors.push(`tasks[${i}].columns[${ci}]: нужно поле "label"`);
          if (c.type === 'select' && (!Array.isArray(c.options) || c.options.length === 0)) {
            errors.push(`tasks[${i}].columns[${ci}]: для type:"select" нужен непустой "options"`);
          }
        });
      }
    }
    // объяснение обязательно для всех автопроверяемых заданий - показывается при исчерпании попыток
    if (!manual && (!t.explanation || !String(t.explanation).trim())) {
      errors.push(`tasks[${i}]: нужно непустое поле "explanation" (кроме заданий с needsManualReview:true)`);
    }
  });
  return errors;
}

module.exports = { gradeTask, validateAssignment, VALID_TYPES };
