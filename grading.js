// Проверка ответа ребёнка против правильного ответа, в зависимости от типа задания.
// task = { type, ...данные с правильными ответами }
// answer = то, что прислал ребёнок (структура зависит от типа)

function normalizeText(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function gradeTask(task, answer) {
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
      if (task.needsManualReview) {
        return { isCorrect: null }; // ждёт проверки родителем
      }
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
    default:
      return { isCorrect: false, error: 'unknown_task_type' };
  }
}

const VALID_TYPES = ['choice_single', 'choice_multiple', 'open_text', 'open_number', 'matching', 'cloze'];

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
    if (t.type === 'choice_single') {
      if (!Array.isArray(t.options) || t.options.length < 2)
        errors.push(`tasks[${i}]: нужно минимум 2 "options"`);
      if (typeof t.correctIndex !== 'number')
        errors.push(`tasks[${i}]: нужно числовое "correctIndex"`);
    }
    if (t.type === 'choice_multiple') {
      if (!Array.isArray(t.options) || t.options.length < 2)
        errors.push(`tasks[${i}]: нужно минимум 2 "options"`);
      if (!Array.isArray(t.correctIndices) || t.correctIndices.length === 0)
        errors.push(`tasks[${i}]: нужен непустой массив "correctIndices"`);
    }
    if (t.type === 'open_text' && !t.needsManualReview) {
      if (!Array.isArray(t.acceptedAnswers) || t.acceptedAnswers.length === 0)
        errors.push(`tasks[${i}]: нужен непустой массив "acceptedAnswers" (или needsManualReview:true)`);
    }
    if (t.type === 'open_number') {
      if (typeof t.correctValue !== 'number')
        errors.push(`tasks[${i}]: нужно числовое "correctValue"`);
    }
    if (t.type === 'matching') {
      if (!Array.isArray(t.left) || !Array.isArray(t.right))
        errors.push(`tasks[${i}]: нужны массивы "left" и "right"`);
      if (!Array.isArray(t.correctPairs) || t.correctPairs.length === 0)
        errors.push(`tasks[${i}]: нужен непустой массив "correctPairs"`);
    }
    if (t.type === 'cloze') {
      if (!t.promptTemplate) errors.push(`tasks[${i}]: нужно "promptTemplate" с ___ на месте пропусков`);
      if (!Array.isArray(t.blanks) || t.blanks.length === 0)
        errors.push(`tasks[${i}]: нужен непустой массив "blanks"`);
    }
    // объяснение обязательно для всех автопроверяемых заданий - показывается при исчерпании попыток
    if (!t.needsManualReview && (!t.explanation || !String(t.explanation).trim())) {
      errors.push(`tasks[${i}]: нужно непустое поле "explanation" (кроме заданий с needsManualReview:true)`);
    }
  });
  return errors;
}

module.exports = { gradeTask, validateAssignment, VALID_TYPES };
