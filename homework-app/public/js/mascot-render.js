// ==================== Анимированный слоистый маскот ====================
// Заменяет старую систему "один плоский стикер на эмоцию" на композицию
// из отдельных слоёв (поза + глаза + рот + румянец + эффект), собранную
// на основе стикерпака через отдельные генерации в Nano Banana / ChatGPT.
// Все числа ниже - результат прямых измерений соответствующих PNG (см.
// историю разработки), а не подобраны на глаз.

const MASCOT_LAYER_PATH = '/mascot-layers/';

// измерено программно на самих файлах glaz/рта - см. предыдущие итерации
const MASCOT_EYES_CONTENT_RATIO = 0.343;   // видимая ширина глаз / ширина канваса eyes_*.png
const MASCOT_MOUTH_CONTENT_RATIO = 0.482;  // видимая ширина рта / ширина канваса mouth_*.png
const MASCOT_EYES_TO_FACE_RATIO = 0.60;
const MASCOT_MOUTH_TO_FACE_RATIO = 0.40;
const MASCOT_EYE_LEFT_PCT = 40.6, MASCOT_EYE_RIGHT_PCT = 59.6; // положение глаз внутри eyes_*.png

// границы лицевого овала и соотношение сторон канваса для каждой позы (измерено)
const MASCOT_POSE_ANCHORS = {
  pose_neutral:     { canvasW: 364, canvasH: 425, cx: 49.5, faceTop: 35.1, faceBottom: 65.6, faceW: 64.3 },
  pose_waving:      { canvasW: 392, canvasH: 393, cx: 53.6, faceTop: 33.8, faceBottom: 64.1, faceW: 58.2 },
  pose_shy_hopeful: { canvasW: 353, canvasH: 393, cx: 47.7, faceTop: 35.6, faceBottom: 67.4, faceW: 62.0 },
  pose_celebrating: { canvasW: 460, canvasH: 425, cx: 49.9, faceTop: 35.0, faceBottom: 65.0, faceW: 51.0 },
};

// доля от ширины КАНВАСА ПОЗЫ (не лица) и вертикальная позиция для каждого эффекта
const MASCOT_EFFECT_SETTINGS = {
  effect_sparkles: { widthFrac: 0.30, cyFrac: -0.02, cxOffsetFrac: 0.55 },
  effect_heart:    { widthFrac: 0.24, cyFrac: 0.10, cxOffsetFrac: 0.32 },
  effect_anger:    { widthFrac: 0.16, cyFrac: -0.06, cxOffsetFrac: -0.30 },
};

// Перевод старого словаря эмоций (12 плоских стикеров) в новую комбинацию слоёв.
// Это позволяет не переписывать все места вызова по всему приложению - они
// по-прежнему передают старые ключи ('joy', 'sadness' и т.п.), а здесь эти
// ключи превращаются в конкретный набор pose+eyes+mouth+blush+effect.
const MASCOT_EMOTION_MAP = {
  joy:           { pose: 'pose_celebrating',  eyes: 'eyes_happy',     mouth: 'mouth_smile',       blush: 'blush_soft',   effect: 'effect_sparkles' },
  fun:           { pose: 'pose_waving',       eyes: 'eyes_happy',     mouth: 'mouth_smile',       blush: 'blush_soft',   effect: 'effect_sparkles' },
  admiration:    { pose: 'pose_celebrating',  eyes: 'eyes_surprised', mouth: 'mouth_smile',       blush: 'blush_soft',   effect: 'effect_sparkles' },
  surprise:      { pose: 'pose_waving',       eyes: 'eyes_surprised', mouth: 'mouth_surprised',   blush: null,           effect: null },
  horror:        { pose: 'pose_shy_hopeful',  eyes: 'eyes_surprised', mouth: 'mouth_surprised',   blush: null,           effect: null },
  sadness:       { pose: 'pose_shy_hopeful',  eyes: 'eyes_sad',       mouth: 'mouth_sad',         blush: null,           effect: 'effect_tears' },
  disappointment:{ pose: 'pose_neutral',      eyes: 'eyes_sad',       mouth: 'mouth_sad',         blush: null,           effect: null },
  anger:         { pose: 'pose_neutral',      eyes: 'eyes_angry',     mouth: 'mouth_sad',         blush: null,           effect: 'effect_anger' },
  disgust:       { pose: 'pose_neutral',      eyes: 'eyes_angry',     mouth: 'mouth_sad',         blush: null,           effect: null },
  kiss:          { pose: 'pose_shy_hopeful',  eyes: 'eyes_blink',     mouth: 'mouth_light_smile', blush: 'blush_strong', effect: 'effect_heart' },
  wink:          { pose: 'pose_neutral',      eyes: 'eyes_blink',     mouth: 'mouth_light_smile', blush: 'blush_soft',   effect: null },
  boredom:       { pose: 'pose_neutral',      eyes: 'eyes_blink',     mouth: 'mouth_neutral',     blush: null,           effect: null },
};
// глаза, которые считаются "открытыми" - только для них имеет смысл случайное моргание
const MASCOT_OPEN_EYES = new Set(['eyes_neutral', 'eyes_surprised', 'eyes_sad', 'eyes_angry']);

function mascotLayerUrl(key) {
  return MASCOT_LAYER_PATH + key + '.png';
}

function mascotExpressionFor(emotionKey) {
  return MASCOT_EMOTION_MAP[emotionKey] || MASCOT_EMOTION_MAP.boredom;
}

// строит (или пересобирает) слои внутри containerEl под конкретную эмоцию.
// containerEl должен иметь заданный через CSS размер (position:relative, ширина/высота).
function renderMascotAnimated(containerEl, emotionKey) {
  const expr = mascotExpressionFor(emotionKey);
  containerEl.dataset.mascotEmotion = emotionKey;
  containerEl.innerHTML = `
    <img class="mascot-l-pose" alt="" />
    <img class="mascot-l-blush" alt="" style="display:none" />
    <img class="mascot-l-eyes" alt="" />
    <img class="mascot-l-mouth" alt="" />
    <img class="mascot-l-effect" alt="" style="display:none" />
    <img class="mascot-l-tear-left" alt="" style="display:none" />
    <img class="mascot-l-tear-right" alt="" style="display:none" />
  `;
  const els = {
    pose: containerEl.querySelector('.mascot-l-pose'),
    blush: containerEl.querySelector('.mascot-l-blush'),
    eyes: containerEl.querySelector('.mascot-l-eyes'),
    mouth: containerEl.querySelector('.mascot-l-mouth'),
    effect: containerEl.querySelector('.mascot-l-effect'),
    tearLeft: containerEl.querySelector('.mascot-l-tear-left'),
    tearRight: containerEl.querySelector('.mascot-l-tear-right'),
  };
  els.pose.src = mascotLayerUrl(expr.pose);
  els.eyes.src = mascotLayerUrl(expr.eyes);
  els.mouth.src = mascotLayerUrl(expr.mouth);

  const a = MASCOT_POSE_ANCHORS[expr.pose] || MASCOT_POSE_ANCHORS.pose_neutral;
  const stageW = containerEl.clientWidth, stageH = containerEl.clientHeight;
  const poseAspect = a.canvasW / a.canvasH;
  const renderedPoseWidthPx = stageH * poseAspect;
  const poseLeftPx = (stageW - renderedPoseWidthPx) / 2;
  const faceH = a.faceBottom - a.faceTop;

  function xPercentInStage(cxPctOfPose) {
    const px = poseLeftPx + (cxPctOfPose / 100) * renderedPoseWidthPx;
    return px / stageW * 100;
  }
  function widthPercentInStage(fractionOfPoseWidth) {
    return (fractionOfPoseWidth * renderedPoseWidthPx) / stageW * 100;
  }

  const eyesVisibleWidthFrac = (a.faceW / 100) * MASCOT_EYES_TO_FACE_RATIO;
  const mouthVisibleWidthFrac = (a.faceW / 100) * MASCOT_MOUTH_TO_FACE_RATIO;
  const eyesCssWidthPct = widthPercentInStage(eyesVisibleWidthFrac / MASCOT_EYES_CONTENT_RATIO);
  const mouthCssWidthPct = widthPercentInStage(mouthVisibleWidthFrac / MASCOT_MOUTH_CONTENT_RATIO);

  els.eyes.style.left = xPercentInStage(a.cx) + '%';
  els.eyes.style.top = (a.faceTop + 0.38 * faceH) + '%';
  els.eyes.style.width = eyesCssWidthPct + '%';

  els.mouth.style.left = xPercentInStage(a.cx) + '%';
  els.mouth.style.top = (a.faceTop + 0.78 * faceH) + '%';
  els.mouth.style.width = mouthCssWidthPct + '%';

  if (expr.blush) {
    els.blush.src = mascotLayerUrl(expr.blush);
    els.blush.style.display = 'block';
    els.blush.style.left = xPercentInStage(a.cx) + '%';
    els.blush.style.top = (a.faceTop + 0.55 * faceH) + '%';
    els.blush.style.width = widthPercentInStage(a.faceW / 100 * 0.55) + '%';
  }

  if (expr.effect === 'effect_tears') {
    const eyesLeftEdgeStagePx = poseLeftPx + ((a.cx - eyesVisibleWidthFrac * 100 / 2) / 100) * renderedPoseWidthPx;
    const eyesRenderedWidthPx = eyesVisibleWidthFrac * renderedPoseWidthPx;
    const tearY = a.faceTop + 0.648 * faceH;
    const tearWidthPct = (eyesVisibleWidthFrac * 0.20 * renderedPoseWidthPx / stageW) * 100;
    els.tearLeft.src = mascotLayerUrl('effect_tear_left');
    els.tearRight.src = mascotLayerUrl('effect_tear_right');
    [els.tearLeft, els.tearRight].forEach((el, i) => {
      const xPct = i === 0 ? MASCOT_EYE_LEFT_PCT : MASCOT_EYE_RIGHT_PCT;
      el.style.display = 'block';
      el.style.left = ((eyesLeftEdgeStagePx + (xPct / 100) * eyesRenderedWidthPx) / stageW * 100) + '%';
      el.style.top = tearY + '%';
      el.style.width = tearWidthPct + '%';
    });
  } else if (expr.effect) {
    const s = MASCOT_EFFECT_SETTINGS[expr.effect];
    if (s) {
      els.effect.src = mascotLayerUrl(expr.effect);
      els.effect.style.display = 'block';
      const cxOffsetPct = (s.cxOffsetFrac || 0) * a.faceW;
      els.effect.style.left = xPercentInStage(a.cx + cxOffsetPct) + '%';
      els.effect.style.top = (a.faceTop + s.cyFrac * faceH) + '%';
      els.effect.style.width = widthPercentInStage(s.widthFrac) + '%';
    }
  }
  return els;
}

// плавная подмена эмоции с анимацией "pop" на изменившихся слоях
function updateMascotAnimated(containerEl, emotionKey) {
  renderMascotAnimated(containerEl, emotionKey);
  containerEl.querySelectorAll('img').forEach((el) => {
    el.classList.remove('mascot-pop');
    void el.offsetWidth;
    el.classList.add('mascot-pop');
  });
}

function preloadMascotLayerImages() {
  if (window.__mascotLayersPreloaded) return;
  window.__mascotLayersPreloaded = true;
  ['pose_neutral', 'pose_celebrating', 'pose_waving', 'pose_shy_hopeful',
   'eyes_neutral', 'eyes_blink', 'eyes_happy', 'eyes_surprised', 'eyes_sad', 'eyes_angry',
   'mouth_neutral', 'mouth_talking', 'mouth_smile', 'mouth_sad', 'mouth_surprised', 'mouth_light_smile',
   'blush_soft', 'blush_strong',
   'effect_sparkles', 'effect_heart', 'effect_anger', 'effect_tear_left', 'effect_tear_right',
  ].forEach((k) => { const img = new Image(); img.src = mascotLayerUrl(k); });
}
