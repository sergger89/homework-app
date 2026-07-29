// Проверка ответа ребёнка против правильного ответа, в зависимости от типа задания.
// task = { type, ...данные с правильными ответами }
// answer = то, что прислал ребёнок (структура зависит от типа)

// ---------- нормализация вариантов ответа (сокращения, пунктуация, брит./амер. английский) ----------
// Идея: и ответ ребёнка, и каждый вариант из acceptedAnswers прогоняются через одну и ту же
// функцию, поэтому "didn't" и "did not" всегда схлопываются в одну и ту же каноническую форму,
// независимо от того, какой из вариантов был указан в задании, а какой ввёл ребёнок.

const CONTRACTIONS = {
  "don't": "do not", "doesn't": "does not", "didn't": "did not",
  "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
  "won't": "will not", "wouldn't": "would not", "can't": "cannot", "couldn't": "could not",
  "shouldn't": "should not", "mustn't": "must not", "haven't": "have not", "hasn't": "has not",
  "hadn't": "had not", "i'm": "i am", "you're": "you are", "he's": "he is", "she's": "she is",
  "it's": "it is", "we're": "we are", "they're": "they are", "i've": "i have",
  "you've": "you have", "we've": "we have", "they've": "they have", "i'll": "i will",
  "you'll": "you will", "he'll": "he will", "she'll": "she will", "we'll": "we will",
  "they'll": "they will", "i'd": "i would", "you'd": "you would", "let's": "let us",
  "that's": "that is", "there's": "there is", "what's": "what is", "who's": "who is",
};

// Частые британские написания -> американские (канонический вариант для сравнения).
// Список не исчерпывающий, а покрывает слова, реально встречающиеся в школьных заданиях.
const BRITISH_TO_AMERICAN = {
  colour: 'color', colours: 'colors', favourite: 'favorite', favourites: 'favorites',
  grey: 'gray', neighbour: 'neighbor', neighbours: 'neighbors', honour: 'honor',
  behaviour: 'behavior', labour: 'labor', humour: 'humor', rumour: 'rumor',
  centre: 'center', centres: 'centers', theatre: 'theater', theatres: 'theaters',
  litre: 'liter', litres: 'liters', metre: 'meter', metres: 'meters',
  realise: 'realize', realised: 'realized', realising: 'realizing',
  organise: 'organize', organised: 'organized', organising: 'organizing',
  organisation: 'organization', apologise: 'apologize', apologised: 'apologized',
  recognise: 'recognize', recognised: 'recognized', practise: 'practice',
  defence: 'defense', licence: 'license', programme: 'program', programmes: 'programs',
  travelled: 'traveled', travelling: 'traveling', traveller: 'traveler',
  cancelled: 'canceled', cancelling: 'canceling', jewellery: 'jewelry',
  tyre: 'tire', tyres: 'tires', cheque: 'check', cheques: 'checks', mum: 'mom', mummy: 'mommy',
};

function normalizeVariants(raw) {
  let s = String(raw ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'") // разные виды апострофа -> обычный
    .trim();

  // "can not" (раздельно) -> "cannot", чтобы совпадало с "can't"
  s = s.replace(/\bcan\s+not\b/g, 'cannot');

  // раскрываем сокращения по границам слов (апострофы уже приведены к обычному виду выше)
  for (const [short, full] of Object.entries(CONTRACTIONS)) {
    s = s.replace(new RegExp(`\\b${short}\\b`, 'g'), full);
  }

  // британское -> американское написание, по целым словам
  s = s.replace(/[a-z]+/g, (word) => BRITISH_TO_AMERICAN[word] || word);

  // убираем пунктуацию по краям строки (точки, запятые, кавычки и т.п.), а не только пробелы
  s = s.replace(/^[\s.,!?;:'"()«»…-]+|[\s.,!?;:'"()«»…-]+$/g, '');

  return s.replace(/\s+/g, ' ').trim();
}

function normalizeText(s) {
  return normalizeVariants(s);
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
