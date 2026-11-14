// ムービー・モーションキャプチャ
// 練習動画から先生と初心者の骨格を検出し、骨格つき動画（MP4）と骨格データ（CSV）を書き出す。
// 処理はすべてブラウザの中で行い、動画はどこにも送らない。
import { PoseLandmarker, FaceLandmarker } from './lib/vision_bundle.mjs';
import { Muxer, ArrayBufferTarget } from './lib/mp4-muxer.mjs';

const APP_VERSION = 'v2';
// 分析用Artifact「ダンス練習分析」のURL。作ったらここに入れる（空のあいだはコピーだけ行う）
const ANALYSIS_URL = 'https://claude.ai/artifact/M5aJy3Tk7ZBjCZ2r7NHmX9';
const MEDIAPIPE_VERSION = 'tasks-vision 0.10.14';

const $ = (id) => document.getElementById(id);

// 動画に焼き込む色（画面のテーマに関係なく固定）
const COLOR = { teacher: '#3D7BFF', beginner: '#FF7A1A', hip: '#FFA21F', mark: '#FFFFFF', low: 'rgba(150,158,167,0.8)', other: 'rgba(255,255,255,0.85)' };
const VIS_MIN = 0.5;   // これ未満の点は「AIの自信が低い」として灰色で描く
const SPEED_LABEL = { 0.25: '1/4倍速', 0.5: '1/2倍速', 1: '等倍', 2: '2倍速' };
const TARGET_LABEL = { both: '2人', teacher: '先生のみ', beginner: '初心者のみ' };

// 骨格AIの33点のあとに、頭の2点を足して持つ
//   33 顎先：顔用AI（Face Landmarker）の顎先の点
//   34 頭頂部：顎先と額の上端から推定（AIの点ではない）
// 顔用AIが顔を見つけられないコマは、骨格AIの目と口から両方を推定し、自信を 0.4（灰色）にする
const CHIN = 33, HEAD_TOP = 34, NPTS = 35;
const HEAD_TOP_RATIO = 1.3; // 顎先→額の上端 の長さを1.3倍すると、おおよそ頭頂部に届く
const ESTIMATED_VIS = 0.4;

// CSVに書き出す点
const POINTS = {
  head_top: HEAD_TOP, chin: CHIN,
  nose: 0, left_ear: 7, right_ear: 8,
  left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14, left_wrist: 15, right_wrist: 16,
  left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26, left_ankle: 27, right_ankle: 28,
  left_heel: 29, right_heel: 30, left_foot_index: 31, right_foot_index: 32,
};
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];
// 丸を描く点。31・32 はAIの「つま先」（foot_index）で、靴の先にあたる
const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];

const state = {
  file: null, name: '', url: null,
  duration: 0, vw: 0, vh: 0, outW: 0, outH: 0,
  start: 0, end: 0, speed: 0.5, model: 'full', fps: 30, target: 'both',
  landmarker: null, landmarkerModel: null, delegate: '', face: null,
  pickPoses: [], pickOriginal: [], teacherIdx: null, beginnerIdx: null, edited: false,
  frames: [],   // { t, A, B, overlap }  A = 先生として選んだ人、B = 初心者として選んだ人（対象外はnull）
  videoBlob: null, csvBlob: null, csvText: '',
  busy: false,
};
window.__mmc = state; // 動作確認用

const video = $('video');     // 解析用（画面には出さない）
const preview = $('preview'); // 設定用のプレビュー

// ---------- 画面の状態 ----------
const STEPS = ['step-file', 'step-settings', 'step-pick', 'step-analyze', 'step-export'];
// 解析する対象に先生・初心者が入っているか
const needT = () => state.target !== 'beginner';
const needB = () => state.target !== 'teacher';
const pickReady = () => (!needT() || state.teacherIdx !== null) && (!needB() || state.beginnerIdx !== null);
const pickedIdx = () => [needT() ? state.teacherIdx : null, needB() ? state.beginnerIdx : null].filter((i) => i !== null);
function setStep(id, s) { $(id).dataset.state = s; }
function lockFrom(id) {
  for (const s of STEPS.slice(STEPS.indexOf(id))) setStep(s, 'locked');
}
function message(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* 使えない端末では何もしない */ }
}

// ---------- 動画 ----------
function once(el, ok, ng = 'error', ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error('timeout')); }, ms);
    const onOk = () => { clean(); resolve(); };
    const onNg = () => { clean(); reject(new Error(ng)); };
    function clean() { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener(ng, onNg); }
    el.addEventListener(ok, onOk);
    el.addEventListener(ng, onNg);
  });
}

// 指定の時刻へ移動し、そのコマが描ける状態になるまで待つ
function seekTo(v, t) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; v.removeEventListener('seeked', onSeeked); clearTimeout(guard); resolve(); } };
    const onSeeked = () => {
      if (v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback(() => finish());
        setTimeout(finish, 150);
      } else {
        finish();
      }
    };
    const guard = setTimeout(finish, 4000);
    v.addEventListener('seeked', onSeeked);
    v.currentTime = Math.max(0, Math.min(t, v.duration - 0.001));
  });
}

async function handleFile(file) {
  if (!file) return;
  state.file = file;
  state.name = file.name || 'video';
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  lockFrom('step-settings');
  message('file-info', '動画を読み込んでいます…');
  try {
    video.src = state.url;
    preview.src = state.url;
    video.load();
    await once(video, 'loadeddata');
  } catch {
    message('file-info', 'この動画は開けませんでした。別の動画を選んでください。', true);
    return;
  }
  state.duration = video.duration;
  state.vw = video.videoWidth;
  state.vh = video.videoHeight;
  // 書き出しサイズ：短い辺を最大720、長い辺を最大1280に縮める（偶数にそろえる）
  const scale = Math.min(1, 720 / Math.min(state.vw, state.vh), 1280 / Math.max(state.vw, state.vh));
  state.outW = Math.max(2, Math.round(state.vw * scale / 2) * 2);
  state.outH = Math.max(2, Math.round(state.vh * scale / 2) * 2);

  $('start').value = '0';
  $('end').value = (Math.floor(state.duration * 10) / 10).toFixed(1);
  $('start').max = $('end').max = state.duration.toFixed(1);
  const long = state.duration > 60 ? '　1分を超えています。解析する範囲を短くするのがおすすめです。' : '';
  message('file-info', `${state.name}（${state.duration.toFixed(1)}秒・${state.vw}×${state.vh}）${long}`);
  setStep('step-file', 'done');
  setStep('step-settings', 'active');
}

$('file').addEventListener('change', (e) => handleFile(e.target.files[0]));
$('start-here').addEventListener('click', () => { $('start').value = preview.currentTime.toFixed(1); invalidate(); });
$('end-here').addEventListener('click', () => { $('end').value = preview.currentTime.toFixed(1); invalidate(); });
for (const id of ['start', 'end', 'speed', 'model', 'fps', 'target']) $(id).addEventListener('change', invalidate);
// 分析つき動画は2人のときだけ選べる
function syncVideoKind() {
  const both = $('target').value === 'both';
  $('video-kind').querySelector('option[value="analysis"]').disabled = !both;
  if (!both) $('video-kind').value = 'skeleton';
}
$('target').addEventListener('change', syncVideoKind);
syncVideoKind();
// マークの大きさは描き方だけなので、解析はやり直さずに描き直す
$('mark').addEventListener('change', () => {
  if (state.pickPoses.length && $('step-pick').dataset.state === 'active') drawPick();
});

// 設定を変えたら、それより後のステップはやり直し
function invalidate() {
  if (state.busy) return;
  if ($('step-pick').dataset.state !== 'locked') {
    lockFrom('step-pick');
    setStep('step-settings', 'active');
  }
}

function readSettings() {
  const start = Number($('start').value);
  const end = Number($('end').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > state.duration + 0.05 || end - start < 0.5) {
    throw new Error(`開始と終了は 0〜${state.duration.toFixed(1)} 秒の間で、0.5秒以上あけてください。`);
  }
  state.start = start;
  state.end = Math.min(end, state.duration);
  state.speed = Number($('speed').value);
  state.model = $('model').value;
  state.fps = Number($('fps').value);
  state.target = $('target').value;
}

// ---------- 骨格検出（MediaPipe Pose） ----------
const asset = (p) => new URL(p, location.href).href;

async function getLandmarker(model, forceCpu = false) {
  if (state.landmarker && state.landmarkerModel === model && !forceCpu) return state.landmarker;
  state.landmarker?.close();
  state.landmarker = null;
  const fileset = {
    wasmLoaderPath: asset('lib/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: asset('lib/wasm/vision_wasm_internal.wasm'),
  };
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: asset(`lib/models/pose_landmarker_${model}.task`), delegate },
    runningMode: 'IMAGE', // 切り出す範囲が毎回変わるので、コマごとに独立して検出する
    numPoses: 2,
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  let lm = null;
  if (!forceCpu) {
    try { lm = await PoseLandmarker.createFromOptions(fileset, options('GPU')); state.delegate = 'GPU'; } catch { lm = null; }
  }
  if (!lm) { lm = await PoseLandmarker.createFromOptions(fileset, options('CPU')); state.delegate = 'CPU'; }
  state.landmarker = lm;
  state.landmarkerModel = model;
  return lm;
}

// 1人分の点を [x, y, 自信] ×35 の配列にまとめる（x, y は 0〜1）。頭の2点はあとで addHead が埋める
function pack(landmarks) {
  const a = new Float32Array(NPTS * 3);
  landmarks.forEach((p, i) => { a[i * 3] = p.x; a[i * 3 + 1] = p.y; a[i * 3 + 2] = p.visibility ?? 1; });
  return a;
}

// ---------- 顔（顎先・頭頂部） ----------
async function getFaceLandmarker() {
  if (state.face) return state.face;
  const fileset = {
    wasmLoaderPath: asset('lib/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: asset('lib/wasm/vision_wasm_internal.wasm'),
  };
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: asset('lib/models/face_landmarker.task'), delegate },
    runningMode: 'IMAGE',
    numFaces: 1,
    minFaceDetectionConfidence: 0.3,
    minFacePresenceConfidence: 0.3,
  });
  try { state.face = await FaceLandmarker.createFromOptions(fileset, options('GPU')); } catch { state.face = null; }
  if (!state.face) state.face = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
  return state.face;
}

const FACE = 256;
const faceCanvas = document.createElement('canvas');
faceCanvas.width = faceCanvas.height = FACE;

// 顔用AIが顔を見つけられないときの推定。目の真ん中 e → 口の真ん中 m を u とし、
// u とそれに直交する向き n を物差しにして、顎先は m から、頭頂部は e からの位置で表す。
// 最初は大人の顔の一般的な比率を使い、解析後にその人の「顔が見つかったコマ」から測った比率で直す
const HEAD_RATIO_DEFAULT = { ca: 0.7, cb: 0, ta: -1.65, tb: 0 };

function faceFrame(p) {
  const P = (i) => px(p, i);
  if (Math.min(P(2).v, P(5).v, P(9).v, P(10).v) < 0.3) return null;
  const e = { x: (P(2).x + P(5).x) / 2, y: (P(2).y + P(5).y) / 2 };
  const m = { x: (P(9).x + P(10).x) / 2, y: (P(9).y + P(10).y) / 2 };
  const u = { x: m.x - e.x, y: m.y - e.y };
  if (Math.hypot(u.x, u.y) < 1) return null;
  return { e, m, u, n: { x: -u.y, y: u.x } };
}

function estimateHead(p, k = HEAD_RATIO_DEFAULT) {
  const f = faceFrame(p);
  if (!f) return;
  const { e, m, u, n } = f;
  p[CHIN * 3] = (m.x + u.x * k.ca + n.x * k.cb) / state.vw;
  p[CHIN * 3 + 1] = (m.y + u.y * k.ca + n.y * k.cb) / state.vh;
  p[HEAD_TOP * 3] = (e.x + u.x * k.ta + n.x * k.tb) / state.vw;
  p[HEAD_TOP * 3 + 1] = (e.y + u.y * k.ta + n.y * k.tb) / state.vh;
  p[CHIN * 3 + 2] = p[HEAD_TOP * 3 + 2] = ESTIMATED_VIS;
}

// 同じ人の「顔が見つかったコマ」から比率を測り（中央値）、推定したコマを測った比率で直す
function calibrateHeads(role) {
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const samples = { ca: [], cb: [], ta: [], tb: [] };
  for (const fr of state.frames) {
    const p = fr[role];
    if (!p || p[CHIN * 3 + 2] < 0.99) continue;
    const f = faceFrame(p);
    if (!f) continue;
    const L = f.u.x ** 2 + f.u.y ** 2;
    const c = { x: p[CHIN * 3] * state.vw - f.m.x, y: p[CHIN * 3 + 1] * state.vh - f.m.y };
    const t = { x: p[HEAD_TOP * 3] * state.vw - f.e.x, y: p[HEAD_TOP * 3 + 1] * state.vh - f.e.y };
    samples.ca.push((c.x * f.u.x + c.y * f.u.y) / L); samples.cb.push((c.x * f.n.x + c.y * f.n.y) / L);
    samples.ta.push((t.x * f.u.x + t.y * f.u.y) / L); samples.tb.push((t.x * f.n.x + t.y * f.n.y) / L);
  }
  if (samples.ca.length < 5) return null; // 顔が見つかったコマが少なすぎるときは一般的な比率のまま
  const k = { ca: median(samples.ca), cb: median(samples.cb), ta: median(samples.ta), tb: median(samples.tb) };
  for (const fr of state.frames) {
    const p = fr[role];
    if (p && Math.abs(p[CHIN * 3 + 2] - ESTIMATED_VIS) < 1e-3) estimateHead(p, k);
  }
  return samples.ca.length;
}

// 骨格の鼻・耳の位置から顔のまわりを切り出し、顔用AIで顎先と額の上端を探す
async function addHead(p) {
  const P = (i) => px(p, i);
  p[CHIN * 3 + 2] = p[HEAD_TOP * 3 + 2] = 0;
  const nose = P(0);
  if (nose.v < 0.3 || !state.face) { estimateHead(p); return p; }

  const ear = Math.hypot(P(7).x - P(8).x, P(7).y - P(8).y);
  const shoulder = Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y);
  const side = Math.max(ear * 2.6, shoulder * 0.8, 40);
  const x0 = nose.x - side / 2, y0 = nose.y - side * 0.55;
  const ctx = faceCanvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, FACE, FACE);
  ctx.drawImage(video, x0, y0, side, side, 0, 0, FACE, FACE);
  let lm;
  try { lm = state.face.detect(faceCanvas).faceLandmarks[0]; } catch { lm = null; }
  if (!lm) { estimateHead(p); return p; }
  const toFrame = (q) => ({ x: (x0 + q.x * side) / state.vw, y: (y0 + q.y * side) / state.vh });
  const chin = toFrame(lm[152]), brow = toFrame(lm[10]); // 152 = 顎先、10 = 額の上端
  // 見つけた顔が、この人の鼻の近くでなければ使わない（隣の人の顔を拾うのを防ぐ）
  const faceNose = toFrame(lm[1]);
  if (Math.hypot((faceNose.x - p[0]) * state.vw, (faceNose.y - p[1]) * state.vh) > ear * 0.8 + 6) { estimateHead(p); return p; }
  p[CHIN * 3] = chin.x; p[CHIN * 3 + 1] = chin.y; p[CHIN * 3 + 2] = 1;
  p[HEAD_TOP * 3] = chin.x + (brow.x - chin.x) * HEAD_TOP_RATIO;
  p[HEAD_TOP * 3 + 1] = chin.y + (brow.y - chin.y) * HEAD_TOP_RATIO;
  p[HEAD_TOP * 3 + 2] = 1;
  return p;
}

async function detect(src) {
  try {
    return state.landmarker.detect(src).landmarks.map(pack);
  } catch (e) {
    if (state.delegate !== 'GPU') throw e;
    await getLandmarker(state.model, true); // GPUで失敗したらCPUでやり直す
    return state.landmarker.detect(src).landmarks.map(pack);
  }
}

// 画面全体だと、遠い人・暗い服の人を見落とすことがある。
// そこで範囲を切り出し、正方形に拡大してから検出する（座標は画面全体の 0〜1 に戻す）
const CROP = 512;
const cropCanvas = document.createElement('canvas');
cropCanvas.width = cropCanvas.height = CROP;

async function detectRegion(x0, y0, w, h) {
  const ctx = cropCanvas.getContext('2d');
  const s = CROP / Math.max(w, h);
  const ox = (CROP - w * s) / 2, oy = (CROP - h * s) / 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CROP, CROP);
  ctx.drawImage(video, x0, y0, w, h, ox, oy, w * s, h * s);
  const poses = await detect(cropCanvas);
  for (const p of poses) {
    for (let i = 0; i < 33; i++) {
      p[i * 3] = (x0 + (p[i * 3] * CROP - ox) / s) / state.vw;
      p[i * 3 + 1] = (y0 + (p[i * 3 + 1] * CROP - oy) / s) / state.vh;
    }
  }
  return poses;
}

// 中心 c（0〜1）、幅 w・高さ h（ピクセル）の範囲を、画面からはみ出さないように切り出して検出
function detectAround(c, size) {
  const w = Math.min(size.w, state.vw), h = Math.min(size.h, state.vh);
  const x0 = Math.max(0, Math.min(state.vw - w, c.x * state.vw - w / 2));
  const y0 = Math.max(0, Math.min(state.vh - h, c.y * state.vh - h / 2));
  return detectRegion(x0, y0, w, h);
}

// その人の形に合わせた切り出しの大きさ（ピクセル）。
// 広すぎると隣の人が入り、見落としや取り違えが起きるので、立った人に合わせて縦長にする
// 自信の低い点も含めて範囲を決める。自信のある点だけで決めると、足首の自信が下がったときに
// 足元が範囲から外れ、さらに自信が下がる悪循環になる
function cropSize(p, last) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < 33; i++) {
    x0 = Math.min(x0, p[i * 3]); x1 = Math.max(x1, p[i * 3]);
    y0 = Math.min(y0, p[i * 3 + 1]); y1 = Math.max(y1, p[i * 3 + 1]);
  }
  const bw = (x1 - x0) * state.vw, bh = (y1 - y0) * state.vh;
  const min = Math.min(state.vw, state.vh) * 0.3;
  const size = { w: Math.max(bw * 2, bh * 0.8, min), h: Math.max(bh * 1.35, bw * 1.2, min) };
  // 人の大きさは急には縮まないので、前のコマの大きさから少しずつしか小さくしない
  if (last) { size.w = Math.max(size.w, last.w * 0.97); size.h = Math.max(size.h, last.h * 0.97); }
  return size;
}

const meanVis = (p) => { let s = 0; for (let i = 0; i < 33; i++) s += p[i * 3 + 2]; return s / 33; };

// 画面全体と、横（縦長の動画なら縦）にずらした範囲で人を探し、同じ人をまとめる
async function findPeople() {
  const { vw, vh } = state;
  const found = await detectRegion(0, 0, vw, vh);
  const side = Math.min(vw, vh);
  const long = Math.max(vw, vh);
  for (let pos = 0; ; pos += side / 3) {
    const p0 = Math.min(pos, long - side);
    found.push(...(vw >= vh ? await detectRegion(p0, 0, side, side) : await detectRegion(0, p0, side, side)));
    if (p0 >= long - side) break;
  }
  const people = [];
  for (const p of found.sort((a, b) => meanVis(b) - meanVis(a))) {
    if (!people.some((q) => dist(center(q), center(p)) < 0.06)) people.push(p);
  }
  return people.sort((a, b) => center(a).x - center(b).x);
}

const px = (p, i) => ({ x: p[i * 3] * state.vw, y: p[i * 3 + 1] * state.vh, v: p[i * 3 + 2] });

function center(p) {
  let x = 0, y = 0, n = 0;
  for (const i of [11, 12, 23, 24]) if (p[i * 3 + 2] > 0.3) { x += p[i * 3]; y += p[i * 3 + 1]; n++; }
  if (!n) for (let i = 0; i < 33; i++) { x += p[i * 3]; y += p[i * 3 + 1]; n++; }
  return { x: x / n, y: y / n };
}
function bbox(p) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < 33; i++) {
    if (p[i * 3 + 2] < 0.3) continue;
    x0 = Math.min(x0, p[i * 3]); x1 = Math.max(x1, p[i * 3]);
    y0 = Math.min(y0, p[i * 3 + 1]); y1 = Math.max(y1, p[i * 3 + 1]);
  }
  return { x0, y0, x1, y1 };
}
// 画面の縦横比を考えた距離（0〜1）
function dist(a, b) {
  const m = Math.max(state.vw, state.vh);
  return Math.hypot((a.x - b.x) * state.vw / m, (a.y - b.y) * state.vh / m);
}

// 前のコマの位置に一番近い人を同じ人とみなす。遠すぎる場合は「見失った」とする
const MISS = 0.18;
function nearest(poses, prev, avoid) {
  let best = null, bestD = MISS;
  for (const p of poses) {
    const c = center(p);
    if (avoid && dist(c, avoid) < 0.05) continue; // もう1人と同じ人は選ばない
    const d = dist(c, prev);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// 1人ずつ、前のコマの位置の周りを切り出して探す
const lastCrop = { A: null, B: null };
// 対象外の人（prev が null）は探さない
async function trackFrame(prevA, prevB) {
  let A = null, B = null;
  if (prevA) {
    lastCrop.A = cropSize(prevA, lastCrop.A);
    A = nearest(await detectAround(center(prevA), lastCrop.A), center(prevA), null);
  }
  if (prevB) {
    lastCrop.B = cropSize(prevB, lastCrop.B);
    B = nearest(await detectAround(center(prevB), lastCrop.B), center(prevB), A ? center(A) : null);
  }
  return { A, B };
}

// 2人が重なっていて、取り違えたおそれがあるか
function overlapping(A, B) {
  if (!A || !B) return false;
  if (dist(center(A), center(B)) < 0.08) return true;
  const a = bbox(A), b = bbox(B);
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return small > 0 && (iw * ih) / small > 0.35;
}

// ---------- 描画 ----------
function drawSkeleton(ctx, p, color) {
  if (!p) return;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  // マークの大きさ：小は細い線、大は太い線（設定で選ぶ）
  const lw = $('mark').value === 'large'
    ? Math.max(3, Math.round(Math.min(W, H) / 120))
    : Math.max(1.5, Math.min(W, H) / 300);
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  for (const [i, j] of BONES) {
    const vi = p[i * 3 + 2], vj = p[j * 3 + 2];
    if (vi < 0.05 || vj < 0.05) continue;
    ctx.strokeStyle = vi >= VIS_MIN && vj >= VIS_MIN ? color : COLOR.low;
    ctx.beginPath();
    ctx.moveTo(p[i * 3] * W, p[i * 3 + 1] * H);
    ctx.lineTo(p[j * 3] * W, p[j * 3 + 1] * H);
    ctx.stroke();
  }
  // 頭：頭頂部 → 顎先 → 両肩の真ん中 の線（頭と首の傾きが分かる）
  const hv = p[HEAD_TOP * 3 + 2], cv = p[CHIN * 3 + 2];
  const neck = { x: (p[33] + p[36]) / 2, y: (p[34] + p[37]) / 2, v: Math.min(p[35], p[38]) }; // 11・12番（両肩）の真ん中
  ctx.lineWidth = lw;
  const segment = (a, b, va, vb) => {
    if (va < 0.05 || vb < 0.05) return;
    ctx.strokeStyle = va >= VIS_MIN && vb >= VIS_MIN ? color : COLOR.low;
    ctx.beginPath();
    ctx.moveTo(a.x * W, a.y * H);
    ctx.lineTo(b.x * W, b.y * H);
    ctx.stroke();
  };
  const top = { x: p[HEAD_TOP * 3], y: p[HEAD_TOP * 3 + 1] }, chin = { x: p[CHIN * 3], y: p[CHIN * 3 + 1] };
  segment(top, chin, hv, cv);
  segment(chin, neck, cv, neck.v);
  // 頭頂部からまっすぐ下ろした点線（体の軸がどちらへ傾いているかの目安）。足元の高さまで引く
  if (hv >= 0.05) {
    let foot = 0;
    for (const i of [27, 28, 29, 30, 31, 32]) if (p[i * 3 + 2] >= 0.05) foot = Math.max(foot, p[i * 3 + 1]);
    if (foot > top.y) {
      ctx.save();
      ctx.setLineDash([lw * 3, lw * 2.5]);
      ctx.lineWidth = Math.max(1, lw * 0.8);
      ctx.strokeStyle = hv >= VIS_MIN ? color : COLOR.low;
      ctx.beginPath();
      ctx.moveTo(top.x * W, top.y * H);
      ctx.lineTo(top.x * W, foot * H);
      ctx.stroke();
      ctx.restore();
    }
  }
  // マーク（関節・頭頂部・鼻・顎先の丸）は線と同じ色で、白いふちを付ける。自信が低い点は灰色。線の上に重ねて描く
  const dots = [...JOINTS.map((i) => [i, 1.25]), [0, 1.4], [CHIN, 1.25], [HEAD_TOP, 1.25]];
  ctx.strokeStyle = COLOR.mark;
  ctx.lineWidth = Math.max(1, lw * 0.5);
  // 腰の中心（左右の腰の真ん中）：オレンジの丸
  const hipV = Math.min(p[23 * 3 + 2], p[24 * 3 + 2]);
  if (hipV >= 0.05) {
    ctx.fillStyle = hipV >= VIS_MIN ? COLOR.hip : COLOR.low;
    ctx.beginPath();
    ctx.arc(((p[69] + p[72]) / 2) * W, ((p[70] + p[73]) / 2) * H, lw * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  for (const [i, r] of dots) {
    const v = p[i * 3 + 2];
    if (v < 0.05) continue;
    ctx.fillStyle = v >= VIS_MIN ? color : COLOR.low;
    ctx.beginPath();
    ctx.arc(p[i * 3] * W, p[i * 3 + 1] * H, lw * r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function tag(ctx, text, x, y, bg) {
  const H = ctx.canvas.height, W = ctx.canvas.width;
  const fs = Math.max(12, Math.round(Math.min(W, H) / 26));
  ctx.font = `700 ${fs}px "BIZ UDPGothic", "Hiragino Sans", sans-serif`;
  const w = ctx.measureText(text).width + fs * 0.8, h = fs * 1.5;
  const bx = Math.min(Math.max(x - w / 2, 2), W - w - 2), by = Math.max(y - h, 2);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx, by, w, h, h / 3) : ctx.rect(bx, by, w, h);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + fs * 0.4, by + h / 2);
}

function personTag(ctx, p, text, color) {
  if (!p) return;
  const b = bbox(p);
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const top = p[HEAD_TOP * 3 + 2] >= 0.05 ? Math.min(b.y0, p[HEAD_TOP * 3 + 1]) : b.y0; // 頭頂部の点に札が重ならないように
  tag(ctx, text, ((b.x0 + b.x1) / 2) * W, top * H - Math.min(W, H) / 40, color);
}

function rolesOf(frame) {
  return { teacher: frame.A, beginner: frame.B };
}

function drawScene(ctx, frame, caption = true) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.drawImage(video, 0, 0, W, H);
  if (!frame) return;
  const r = rolesOf(frame);
  drawSkeleton(ctx, r.beginner, COLOR.beginner);
  drawSkeleton(ctx, r.teacher, COLOR.teacher);
  personTag(ctx, r.teacher, '先生', COLOR.teacher);
  personTag(ctx, r.beginner, '初心者', COLOR.beginner);
  if (caption) tag(ctx, `${SPEED_LABEL[state.speed] ?? `${state.speed}倍速`}　${frame.t.toFixed(1)}秒`, 0, Math.min(W, H) / 12, 'rgba(0,0,0,0.6)');
}

function frameAt(t) {
  if (!state.frames.length) return null;
  const i = Math.round((t - state.start) * state.fps);
  return state.frames[Math.max(0, Math.min(state.frames.length - 1, i))];
}

// ---------- 3. 人を選ぶ ----------
const pickCanvas = $('pick-canvas');

function pickPrompt() {
  const el = $('pick-prompt');
  el.classList.remove('error');
  const T = '<span class="t">先生</span>', B = '<span class="b">初心者</span>';
  const next = needT() && state.teacherIdx === null ? T : B;
  const want = state.target === 'both' ? 2 : 1;
  if (!pickReady() && state.pickPoses.length - pickedIdx().length < 1) {
    el.innerHTML = `${state.pickPoses.length}人しか見つかっていません。${next}をタップすると、その周りを探し直します。見つからないときは開始の位置を変えてください。`;
  } else if (!pickReady()) {
    const extra = want === 1 && state.pickPoses.length > 1 ? '（ほかの人は追いません）' : '';
    el.innerHTML = (state.target === 'both' && next === B ? '次に' : '') + `${next}をタップしてください${extra}`;
  } else {
    el.textContent = state.edited
      ? '点を直しました。よければ「解析する」を押してください'
      : '選べました。ずれている点は、指でドラッグして直せます。よければ「解析する」を押してください';
  }
  const ready = pickReady();
  $('to-analyze').disabled = !ready;
  pickCanvas.classList.toggle('editing', ready);
}

// 点を直すときにつかむ点（体の関節と鼻）
const HANDLES = [HEAD_TOP, 0, CHIN, ...JOINTS];

function drawPick() {
  const ctx = pickCanvas.getContext('2d');
  const W = pickCanvas.width, H = pickCanvas.height;
  ctx.drawImage(video, 0, 0, W, H);
  const ready = pickReady();
  state.pickPoses.forEach((p, i) => {
    if (ready && !pickedIdx().includes(i)) return; // 選んだ人だけ残す
    const color = i === state.teacherIdx ? COLOR.teacher : i === state.beginnerIdx ? COLOR.beginner : COLOR.other;
    drawSkeleton(ctx, p, color);
    const label = i === state.teacherIdx ? '先生' : i === state.beginnerIdx ? '初心者' : String(i + 1);
    personTag(ctx, p, label, i === state.teacherIdx ? COLOR.teacher : i === state.beginnerIdx ? COLOR.beginner : 'rgba(0,0,0,0.65)');
    if (ready) {
      // つかめる点を、白いふちの丸で示す。大きさはマークの設定に合わせる
      // （つかむ判定は丸の大きさではなく、指を置いた位置に一番近い点で決める）
      const r = $('mark').value === 'large' ? Math.max(5, Math.min(W, H) / 70) : Math.max(3, Math.min(W, H) / 150);
      ctx.lineWidth = Math.max(1.5, r / 3);
      ctx.strokeStyle = '#FFFFFF';
      ctx.fillStyle = color;
      for (const j of HANDLES) {
        if (p[j * 3 + 2] < 0.05) continue; // 顔が見つからなかったときの顎先・頭頂部
        ctx.beginPath();
        ctx.arc(p[j * 3] * W, p[j * 3 + 1] * H, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  });
  pickPrompt();
}

// ---------- 点を手で直す ----------
let drag = null;   // つかんでいる点 { p, j }
let press = null;  // 長押しの判定 { x, y, timer }
let loupeOn = false;
const loupe = $('loupe');
const LOUPE_SIZE = 150; // CSSの大きさと合わせる
const LOUPE_ZOOM = 3;
const LONG_PRESS_MS = 350;

function canvasPoint(e) {
  const r = pickCanvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

// (clientX, clientY) のまわりを拡大して、指 (fingerX, fingerY) の少し上に表示する
function showLoupe(clientX, clientY, fingerX, fingerY) {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.round(LOUPE_SIZE * dpr);
  // canvas の初期の大きさは 300×150 なので、幅と高さの両方を確かめる
  if (loupe.width !== size || loupe.height !== size) { loupe.width = size; loupe.height = size; }
  const r = pickCanvas.getBoundingClientRect();
  const k = pickCanvas.width / r.width; // 画面の1px が canvas の何px か
  const src = (LOUPE_SIZE / LOUPE_ZOOM) * k;
  const ctx = loupe.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(pickCanvas, (clientX - r.left) * k - src / 2, (clientY - r.top) * k - src / 2, src, src, 0, 0, size, size);
  // 指の位置を示す十字線（中心はあけて、点が見えるようにする）
  const c = size / 2, a = 6 * dpr, b = 18 * dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(c - b, c); ctx.lineTo(c - a, c);
  ctx.moveTo(c + a, c); ctx.lineTo(c + b, c);
  ctx.moveTo(c, c - b); ctx.lineTo(c, c - a);
  ctx.moveTo(c, c + a); ctx.lineTo(c, c + b);
  ctx.stroke();
  const left = Math.max(4, Math.min(window.innerWidth - LOUPE_SIZE - 4, fingerX - LOUPE_SIZE / 2));
  let top = fingerY - LOUPE_SIZE - 48;
  if (top < 4) top = fingerY + 48; // 上に場所がなければ指の下に出す
  loupe.style.left = `${left}px`;
  loupe.style.top = `${top}px`;
  loupe.hidden = false;
}

function endPress() {
  if (press) clearTimeout(press.timer);
  press = null;
  drag = null;
  loupeOn = false;
  loupe.hidden = true;
}

pickCanvas.addEventListener('pointerdown', (e) => {
  if (state.busy || !pickReady()) return;
  const pt = canvasPoint(e);
  let best = null, bestD = 0.06;
  for (const idx of pickedIdx()) {
    const p = state.pickPoses[idx];
    for (const j of HANDLES) {
      if (p[j * 3 + 2] < 0.05) continue;
      const d = dist(pt, { x: p[j * 3], y: p[j * 3 + 1] });
      if (d < bestD) { bestD = d; best = { p, j }; }
    }
  }
  // 点の近くでなければ、長押しで拡大鏡だけ出す。つかんだときの指と点のずれは保ったまま動かす
  drag = best && { ...best, dx: best.p[best.j * 3] - pt.x, dy: best.p[best.j * 3 + 1] - pt.y };
  const x = e.clientX, y = e.clientY;
  press = { x, y, lastX: x, lastY: y, timer: setTimeout(() => { loupeOn = true; showLoupeAtFocus(); }, LONG_PRESS_MS) };
  try { pickCanvas.setPointerCapture(e.pointerId); } catch { /* 画面の外に出ても追い続けるためのもので、失敗しても操作はできる */ }
  e.preventDefault();
});

pickCanvas.addEventListener('pointermove', (e) => {
  if (!press) return;
  press.lastX = e.clientX;
  press.lastY = e.clientY;
  // 長押しになる前に指が動いたら、長押しではなく普通のドラッグ
  if (!loupeOn && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) clearTimeout(press.timer);
  if (drag) {
    const pt = canvasPoint(e);
    drag.p[drag.j * 3] = Math.max(0, Math.min(1, pt.x + drag.dx));
    drag.p[drag.j * 3 + 1] = Math.max(0, Math.min(1, pt.y + drag.dy));
    drag.p[drag.j * 3 + 2] = 1; // 手で直した点は「確か」とみなす
    state.edited = true;
    drawPick();
  }
  if (loupeOn) showLoupeAtFocus();
});

// 点をつかんでいるときは点を、そうでなければ指の位置を、拡大鏡の中心にする
function showLoupeAtFocus() {
  if (!press) return;
  if (drag) {
    const r = pickCanvas.getBoundingClientRect();
    const fx = r.left + drag.p[drag.j * 3] * r.width, fy = r.top + drag.p[drag.j * 3 + 1] * r.height;
    showLoupe(fx, fy, press.lastX, press.lastY);
  } else {
    showLoupe(press.lastX, press.lastY, press.lastX, press.lastY);
  }
}

pickCanvas.addEventListener('pointerup', endPress);
pickCanvas.addEventListener('pointercancel', endPress);
pickCanvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しで出るメニューを止める

$('to-pick').addEventListener('click', async () => {
  try {
    readSettings();
  } catch (e) {
    message('file-info', e.message, true);
    return;
  }
  // iPhoneでは、ボタンを押した直後に一度再生しておくとコマの移動が安定する
  video.play().then(() => video.pause()).catch(() => {});
  lockFrom('step-pick');
  setStep('step-settings', 'done');
  setStep('step-pick', 'active');
  state.teacherIdx = state.beginnerIdx = null;
  state.pickPoses = [];
  pickCanvas.width = state.outW;
  pickCanvas.height = state.outH;
  $('to-analyze').disabled = true;
  const el = $('pick-prompt');
  el.classList.remove('error');
  el.textContent = 'AIを準備しています（初回は少し時間がかかります）…';
  try {
    state.busy = true;
    await getLandmarker(state.model);
    await getFaceLandmarker();
    el.textContent = '人を探しています…';
    await seekTo(video, state.start);
    state.pickPoses = await findPeople();
    state.pickOriginal = state.pickPoses.map((p) => p.slice());
    state.edited = false;
    drawPick();
  } catch (e) {
    console.error(e);
    el.textContent = `AIを動かせませんでした（${e.message}）。ページを読み込み直してください。`;
    el.classList.add('error');
  } finally {
    state.busy = false;
  }
});

function poseAt(pt) {
  let best = -1, bestD = Infinity;
  state.pickPoses.forEach((p, i) => {
    if (pickedIdx().includes(i)) return;
    const b = bbox(p);
    const inside = pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1;
    const d = inside ? 0 : dist(pt, center(p));
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= 0.12 ? best : -1;
}

pickCanvas.addEventListener('click', async (e) => {
  if (state.busy || pickReady() || !state.landmarker) return;
  const r = pickCanvas.getBoundingClientRect();
  const pt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  let best = poseAt(pt);
  if (best < 0) {
    // 見つかっていない人をタップしたときは、その周りを切り出して探し直す
    state.busy = true;
    try {
      const side = Math.min(state.vw, state.vh);
      const more = await detectAround(pt, { w: side * 0.6, h: side });
      for (const p of more) {
        if (!state.pickPoses.some((q) => dist(center(q), center(p)) < 0.06)) {
          state.pickPoses.push(p);
          state.pickOriginal.push(p.slice());
        }
      }
    } finally {
      state.busy = false;
    }
    best = poseAt(pt);
    if (best < 0) { drawPick(); return; }
  }
  if (needT() && state.teacherIdx === null) state.teacherIdx = best;
  else state.beginnerIdx = best;
  if (pickReady()) {
    // 人が決まったら、顎先・頭頂部を探して、直せる点に加える
    state.busy = true;
    try {
      for (const i of pickedIdx()) {
        await addHead(state.pickPoses[i]);
        state.pickOriginal[i] = state.pickPoses[i].slice();
      }
    } finally {
      state.busy = false;
    }
  }
  drawPick();
});

// 選び直すときは、手で直した点もAIの位置に戻す
$('pick-reset').addEventListener('click', () => {
  state.teacherIdx = state.beginnerIdx = null;
  state.pickPoses = state.pickOriginal.map((p) => p.slice());
  state.edited = false;
  if (state.pickPoses.length) drawPick();
});

// ---------- 4. 解析（骨格の検出と、動画・CSVの書き出しを1回で行う） ----------
$('to-analyze').addEventListener('click', async () => {
  setStep('step-pick', 'done');
  setStep('step-analyze', 'active');
  lockFrom('step-export');
  $('save-video').disabled = $('save-csv').disabled = $('to-claude').disabled = true;
  $('result-wrap').hidden = true;
  state.busy = true;
  await keepAwake(true);
  try {
    const noVideo = await analyze();
    setStep('step-analyze', 'done');
    showResult(noVideo);
  } catch (e) {
    console.error(e);
    message('analyze-info', `解析が止まりました（${e.message}）。もう一度「解析する」を押してください。`, true);
    setStep('step-pick', 'active');
  } finally {
    state.busy = false;
    keepAwake(false);
  }
});

async function pickCodec(config) {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42e01f']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ ...config, codec });
      if (r.supported) return codec;
    } catch { /* 次を試す */ }
  }
  return null;
}

// 動画の書き出しの準備。書き出せない端末では null（CSVだけ作る）
// analysis = true のときは、先生とのずれを赤で示した「分析つき動画」にする（上に帯、下に数値のパネルが付く）
async function createWriter(analysis) {
  if (!('VideoEncoder' in window)) return null;
  const VW = state.outW, VH = state.outH;
  const L = analysis ? panelLayout(VW) : null;
  const W = VW, H = analysis ? L.head + VH + L.panel : VH;
  const outFps = state.fps * state.speed; // 1/2倍速では1コマを2倍の長さで、2倍速では半分の長さで見せる
  const base = { width: W, height: H, bitrate: Math.max(1_500_000, Math.round(W * H * outFps * 0.25)), framerate: outFps };
  const codec = await pickCodec(base);
  if (!codec) return null;

  const target = new ArrayBufferTarget();
  // mp4-muxer は整数のコマ数しか受け付けない。各コマの時刻は「1/解析コマ数」秒か「1/書き出しコマ数」秒の
  // 倍数になるので、整数ならそちらを、そうでなければ解析のコマ数を渡す
  const frameRate = Number.isInteger(outFps) ? outFps : state.fps;
  const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure({ ...base, codec, avc: { format: 'avc' } });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const dur = 1e6 / outFps;
  const keyEvery = Math.max(1, Math.round(outFps * 2));
  const encode = async (i) => {
    if (failure) throw failure;
    const vf = new VideoFrame(canvas, { timestamp: Math.round(i * dur), duration: Math.round(dur) });
    encoder.encode(vf, { keyFrame: i % keyEvery === 0 });
    vf.close();
    while (encoder.encodeQueueSize > 6) await sleep(4);
  };
  const judge = analysis ? createJudge(VW, VH, L, ctx, encode) : null;
  return {
    async add(frame, i, total) {
      if (judge) { await judge.push(frame, i, total); return; }
      drawScene(ctx, frame);
      await encode(i);
    },
    async finish() {
      if (judge) await judge.flush();
      await encoder.flush();
      if (failure) throw failure;
      encoder.close();
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
  };
}

// ---------- 分析つき動画（先生とのずれを赤で示す） ----------
// 判定基準はClaudeの分析用ページ（ダンス練習分析）の v1 と同じ。基準を直したら、ここも合わせる
const JUDGE = { version: 'v1', elbowDrop: 0.15, armRaise: 30, knee: 25, foot: 0.20, tilt: 10, minRun: 0.1 };
const J_IDS = ['elbowDropL', 'elbowDropR', 'armRaiseL', 'armRaiseR', 'knee', 'foot', 'tilt'];
const J_DIR = { elbowDropL: 'up', elbowDropR: 'up', armRaiseL: 'abs', armRaiseR: 'abs', knee: 'up', foot: 'down', tilt: 'down' };
const J_TH = { elbowDropL: 'elbowDrop', elbowDropR: 'elbowDrop', armRaiseL: 'armRaise', armRaiseR: 'armRaise', knee: 'knee', foot: 'foot', tilt: 'tilt' };
const J_ROWS = [
  { name: '膝の曲げ', key: 'knee', ids: ['knee'], scale: 90, unit: '°', lane: '膝' },
  { name: '足の上がり', key: 'foot', ids: ['foot'], scale: 80, unit: '', lane: '足' },
  { name: '肩の傾き', key: 'tilt', ids: ['tilt'], scale: 40, unit: '°', lane: '肩' },
  { name: '肘の上がり', key: 'arm', ids: ['armRaiseL', 'armRaiseR'], scale: 120, unit: '°', lane: '肘↑' },
  { name: '肘の落ち', key: 'drop', ids: ['elbowDropL', 'elbowDropR'], scale: 60, unit: '', lane: '肘↓' },
];
const J_COLOR = { bg: '#14181E', panel: '#181D24', track: '#2E3640', red: '#EB4034', redbg: '#5C1C1C', white: '#F0F2F5', muted: '#96A0AC', green: '#46D282', yellow: '#FFD65A' };

function panelLayout(VW) {
  const u = VW / 960;
  const even = (v) => Math.round(v / 2) * 2;
  return { u, head: even(70 * u), panel: even(440 * u) };
}

// 1人分の判定用の値（ピクセル）。自信の低い点は使わない
function judgeValues(p, floor) {
  if (!p) return null;
  const P = (i) => px(p, i);
  const ok = (...ids) => ids.every((i) => p[i * 3 + 2] >= VIS_MIN);
  const sh = { x: (P(11).x + P(12).x) / 2, y: (P(11).y + P(12).y) / 2 }, hip = { x: (P(23).x + P(24).x) / 2, y: (P(23).y + P(24).y) / 2 };
  const torso = Math.hypot(sh.x - hip.x, sh.y - hip.y);
  if (!torso || torso < state.vh * 0.04) return null; // 胴が小さすぎるのは検出の失敗
  const v = {};
  for (const [k, s, e, w, h, kn, an] of [['L', 11, 13, 15, 23, 25, 27], ['R', 12, 14, 16, 24, 26, 28]]) {
    v['elbowDrop' + k] = ok(e, w) ? (P(e).y - P(w).y) / torso : null;
    v['armRaise' + k] = ok(s, e) ? armRaise(P(s), P(e)) : null;
    v['kneeA' + k] = ok(h, kn, an) ? angle3(P(h), P(kn), P(an)) : null;
    v['lift' + k] = floor !== null && ok(an) ? (floor - P(an).y) / torso : null;
    if (v["lift" + k] !== null && (v["lift" + k] > 1.5 || v["lift" + k] < -0.5)) v["lift" + k] = null; // 足首の取り違えなど、ありえない高さは使わない
    if (v['armRaise' + k] === '') v['armRaise' + k] = null;
    if (v['kneeA' + k] === '') v['kneeA' + k] = null;
  }
  const knees = [['L', v.kneeAL], ['R', v.kneeAR]].filter((x) => x[1] !== null).sort((a, b) => a[1] - b[1]);
  v.knee = knees.length ? knees[0][1] : null; v.kneeSide = knees.length ? knees[0][0] : null;
  const lifts = [['L', v.liftL], ['R', v.liftR]].filter((x) => x[1] !== null).sort((a, b) => b[1] - a[1]);
  v.foot = lifts.length ? lifts[0][1] : null; v.footSide = lifts.length ? lifts[0][0] : null;
  v.tilt = ok(11, 12) ? Math.atan2(Math.abs(P(11).y - P(12).y), Math.abs(P(11).x - P(12).x)) * 180 / Math.PI : null;
  return v;
}

function judgeShow(v, key) {
  if (!v) return null;
  if (key === 'knee') return v.knee === null ? null : 180 - v.knee;
  if (key === 'foot') return v.foot === null ? null : Math.max(0, v.foot * 100);
  if (key === 'tilt') return v.tilt;
  const a = key === 'arm' ? [v.armRaiseL, v.armRaiseR] : [v.elbowDropL, v.elbowDropR];
  const b = a.filter((x) => x !== null);
  if (!b.length) return null;
  return key === 'arm' ? Math.max(...b) : Math.max(0, Math.max(...b) * 100);
}

function createJudge(VW, VH, L, ctx, encode) {
  const u = L.u;
  const minSamples = Math.max(1, Math.round(JUDGE.minRun * state.fps) + 1);
  const look = minSamples - 1;            // 何コマ先まで見てから決めるか
  const scene = [];                        // 判定待ちのコマ（骨格つきの絵を持っておく）
  const raw = Object.fromEntries(J_IDS.map((id) => [id, []]));   // コマごとの「基準を超えたか」
  const dev = Object.fromEntries(J_IDS.map((id) => [id, []]));   // 続いた時間も満たした「ずれ」
  const maxV = { t: {}, b: {} };
  const ankles = { A: [], B: [] };
  const floor = { A: null, B: null };
  let total = 1;

  // 床の高さ：足首が床に着いているときの高さ（これまでの足首の位置の95%点）
  const updateFloor = (key, p, i) => {
    if (!p) return;
    for (const a of [27, 28]) if (p[a * 3 + 2] >= VIS_MIN) ankles[key].push(p[a * 3 + 1] * state.vh);
    if (i % 15 === 0 || floor[key] === null) {
      const s = [...ankles[key]].sort((x, y) => x - y);
      if (s.length) floor[key] = s[Math.floor((s.length - 1) * 0.95)];
    }
  };

  async function push(frame, i, n) {
    total = n;
    updateFloor('A', frame.A, i);
    updateFloor('B', frame.B, i);
    const tv = judgeValues(frame.A, floor.A), bv = judgeValues(frame.B, floor.B);
    for (const id of J_IDS) {
      const a = tv?.[id] ?? null, b = bv?.[id] ?? null;
      let r = null;
      if (a !== null && b !== null && !frame.overlap) {
        const d = J_DIR[id] === 'up' ? b - a : J_DIR[id] === 'down' ? a - b : Math.abs(b - a);
        r = d >= JUDGE[J_TH[id]];
      }
      raw[id][i] = r;
    }
    const c = document.createElement('canvas');
    c.width = VW; c.height = VH;
    drawScene(c.getContext('2d'), frame, false);
    scene.push({ frame, i, c, tv, bv });
    while (scene.length > look) await finalize(scene.shift());
  }

  async function flush() {
    while (scene.length) await finalize(scene.shift());
  }

  // ずれは「基準を超えた状態が続いた時間」が minRun 以上のときだけ数える
  function isDev(id, i) {
    if (raw[id][i] !== true) return false;
    let back = 0, fwd = 0;
    for (let k = i - 1; k >= 0 && raw[id][k] === true; k--) back++;
    for (let k = i + 1; raw[id][k] === true; k++) fwd++;
    return back + 1 + fwd >= minSamples;
  }

  async function finalize(s) {
    const { frame, i, tv, bv } = s;
    for (const id of J_IDS) dev[id][i] = isDev(id, i);
    for (const r of J_ROWS) {
      for (const [k, v] of [['t', tv], ['b', bv]]) {
        const x = frame.overlap ? null : judgeShow(v, r.key);
        if (x !== null) maxV[k][r.key] = Math.max(maxV[k][r.key] ?? 0, x);
      }
    }
    const W = VW;
    ctx.fillStyle = J_COLOR.bg;
    ctx.fillRect(0, 0, W, ctx.canvas.height);
    ctx.drawImage(s.c, 0, L.head);
    const msgs = drawDeviations(ctx, frame, tv, bv, i);
    drawHead(ctx, frame, msgs, bv);
    drawPanel(ctx, frame, tv, bv, i);
    await encode(i);
  }

  // ---- 描き方 ----
  const font = (size) => `700 ${Math.round(size * u)}px "BIZ UDPGothic", "Hiragino Sans", sans-serif`;
  const pt = (p, idx) => ({ x: p[idx * 3] * VW, y: L.head + p[idx * 3 + 1] * VH, v: p[idx * 3 + 2] });
  function label(text, x, y, fg, bg, size = 13) {
    ctx.font = font(size);
    const w = ctx.measureText(text).width + 8 * u, h = (size + 7) * u;
    const bx = Math.max(2, Math.min(VW - w - 2, x));
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, y, w, h, 4 * u) : ctx.rect(bx, y, w, h);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 4 * u, y + h / 2);
  }
  function line(p, a, b) {
    if (!p || p[a * 3 + 2] < 0.05 || p[b * 3 + 2] < 0.05) return;
    const A = pt(p, a), B = pt(p, b);
    ctx.strokeStyle = J_COLOR.red; ctx.lineWidth = Math.max(3, 6 * u); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
  }
  function ring(p, idx, color, r = 10) {
    if (!p || p[idx * 3 + 2] < 0.05) return;
    const A = pt(p, idx);
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, 3 * u);
    ctx.beginPath(); ctx.arc(A.x, A.y, r * u, 0, Math.PI * 2); ctx.stroke();
  }
  function angleLabels(p, v) {
    if (!p || !v) return;
    const dark = 'rgba(12,14,18,0.85)';
    if (v.tilt !== null && p[CHIN * 3 + 2] >= 0.05) { const c = pt(p, CHIN); label(`肩 ${Math.round(v.tilt)}°`, c.x - 20 * u, c.y + 2 * u, J_COLOR.white, dark); }
    for (const [k, e, left] of [['L', 13, true], ['R', 14, false]]) {
      if (v['armRaise' + k] === null) continue;
      const E = pt(p, e);
      label(`肘 ${Math.round(v['armRaise' + k])}°`, left ? E.x + 8 * u : E.x - 50 * u, E.y - 8 * u, J_COLOR.white, dark);
    }
    if (v.knee !== null) { const K = pt(p, v.kneeSide === 'L' ? 25 : 26); label(`膝 ${Math.round(v.knee)}°`, K.x + 8 * u, K.y - 8 * u, J_COLOR.white, dark); }
  }

  function drawDeviations(c, frame, tv, bv, i) {
    const T = frame.A, B = frame.B, msgs = [];
    if (!frame.overlap) { angleLabels(T, tv); angleLabels(B, bv); }
    if (T && tv && tv.foot !== null && tv.foot >= 0.15 && !frame.overlap) {
      const idx = tv.footSide === 'L' ? 27 : 28;
      ring(T, idx, J_COLOR.green);
      const A = pt(T, idx); label('足上げ', A.x + 12 * u, A.y - 8 * u, J_COLOR.green, 'rgba(12,14,18,0.85)');
    }
    if (!B || !bv) return msgs;
    for (const [k, s, e, w] of [['L', 11, 13, 15], ['R', 12, 14, 16]]) {
      const notes = [];
      if (dev['elbowDrop' + k][i]) notes.push('肘が落ちている');
      if (dev['armRaise' + k][i]) notes.push(bv['armRaise' + k] > (tv?.['armRaise' + k] ?? 0) ? '肘が上がりすぎ' : '肘が低い');
      if (!notes.length) continue;
      line(B, s, e); line(B, e, w); ring(B, e, J_COLOR.red); ring(T, e, J_COLOR.white, 9);
      const E = pt(B, e);
      notes.forEach((t, j) => label(t, E.x - 50 * u, E.y + (14 + j * 21) * u, J_COLOR.white, J_COLOR.red));
      msgs.push(...notes);
    }
    if (dev.tilt[i]) {
      line(B, 11, 12);
      const a = pt(B, 11), b = pt(B, 12);
      label('肩の傾き不足', (a.x + b.x) / 2 - 40 * u, Math.min(a.y, b.y) - 26 * u, J_COLOR.white, J_COLOR.red);
      msgs.push('肩の傾き不足');
    }
    if (dev.knee[i] && bv.kneeSide) {
      const [h, k2, a] = bv.kneeSide === 'L' ? [23, 25, 27] : [24, 26, 28];
      line(B, h, k2); line(B, k2, a); ring(B, k2, J_COLOR.red);
      const K = pt(B, k2); label('膝が浅い', K.x - 70 * u, K.y + 12 * u, J_COLOR.white, J_COLOR.red);
      msgs.push('膝が浅い');
    }
    if (dev.foot[i] && bv.footSide) {
      const a = bv.footSide === 'L' ? 27 : 28;
      ring(B, a, J_COLOR.red);
      const A = pt(B, a); label('足が低い', A.x + 12 * u, A.y - 10 * u, J_COLOR.white, J_COLOR.red);
      msgs.push('足が低い');
    }
    return [...new Set(msgs)];
  }

  function drawHead(c, frame, msgs, bv) {
    c.fillStyle = J_COLOR.bg;
    c.fillRect(0, 0, VW, L.head);
    c.textBaseline = 'top';
    c.font = font(15); c.fillStyle = J_COLOR.muted;
    c.fillText(`元の動画 ${frame.t.toFixed(1)}秒　${SPEED_LABEL[state.speed] ?? `${state.speed}倍速`}　判定基準 ${JUDGE.version}`, 14 * u, 6 * u);
    c.font = font(24);
    if (msgs.length) { c.fillStyle = J_COLOR.red; c.fillText('赤：先生とずれている部分 → ' + msgs.join('・'), 14 * u, 30 * u); }
    else if (frame.overlap || !frame.A || !frame.B) { c.fillStyle = J_COLOR.yellow; c.fillText('2人が重なっているか見失ったコマ（比べていません）', 14 * u, 30 * u); }
    else { c.fillStyle = J_COLOR.white; c.fillText('先生とのずれは出ていません', 14 * u, 30 * u); }
  }

  function drawPanel(c, frame, tv, bv, i) {
    const y0 = L.head + VH, W = VW;
    c.fillStyle = J_COLOR.panel;
    c.fillRect(0, y0, W, L.panel);
    c.textBaseline = 'top';
    c.font = font(15); c.fillStyle = J_COLOR.muted;
    c.fillText('今の値（バー）とここまでの最大（白い線）。赤い行＝今ずれている部分', 14 * u, y0 + 8 * u);
    const rh = 56 * u, ry = y0 + 36 * u, bx0 = 150 * u, bx1 = W - 150 * u;
    J_ROWS.forEach((r, n) => {
      const y = ry + n * rh;
      const on = r.ids.some((id) => dev[id][i]);
      if (on) { c.fillStyle = J_COLOR.redbg; c.fillRect(0, y, W, rh - 4 * u); }
      c.font = font(20); c.fillStyle = on ? J_COLOR.red : J_COLOR.white;
      c.fillText(r.name, 14 * u, y + 14 * u);
      [['t', tv, COLOR.teacher, '先生 '], ['b', bv, COLOR.beginner, '初心者 ']].forEach(([k, v, col, who], j) => {
        const by = y + (6 + j * 24) * u, bh = 16 * u;
        c.fillStyle = J_COLOR.track; c.fillRect(bx0, by, bx1 - bx0, bh);
        const x = frame.overlap ? null : judgeShow(v, r.key);
        if (x !== null) { c.fillStyle = col; c.fillRect(bx0, by, (bx1 - bx0) * Math.max(0, Math.min(1, x / r.scale)), bh); }
        const mx = maxV[k][r.key];
        if (mx !== undefined) { c.fillStyle = J_COLOR.white; c.fillRect(bx0 + (bx1 - bx0) * Math.min(1, mx / r.scale) - u, by - 2 * u, 2 * u, bh + 4 * u); }
        c.font = font(15); c.fillStyle = col;
        c.fillText(who + (x === null ? '—' : `${Math.round(x)}${r.unit}`), bx1 + 10 * u, by - 2 * u);
      });
    });
    // ずれのタイミング（再生に合わせて左から埋まる）
    const ty = ry + J_ROWS.length * rh + 6 * u;
    c.font = font(15); c.fillStyle = J_COLOR.muted;
    c.fillText('ずれの出たタイミング', 14 * u, ty);
    const lx0 = 60 * u, lx1 = W - 20 * u, lh = 14 * u, span = Math.max(1, total);
    J_ROWS.forEach((r, n) => {
      const y = ty + 26 * u + n * (lh + 4 * u);
      c.font = font(13); c.fillStyle = J_COLOR.muted; c.fillText(r.lane, 14 * u, y - 2 * u);
      c.fillStyle = J_COLOR.track; c.fillRect(lx0, y, lx1 - lx0, lh);
      c.fillStyle = J_COLOR.red;
      const wpx = (lx1 - lx0) / span;
      for (let k = 0; k <= i; k++) if (r.ids.some((id) => dev[id][k])) c.fillRect(lx0 + k * wpx, y, Math.max(1, wpx + 0.5), lh);
    });
    const xp = lx0 + (lx1 - lx0) * (i + 0.5) / span;
    c.fillStyle = J_COLOR.white;
    c.fillRect(xp - u, ty + 22 * u, 2 * u, J_ROWS.length * (lh + 4 * u) + 4 * u);
  }

  return { push, flush };
}

async function analyze() {
  const step = 1 / state.fps;
  const n = Math.floor((state.end - state.start) / step + 1e-6) + 1;
  const bar = $('analyze-bar');
  bar.style.width = '0%';
  state.frames = [];
  state.videoBlob = state.csvBlob = null;
  lastCrop.A = lastCrop.B = null;
  let prevA = needT() ? state.pickPoses[state.teacherIdx] : null;
  let prevB = needB() ? state.pickPoses[state.beginnerIdx] : null;
  let lostA = 0, lostB = 0, overlaps = 0;
  state.analysisVideo = $('video-kind').value === 'analysis' && state.target === 'both';
  const writer = await createWriter(state.analysisVideo);
  const t0 = performance.now();
  message('analyze-info', '終わるまでこの画面を開いたままにしてください。');
  for (let i = 0; i < n; i++) {
    const t = state.start + i * step;
    await seekTo(video, t);
    // 最初のコマは、選んだとき（手で直した場合は直した後）の点をそのまま使う
    const { A, B } = i === 0 ? { A: prevA && prevA.slice(), B: prevB && prevB.slice() } : await trackFrame(prevA, prevB);
    if (i > 0) {
      if (A) await addHead(A);
      if (B) await addHead(B);
    }
    if (prevA) { if (A) prevA = A; else lostA++; }
    if (prevB) { if (B) prevB = B; else lostB++; }
    const frame = { t, A, B, overlap: overlapping(A, B) };
    if (frame.overlap) overlaps++;
    state.frames.push(frame);
    // 同じコマを、そのまま動画に書き込む
    if (writer) await writer.add(frame, i, n);
    if (i % 3 === 0 || i === n - 1) {
      bar.style.width = `${((i + 1) / n) * 100}%`;
      const left = ((performance.now() - t0) / (i + 1)) * (n - i - 1) / 1000;
      message('analyze-info', `${i + 1} / ${n} コマ　あと約${Math.ceil(left)}秒（この画面を開いたままにしてください）`);
      await nextPaint();
    }
  }
  message('analyze-info', '仕上げています…');
  state.headCalibrated = { A: calibrateHeads('A'), B: calibrateHeads('B') };
  state.csvText = buildCsv();
  state.csvBlob = new Blob(['﻿' + state.csvText], { type: 'text/csv' });
  if (writer) state.videoBlob = await writer.finish();
  const sec = ((performance.now() - t0) / 1000).toFixed(0);
  const lost = [needT() && lostA ? `先生 ${lostA}` : '', needB() && lostB ? `初心者 ${lostB}` : ''].filter(Boolean).join('・');
  message('analyze-info', `解析が終わりました（${n}コマ・${sec}秒・${state.delegate}）。`
    + (lost ? `　見失ったコマ：${lost}` : '')
    + (overlaps ? `　2人が重なったコマ：${overlaps}（CSVに印を付けました）` : ''));
  return !writer;
}

// ---------- 5. 保存・6. Claudeで分析 ----------
function showResult(noVideo) {
  setStep('step-export', 'active');
  $('save-csv').disabled = false;
  $('to-claude').disabled = false;
  if (state.videoBlob) {
    $('result').src = URL.createObjectURL(state.videoBlob);
    $('result-wrap').hidden = false;
    $('save-video').disabled = false;
    message('export-info', `できました（動画 ${(state.videoBlob.size / 1e6).toFixed(1)}MB）。手元に残したいときは保存してください。`);
  } else {
    message('export-info', noVideo
      ? 'この端末では動画を書き出せませんでした（iPhoneはiOS 16.4以降のSafariが必要です）。CSVは保存できます。'
      : '動画を書き出せませんでした。CSVは保存できます。', true);
  }
  message('claude-info', ANALYSIS_URL
    ? '骨格データをコピーして、分析用のページ（Artifact）を開きます。開いたら貼り付けて「分析する」を押してください。'
    : '分析用のページ（Artifact）のリンクがまだ入っていないので、今は骨格データのコピーだけ行います。');
  $('step-export').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('to-claude').addEventListener('click', async () => {
  if (!state.csvText) return;
  // コピーとページを開く操作は、押した直後に続けて行う（iPhoneで止められないように）
  const copy = navigator.clipboard ? navigator.clipboard.writeText(state.csvText) : Promise.reject(new Error('no clipboard'));
  if (ANALYSIS_URL) window.open(ANALYSIS_URL, '_blank');
  try {
    await copy;
    message('claude-info', ANALYSIS_URL ? '骨格データをコピーしました。開いたページに貼り付けてください。' : '骨格データをコピーしました。');
  } catch {
    message('claude-info', 'コピーできませんでした。「CSVを保存」で保存してから渡してください。', true);
  }
});

// ---------- CSV ----------
function angle3(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const d = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (!d) return '';
  return Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / d))) * 180 / Math.PI;
}
// 二の腕の角度：真下が0°、肩の高さが90°
function armRaise(sh, el) {
  const v = { x: el.x - sh.x, y: el.y - sh.y };
  const d = Math.hypot(v.x, v.y);
  if (!d) return '';
  return Math.acos(Math.max(-1, Math.min(1, v.y / d))) * 180 / Math.PI;
}
const r1 = (n) => (n === '' ? '' : Math.round(n * 10) / 10);
const r2 = (n) => Math.round(n * 100) / 100;

function measures(p) {
  const P = (i) => px(p, i);
  const mid = (i, j) => ({ x: (P(i).x + P(j).x) / 2, y: (P(i).y + P(j).y) / 2 });
  const sh = mid(11, 12), hip = mid(23, 24);
  const tilt = Math.atan2(Math.abs(P(11).y - P(12).y), Math.abs(P(11).x - P(12).x)) * 180 / Math.PI;
  return [
    Math.hypot(sh.x - hip.x, sh.y - hip.y),
    angle3(P(23), P(25), P(27)), angle3(P(24), P(26), P(28)),
    angle3(P(11), P(13), P(15)), angle3(P(12), P(14), P(16)),
    armRaise(P(11), P(13)), armRaise(P(12), P(14)),
    tilt,
  ].map(r1);
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  const names = Object.keys(POINTS);
  const header = [
    'time_s', 'role', 'tracked_id', 'overlap',
    ...names.flatMap((n) => [`${n}_x`, `${n}_y`, `${n}_vis`]),
    'torso_px', 'knee_angle_left', 'knee_angle_right', 'elbow_angle_left', 'elbow_angle_right',
    'arm_raise_left', 'arm_raise_right', 'shoulder_tilt',
  ];
  const lines = [
    `# movie-motion-capture ${APP_VERSION}`,
    `# source_file: ${state.name}`,
    `# created: ${new Date().toISOString()}`,
    `# video_size_px: ${state.vw}x${state.vh}`,
    `# video_duration_s: ${state.duration.toFixed(2)}`,
    `# target: ${state.target} (${TARGET_LABEL[state.target]})`,
    `# video: ${state.analysisVideo ? `analysis (deviations drawn with criteria ${JUDGE.version})` : 'skeleton only'}`,
    `# analyzed_range_s: ${state.start.toFixed(1)}-${state.end.toFixed(1)}`,
    `# analysis_fps: ${state.fps} / sample_interval_s: 0.1`,
    `# model: MediaPipe Pose Landmarker ${state.model} (${MEDIAPIPE_VERSION}, ${state.delegate})`,
    '# coords: pixels of the source video, origin top-left, y down. *_vis = AI confidence 0-1 (below 0.5 is unreliable)',
    '# angles_deg: knee/elbow = 3-point angle (180 = straight). arm_raise = upper arm from straight down (0 = down, 90 = shoulder height). shoulder_tilt = shoulder line from horizontal',
    '# head points: chin_vis 1 = MediaPipe Face Landmarker point 152. head_top is always ESTIMATED: with a face, chin + (forehead top = face point 10 - chin) x 1.3',
    '# head points when the face AI could not find the face: chin and head_top are ESTIMATED from pose eyes and mouth (vis = 0.4), using the face proportions measured on the same person\'s face-found frames (median), or adult averages if fewer than 5 such frames. vis 0 = no estimate (x/y empty)',
    `# head_estimate_calibrated_from_frames: tracked A ${state.headCalibrated?.A ?? 0}, tracked B ${state.headCalibrated?.B ?? 0}`,
    '# left/right: the person\'s own left/right as detected by the AI (a mirrored video stays mirrored)',
    '# tracked_id: A = person picked as teacher, B = person picked as beginner. Only the roles in target are written',
    '# overlap: 1 = the two people overlapped in this frame, so the roles may be mixed up or points may be wrong (consider excluding)',
    `# first_frame: ${state.edited ? 'some points were adjusted by hand (vis set to 1)' : 'AI detection as is'}`,
    '# empty row values = the person was not found in that frame',
    header.join(','),
  ];
  for (let k = 0; ; k++) {
    const t = state.start + k * 0.1;
    if (t > state.end + 1e-6) break;
    const f = frameAt(t);
    const r = rolesOf(f);
    for (const role of ['teacher', 'beginner']) {
      if (role === 'teacher' ? !needT() : !needB()) continue;
      const p = r[role];
      const id = role === 'teacher' ? 'A' : 'B';
      const row = [t.toFixed(1), role, id, f.overlap ? 1 : 0];
      if (p) {
        for (const n of names) {
          const q = px(p, POINTS[n]);
          if (POINTS[n] >= 33 && q.v < 0.05) row.push('', '', 0); // 顔が見つからなかった
          else row.push(r1(q.x), r1(q.y), r2(q.v));
        }
        row.push(...measures(p));
      } else {
        row.push(...new Array(names.length * 3 + 8).fill(''));
      }
      lines.push(row.map(csvCell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

// ---------- 保存 ----------
function baseName() {
  return state.name.replace(/\.[^.]+$/, '') || 'video';
}

async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

$('save-video').addEventListener('click', () => state.videoBlob && saveBlob(state.videoBlob, `${baseName()}_MediaPipePose${state.analysisVideo ? '_分析' : ''}.mp4`));
$('save-csv').addEventListener('click', () => state.csvBlob && saveBlob(state.csvBlob, `${baseName()}_MediaPipePose.csv`));

// 動作確認用：?src=動画のURL で動画を読み込む
const testSrc = new URLSearchParams(location.search).get('src');
if (testSrc) {
  fetch(testSrc).then((r) => r.blob()).then((b) => handleFile(new File([b], testSrc.split('/').pop(), { type: b.type || 'video/mp4' })));
}
