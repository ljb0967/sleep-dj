import {
  parseTracklist, pickTracklist, toSpeech, extractVideoId, indexAt, formatTime, tracksToText,
} from './tracklist.js?v=20261110a';
import { createVoice, PHRASES, OPENAI_VOICES } from './voice.js?v=20261110a';
import {
  buildDjRequest, responseText, parseDjScript, trackSignature, isValidIntro, djLine, djOpening, songSentence, songDisplay,
} from './dj.js?v=20261110a';
import {
  listVoices, recommendVoices, voiceSettings, voiceLabel, createClone, toCloneWav, startRecording, READING_SCRIPT,
} from './typecast.js?v=20261110a';

const $ = (sel) => document.querySelector(sel);
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const ENDED = 0;
const CUED = 5;
const STATE_NAMES = { '-1': '시작 전', 0: '끝남', 1: '재생 중', 2: '멈춤', 3: '불러오는 중', 5: '준비됨' };

// ── 이 기기에만 저장 (localStorage가 막혀 있어도 앱은 동작) ──────────────────
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`sdj.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  /** 저장에 성공하면 true */
  set(key, val) {
    try {
      localStorage.setItem(`sdj.${key}`, JSON.stringify(val));
      return true;
    } catch { return false; }
  },
};

const settings = {
  mode: 'pause', rate: 1, prefix: true, apiKey: '',
  engine: 'device', voiceURI: '', openaiKey: '', openaiVoice: 'nova', sleepMinutes: 0,
  typecastKey: '', typecastVoice: '', typecastModel: '', typecastEmotion: '', dj: false,
  ...store.get('settings', {}),
};
const saveSettings = () => store.set('settings', settings);

const state = {
  player: null,
  playerReady: false,
  session: 0,           // 영상을 새로 열 때마다 증가. 늦게 끝난 작업이 새 영상을 건드리지 않게 한다.
  videoId: null,
  videoTitle: '',
  tracks: [],
  tracksVersion: 0,     // 곡 목록을 바꿀 때마다 증가 (늦게 온 자동 목록이 직접 넣은 목록을 덮지 않게)
  source: '',
  started: false,
  busy: false,          // 안내하려고 우리가 음악을 멈춘 상태 (사용자가 멈춘 게 아님)
  currentIdx: -1,
  lastT: 0,
  wakeLock: null,
  wakeLockPending: false,
  resumeBlocked: false, // 말한 뒤 자동 재개가 막혔음 → 이번에는 음악 위에 말하기
  needsTapToResume: false,
  resumeOk: true,
  startHint: false,
  lastTapAt: 0,
  sleepAt: 0,
  sleepTimerFired: false,
  djScript: null,       // { sig, opening, entries } 이 영상의 DJ 대본
  tcVoices: [],         // Typecast 목소리 전체
  tcRecommended: [],
  recorder: null,       // 내 목소리 녹음 중
  recordTimer: null,
  cloneWav: null,       // 등록할 내 목소리 WAV
  timerSpeaking: false, // 취침 타이머 안내를 말하는 중 (이 동안 재생 신호로 타이머 상태를 풀지 않는다)
  playerError: null,    // 유튜브가 알린 재생 오류 문구 (영상을 새로 열면 지운다)
  startFrom: null,      // 시작 전에 곡 목록에서 고른 곡의 시각(초)
  timerFiredAt: -1e9,   // 취침 타이머가 발동한 시각 (performance.now). 직후의 재생 신호는 재개 전환의 잔여다
  resumedAt: -1e9,      // 곡 안내 뒤 자동 재개를 부른 시각 (performance.now). 이 직후의 튀는 PAUSED를 사용자 멈춤으로 보지 않는다.
  needsVoiceStart: false, // 영상의 재생 버튼으로 시작해서 목소리가 아직 안 켜졌음 → 판 한 번으로 켠다
};

// 판 아래에 보여 주는 안내 문구. 같은 문구일 때만 지우려고 상수로 둔다.
const NOTE_PAUSED = '멈춰 있어요. 판을 한 번 누르면 다시 틀어요.';
const NOTE_VOICE_FAILED = '목소리가 나오지 않았어요. 판을 누르면 다시 말해요.';
const NOTE_VOICE_OFF = '판을 한 번 누르면 목소리가 켜져요.';

const playerStateName = () => STATE_NAMES[state.player?.getPlayerState?.()] ?? '없음';
const voice = createVoice({ getSettings: () => settings, getPlayerState: playerStateName });

// ── 화면 요소 ─────────────────────────────────────────────────────────────
const el = {
  form: $('#load-form'), url: $('#url-input'), paste: $('#paste-btn'), loadMsg: $('#load-msg'),
  playerEmpty: $('#player-empty'), videoTitle: $('#video-title'),
  pad: $('#pad'), start: $('#start-btn'), tap: $('#tap-area'), tapHint: $('#tap-hint'),
  nowLabel: $('#now-label'), nowTitle: $('#now-title'), nowNext: $('#now-next'), padNote: $('#pad-note'),
  timerNote: $('#timer-note'), menu: $('#menu-btn'),
  trackMeta: $('#tracks-meta'), trackList: $('#track-list'), tracksEdit: $('#tracks-edit'),
  tracksInput: $('#tracks-input'), tracksApply: $('#tracks-apply'), tracksMsg: $('#tracks-msg'), voiceMsg: $('#voice-msg'), namesMsg: $('#names-msg'),
  savedList: $('#saved-list'), savedEmpty: $('#saved-empty'), copySaved: $('#copy-saved'), savedMsg: $('#saved-msg'),
  historyList: $('#history-list'), historyEmpty: $('#history-empty'),
  modeRadios: document.querySelectorAll('input[name="mode"]'),
  engineRadios: document.querySelectorAll('input[name="engine"]'),
  rate: $('#rate'), rateOut: $('#rate-out'), prefix: $('#prefix'), testVoice: $('#test-voice'),
  deviceField: $('#device-voice-field'), voiceSelect: $('#voice-select'),
  openaiField: $('#openai-field'), openaiKey: $('#openai-key'), openaiSave: $('#openai-save'),
  openaiVoice: $('#openai-voice'), openaiVoiceRow: $('#openai-voice-row'), openaiMsg: $('#openai-msg'),
  typecastField: $('#typecast-field'), typecastKey: $('#typecast-key'), typecastSave: $('#typecast-save'),
  typecastVoice: $('#typecast-voice'), typecastMsg: $('#typecast-msg'),
  readingScript: $('#reading-script'), recordBtn: $('#record-btn'), voiceFile: $('#voice-file'),
  voicePreview: $('#voice-preview'), cloneName: $('#clone-name'), cloneConsent: $('#clone-consent'),
  cloneBtn: $('#clone-btn'), cloneMsg: $('#clone-msg'),
  dj: $('#dj'), djField: $('#dj-field'), djRewrite: $('#dj-rewrite'), djMsg: $('#dj-msg'), prefixRow: $('#prefix-row'),
  sleepTimer: $('#sleep-timer'),
  backHome: $('#back-home'), topTitle: $('#top-title'), scroller: $('#scroller'),
  nowArtist: $('#now-artist'), saveNow: $('#save-now'), tracksH: $('#tracks-h'), plHead: $('#pl-head'),
  shelfWrap: $('#shelf-wrap'), shelf: $('#shelf'),
  progFill: $('#prog-fill'), progCur: $('#prog-cur'), progEnd: $('#prog-end'),
  trPrev: $('#tr-prev'), trToggle: $('#tr-toggle'), trNext: $('#tr-next'),
  mini: $('#mini'), miniOpen: $('#mini-open'), miniThumb: $('#mini-thumb'), miniTitle: $('#mini-title'),
  miniSub: $('#mini-sub'), miniToggle: $('#mini-toggle'),
  tabs: document.querySelectorAll('.tab'), segBtns: document.querySelectorAll('.seg-btn'),
  rescueTest: $('#rescue-test'), diagOpen: $('#diag-open'), // 새 화면 요소: 없어도 앱은 동작한다
  apiKey: $('#api-key'), apiSave: $('#api-save'), apiMsg: $('#api-msg'),
  diag: $('#diag'), diagText: $('#diag-text'), diagCopy: $('#diag-copy'),
};

function setMsg(node, text, kind = '') {
  node.textContent = text;
  node.dataset.kind = kind;
}

/** 판 아래 안내가 지금 이 문구일 때만 지운다 (다른 안내를 덮어 지우지 않게). */
function clearPadNote(text) {
  if (el.padNote.textContent === text) setMsg(el.padNote, '');
}

/**
 * 설정에 따라 음악을 잠깐 멈추고 말하거나, 음악 위에 말한다.
 * resumeAt: 말한 뒤 이 위치(초)로 돌아가서 재생 (곡의 첫 부분을 놓치지 않게)
 */
async function sayOverMusic(parts, resumeAt = null, { interrupt = false } = {}) {
  const p = state.player;
  const session = state.session;
  const wasPlaying = p?.getPlayerState?.() === PLAYING;
  const pause = settings.mode === 'pause' && !state.resumeBlocked && wasPlaying;
  if (pause) {
    state.busy = true;
    p.pauseVideo();
  }
  // 곡 안내는 앞말("시작할게요" 등)이 끝나길 기다리고, 화면을 눌러 요청한 말은 바로 끊고 말한다.
  // (누른 순간에 말을 시작해야 아이폰에서 소리가 나므로 interrupt일 때는 기다리지 않는다.)
  if (!interrupt) await voice.idle();
  const ok = await voice.say(parts);
  if (ok) clearPadNote(NOTE_VOICE_FAILED);
  else if (!voice.speaking && state.started && !state.needsVoiceStart && !el.padNote.textContent) {
    // speaking이 참이면 새 말에 끊긴 것이라 실패가 아니다. 다른 안내가 떠 있으면 덮지 않는다.
    setMsg(el.padNote, NOTE_VOICE_FAILED, 'warn');
  }
  await voice.idle(); // 그 사이 화면을 눌러 끼어든 말까지 끝난 뒤에 음악을 튼다
  if (!pause) return;
  if (session !== state.session) {
    state.busy = false;
    return;
  }
  if (resumeAt != null) p.seekTo(resumeAt, true);
  state.resumeOk = false;
  state.resumedAt = performance.now();
  p.playVideo();
  state.lastT = resumeAt ?? p.getCurrentTime();
  state.busy = false;
  checkResumed(session);
}

// 말한 뒤 음악이 다시 나오는지 확인. 안 나오면 한 번 더 시도하고,
// 그래도 안 되면 목소리로 알리고 '화면을 누르면 다시 틀기'로 바꾼다.
function checkResumed(session, attempt = 1) {
  setTimeout(() => {
    if (session !== state.session || state.resumeOk || state.busy) return;
    const st = state.player?.getPlayerState?.();
    if (st === PLAYING || st === ENDED) return;
    if (st === BUFFERING && attempt < 4) { checkResumed(session, attempt + 1); return; }
    if (attempt === 1) {
      state.player.playVideo();
      checkResumed(session, 2);
      return;
    }
    state.resumeBlocked = true;
    state.needsTapToResume = true;
    setMsg(el.padNote, '음악이 멈췄어요. 판을 한 번 누르면 다시 틀어요. 앞으로는 음악을 멈추지 않고 말할게요.', 'warn');
    voice.say([PHRASES.stalled]);
  }, 2500);
}

// ── 화면 꺼짐 방지: 재생 중에만 잡고, 멈추거나 끝나면 푼다 ─────────────────
function wantScreen() {
  const st = state.player?.getPlayerState?.();
  return state.started && (st === PLAYING || st === BUFFERING || state.busy);
}
async function holdScreen() {
  if (!('wakeLock' in navigator) || state.wakeLock || state.wakeLockPending) return;
  state.wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
    state.wakeLock = lock;
    if (!wantScreen()) releaseScreen(); // 기다리는 사이 멈췄으면 바로 푼다
  } catch { /* 지원 안 함 */ } finally {
    state.wakeLockPending = false;
  }
}
function releaseScreen() {
  const lock = state.wakeLock;
  state.wakeLock = null;
  try { lock?.release(); } catch { /* 무시 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantScreen()) holdScreen();
});

// ── 유튜브 플레이어 ────────────────────────────────────────────────────────
let ytPromise = null;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve();
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 20000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
    document.head.appendChild(s);
  }).catch((err) => {
    ytPromise = null; // 다음에 다시 시도할 수 있게
    throw err;
  });
  return ytPromise;
}

async function ensurePlayer(videoId) {
  try {
    await loadYouTube();
  } catch {
    setMsg(el.loadMsg, '유튜브 플레이어를 불러오지 못했어요. 인터넷 연결을 확인하고 ‘열기’를 다시 눌러 주세요.', 'error');
    return false;
  }
  el.playerEmpty.hidden = true;
  if (state.player) {
    state.player.cueVideoById(videoId);
    return true;
  }
  await new Promise((resolve) => {
    state.player = new YT.Player('player', {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => { state.playerReady = true; resolve(); },
        onStateChange,
        onError,
      },
    });
  });
  return true;
}

function onStateChange(e) {
  if (e.data === PLAYING) {
    // 타이머가 막 끝났는데 안내 뒤 재개 전환이 뒤늦게 PLAYING이 되면 음악이 돌아오지 않게 다시 멈춘다.
    if (state.sleepTimerFired && !state.timerSpeaking && performance.now() - state.timerFiredAt < 8000) {
      state.player?.pauseVideo?.();
      return;
    }
    state.resumeOk = true;
    state.needsTapToResume = false;
    clearPadNote(NOTE_PAUSED);
    // 타이머 뒤 음악을 다시 틀었거나 일시적 오류 뒤 재생이 돌아오면 그 상태를 푼다. (타이머 안내를 말하는 중에는 둔다.)
    if (state.sleepTimerFired && !state.timerSpeaking) {
      state.sleepTimerFired = false;
      clearPadNote('취침 타이머로 멈췄어요.');
    }
    if (state.playerError) {
      clearPadNote(state.playerError);
      state.playerError = null;
      renderNow();
    }
    if (!state.started) beginSession(false);
    holdScreen();
    fillVideoTitle();
  } else if (e.data === PAUSED) {
    if (!state.busy) {
      releaseScreen(); // 사용자가 멈춤 → 화면이 꺼질 수 있게
      // 눈을 감고 있어도 판 한 번으로 다시 틀 수 있다는 것을 화면에 남긴다. (타이머로 멈춘 경우는 그 안내를 둔다.)
      if (state.started && !state.sleepTimerFired && !state.playerError) setMsg(el.padNote, NOTE_PAUSED, 'warn');
    }
  } else if (e.data === ENDED) {
    releaseScreen();
    setMsg(el.padNote, '영상이 끝났어요. 이제 화면이 꺼질 수 있어요.', '');
  } else if (e.data === CUED) {
    fillVideoTitle();
  }
}

function onError(e) {
  releaseScreen();
  const msg = {
    2: '영상 주소가 올바르지 않아요.',
    5: '이 기기에서 재생할 수 없는 영상이에요.',
    100: '영상을 찾을 수 없어요. 삭제됐거나 비공개일 수 있어요.',
    101: '이 영상은 올린 사람이 다른 사이트에서 재생하지 못하게 막아 두었어요. 다른 모음 영상을 써 주세요.',
    150: '이 영상은 올린 사람이 다른 사이트에서 재생하지 못하게 막아 두었어요. 다른 모음 영상을 써 주세요.',
    153: '유튜브가 재생을 거부했어요. 주소창에서 이 페이지를 직접 열었는지 확인해 주세요.',
  }[e.data] || `재생 오류가 났어요 (코드 ${e.data}).`;
  state.playerError = msg;
  // 잠자기 화면에서는 영상 위 메시지 칸이 숨겨져 있으므로 판 아래에 보여 준다.
  setMsg(state.started ? el.padNote : el.loadMsg, msg, 'error');
  renderNow();
}

function fillVideoTitle() {
  const data = state.player?.getVideoData?.();
  if (data?.title && !state.videoTitle) {
    state.videoTitle = data.title;
    renderVideoTitle();
    const cached = store.get(`tracks.${state.videoId}`, null);
    if (cached && !cached.title) store.set(`tracks.${state.videoId}`, { ...cached, title: data.title });
  }
}

// ── 곡이 바뀌었는지 0.25초마다 확인 ─────────────────────────────────────────
function tick() {
  const p = state.player;
  if (!p || !state.playerReady || state.busy || !p.getPlayerState) return;
  if (!state.started) return; // 시작 전·다른 영상을 여는 중의 재생 시각을 곡 목록에 대입하지 않는다
  checkSleepTimer();
  if (state.sleepTimerFired) return; // 타이머 안내 중에 곡 안내가 끼어 음악을 다시 틀지 않게
  const st = p.getPlayerState();
  const t = p.getCurrentTime() || 0;
  if (st !== PLAYING) {
    state.lastT = t;
    return;
  }
  // 광고를 직접 알아낼 방법은 없다. 영상 앞 광고 동안 본 영상 시각이 멈춰 있는 것을 확인했으므로,
  // 시각이 실제로 앞으로 흐를 때만 곡 바뀜을 판단한다. (중간 광고는 아직 확인하지 못함)
  const advancing = t > state.lastT + 0.01 && t > 0.05;
  state.lastT = t;
  if (!advancing || !state.tracks.length) return;

  const idx = indexAt(state.tracks, t);
  if (idx === state.currentIdx) return;
  state.currentIdx = idx;
  renderNow();
  if (idx < 0) return;
  if (state.startHint) {
    state.startHint = false;
    setMsg(el.padNote, '');
  }
  const tr = state.tracks[idx];
  addHistory(tr);
  const resumeAt = t - tr.t < 4 ? tr.t : null;
  sayOverMusic(announcement(idx), resumeAt);
}
setInterval(tick, 250);

/** 말로 읽는 곡 이름 문장: "지드래곤의 무제입니다." style을 주지 않으면 곡마다 말투가 돌아간다. */
function spokenSong(idx, style = idx) {
  return songSentence(state.tracks[idx], state.djScript?.entries?.[idx], style);
}

/** 곡이 바뀔 때 할 말 */
function announcement(idx) {
  if (settings.dj) return [djLine(state.tracks, idx, state.djScript)];
  const lead = settings.prefix ? (idx === 0 ? PHRASES.first : PHRASES.next) : '';
  return [lead, spokenSong(idx)];
}

// ── 취침 타이머 ────────────────────────────────────────────────────────────
function armSleepTimer() {
  state.sleepTimerFired = false;
  state.sleepAt = settings.sleepMinutes > 0 ? Date.now() + settings.sleepMinutes * 60000 : 0;
  renderTimer();
}
function checkSleepTimer() {
  if (!state.sleepAt || state.sleepTimerFired) return;
  renderTimer();
  if (Date.now() < state.sleepAt) return;
  const p = state.player;
  const st = p?.getPlayerState?.();
  // 음악이 나오는 중이 아니면 상태를 먼저 본다. 곡 안내 직후의 재생 전환 중(BUFFERING, CUED,
  // 자동 재개를 기다리는 PAUSED)이면 타이머를 지우지 말고 다음 tick으로 미룬다.
  // 미룸은 최대 1분이다. 자동 재개가 막혀 needsTapToResume가 되면 음악이 안 나오는 상태라 바로 끝낸다.
  const userStopped = st === ENDED || (st === PAUSED && (state.needsTapToResume || (state.resumeOk && performance.now() - state.resumedAt > 6000)));
  // 자동 재개 직후 6초 안의 PAUSED는 플레이어가 튀는 것일 수 있어 사용자 멈춤으로 보지 않고 아래 미룸으로 간다.
  if (st !== PLAYING && !userStopped) {
    if (Date.now() < state.sleepAt + 60000) return;
    try { p?.pauseVideo?.(); } catch { /* 무시 */ } // 끝내 재생이 안 잡히면 멈춘 채로 끝낸다
  }
  state.sleepTimerFired = true;
  state.timerFiredAt = performance.now();
  state.sleepAt = 0;
  if (st === PLAYING) {
    state.timerSpeaking = true;
    voice.say([PHRASES.timer]).then(() => {
      state.timerSpeaking = false;
      p.pauseVideo();
      releaseScreen();
    });
  } else {
    try { p?.pauseVideo?.(); } catch { /* 무시 */ } // 재개 전환이 뒤늦게 PLAYING이 되어도 음악이 돌아오지 않게 한다
    releaseScreen();
  }
  setMsg(el.padNote, '취침 타이머로 멈췄어요.', '');
  renderTimer();
}
let lastTimerText = '';
function renderTimer() {
  let text = '';
  if (state.sleepAt) {
    const min = Math.max(0, Math.ceil((state.sleepAt - Date.now()) / 60000));
    text = `${min}분 뒤 멈춤`;
  }
  if (text !== lastTimerText) {
    lastTimerText = text;
    el.timerNote.textContent = text;
    el.timerNote.hidden = !text;
  }
}

// ── 시작 / 잠자기 화면 / 메뉴 ──────────────────────────────────────────────
function beginSession(fromButton) {
  state.started = true;
  state.startFrom = null;
  document.body.classList.add('sleeping');
  document.body.classList.remove('morning');
  window.scrollTo(0, 0);
  setTab('play');
  el.menu.hidden = false;
  el.menu.textContent = '메뉴 열기';
  disarmMenu();
  el.start.hidden = true;
  el.tap.hidden = false;
  if (!fromButton) {
    // 영상의 재생 버튼으로 시작한 경우: 목소리는 아직 켜지지 않았다. 판 한 번으로 켠다.
    state.needsVoiceStart = true;
    armSleepTimer();
    if (state.tracks.length) setMsg(el.padNote, NOTE_VOICE_OFF, 'warn');
  }
  renderPicked();
  renderNow();
}

function startListening() {
  if (!state.playerReady) {
    if (state.videoId) {
      setMsg(el.loadMsg, '영상을 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요.', '');
    } else {
      setMsg(el.loadMsg, '먼저 위에 모음 영상 링크를 넣어 주세요.', 'warn');
      el.url.focus();
    }
    return;
  }
  if (state.playerError) {
    setMsg(el.loadMsg, state.playerError, 'error');
    return;
  }
  if (!state.tracks.length) {
    setMsg(el.tracksMsg, '곡 목록이 있어야 곡 이름을 알려드릴 수 있어요. 시간표를 붙여넣어 주세요.', 'warn');
    el.tracksEdit.open = true;
    el.tracksEdit.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  // 아이폰은 버튼을 누른 그 순간에 소리를 내야 이후에도 소리를 낼 수 있다.
  // (영상의 재생 버튼으로 시작했다가 판을 눌러 목소리를 켜는 경우는 '다시 시작'이 아니라 첫 시작이다.)
  const again = state.started && !state.needsVoiceStart;
  voice.unlock();
  const greeting = settings.dj ? djOpening(state.djScript) : PHRASES.start;
  voice.say([again ? PHRASES.restart : greeting]);
  state.resumeBlocked = false;
  state.needsTapToResume = false;
  state.needsVoiceStart = false;
  if (state.startFrom != null) state.player.seekTo(state.startFrom, true); // 목록에서 고른 곡부터. cued에서는 seekTo가 재생을 시작한다.
  state.player.playVideo();
  holdScreen();
  armSleepTimer();
  beginSession(true);
  setMsg(el.padNote, '');
  const session = state.session;
  setTimeout(() => {
    if (session !== state.session) return;
    const st = state.player.getPlayerState();
    // 첫 곡 안내 때문에 잠깐 멈춘 것일 수 있으니, 아직 아무 곡도 시작 안 했을 때만 안내한다.
    if (st !== PLAYING && st !== BUFFERING && !state.busy && state.currentIdx < 0) {
      setMsg(el.padNote, '광고가 나오는 중이면 끝난 뒤 시작돼요. 영상이 멈춰 있으면 위 영상의 재생 버튼을 한 번 눌러 주세요.', 'warn');
      state.startHint = true;
    }
  }, 2500);
}

/** 시작 버튼 글자: 시작 전에 곡을 골랐으면 그 곡부터 시작한다고 알린다. */
function renderStartLabel() {
  if (state.started) {
    el.start.textContent = '다시 시작';
    return;
  }
  const k = state.startFrom == null ? -1 : state.tracks.findIndex((tr) => tr.t === state.startFrom);
  el.start.textContent = k >= 0 ? `${k + 1}번째 곡부터 시작` : '재생 시작';
}

/** 목록의 곡 행에 고른 표시(data-picked)를 맞춘다. */
function renderPicked() {
  el.trackList.querySelectorAll('.track').forEach((b, k) => {
    if (state.startFrom != null && state.tracks[k]?.t === state.startFrom) b.dataset.picked = 'true';
    else delete b.dataset.picked;
  });
  renderStartLabel();
  renderMini();
}

/**
 * 아침 순서: 5~11시이고 최근 기록이 16시간 안이면 body.morning (저장·기록을 위로 올리는 것은 CSS).
 * 새 영상을 열거나 시작하면 beginSession·열기 쪽에서 해제한다.
 */
function applyMorning() {
  const hour = new Date().getHours();
  const last = store.get('history', [])[0];
  const on = hour >= 5 && hour < 12 && !!last && Date.now() - last.at < 16 * 3600000;
  document.body.classList.toggle('morning', on);
  if (on) {
    setSeg('history');
    setTab('lib');
  }
}

function wakeUi() {
  document.body.classList.remove('sleeping');
  el.menu.hidden = !state.started;
  el.menu.textContent = '잠자기 화면으로';
  disarmMenu();
  el.tap.hidden = true;
  el.start.hidden = false;
  renderStartLabel();
  renderDiagnostics();
}

/** 메뉴에서 나와 잠자기 화면으로 돌아간다. 말하지도 재생하지도 않고 화면만 바꾼다. */
function backToSleep() {
  if (!state.started) return;
  document.body.classList.add('sleeping');
  document.body.classList.remove('morning');
  window.scrollTo(0, 0);
  el.menu.textContent = '메뉴 열기';
  el.start.hidden = true;
  el.tap.hidden = false;
  renderNow();
}

// 잠자기 화면의 메뉴 버튼은 잠결에 닿아도 열리지 않게 두 번 눌러야 열린다.
let menuArmTimer = null;
function disarmMenu() {
  clearTimeout(menuArmTimer);
  menuArmTimer = null;
  if (document.body.classList.contains('sleeping')) el.menu.textContent = '메뉴 열기';
}

el.start.addEventListener('click', startListening);
el.menu.addEventListener('click', () => {
  if (!document.body.classList.contains('sleeping')) {
    backToSleep();
    return;
  }
  if (menuArmTimer) {
    wakeUi();
    return;
  }
  el.menu.textContent = '한 번 더';
  menuArmTimer = setTimeout(disarmMenu, 2500);
});

// 잠자기 화면의 큰 판 누르기 → 지금 곡 다시 말하고 저장 (음악이 멈춰 있었으면 다시 틀기)
el.tap.addEventListener('click', () => {
  const now = Date.now();
  if (now - state.lastTapAt < 1200) return; // 잠결에 여러 번 닿아도 한 번만
  state.lastTapAt = now;
  voice.unlock();
  const p = state.player;
  const st = p?.getPlayerState?.();
  // 끝났거나 타이머로 멈춘 뒤의 판 누르기: 마지막 곡을 저장하지 않고 아침 화면으로 나간다.
  if (state.sleepTimerFired || st === ENDED) {
    voice.say([state.sleepTimerFired ? '타이머로 음악을 껐어요.' : '영상이 끝났어요.']); // 눈 감은 사용자에게 알린다
    wakeUi();
    applyMorning();
    window.scrollTo(0, 0);
    return;
  }
  // 재생할 수 없는 영상이면 저장하지 않고 소리로 알린다.
  if (state.playerError) {
    voice.say(['이 영상은 재생할 수 없어요.']);
    return;
  }
  // 영상의 재생 버튼으로 시작해서 목소리가 아직 안 켜졌으면, 이 누름으로 목소리를 켠다.
  if (state.needsVoiceStart && state.tracks.length) {
    startListening();
    return;
  }
  // 음악이 멈춰 있으면(우리가 멈춘 게 아닐 때) 한 번 눌러 다시 튼다. 곡 저장은 하지 않는다.
  if (state.started && !state.busy && st !== PLAYING && (st !== BUFFERING || state.needsTapToResume)) {
    state.needsTapToResume = false;
    voice.say([PHRASES.resumed]); // unlock → say → playVideo (사이에 await 없음)
    p.playVideo();
    holdScreen();
    setMsg(el.padNote, '');
    return;
  }
  const tr = state.tracks[state.currentIdx];
  if (!tr) {
    sayOverMusic([PHRASES.beforeFirst], null, { interrupt: true });
    return;
  }
  let result = PHRASES.already;
  if (!isSaved(tr)) result = saveSong(tr) ? PHRASES.saved : PHRASES.saveFailed;
  el.pad.classList.remove('flash');
  void el.pad.offsetWidth;
  el.pad.classList.add('flash');
  sayOverMusic([PHRASES.now, spokenSong(state.currentIdx, 0), result], null, { interrupt: true });
});

// ── 영상 불러오기 ──────────────────────────────────────────────────────────
async function openVideo(input, { show = false } = {}) {
  const id = extractVideoId(input);
  if (!id) {
    setMsg(el.loadMsg, '유튜브 링크를 알아보지 못했어요. 유튜브 앱에서 공유 → 링크 복사 후 붙여넣어 주세요.', 'error');
    return;
  }
  setMsg(el.loadMsg, '');
  el.url.value = '';
  if (show) {
    scrollPos.play = 0;
    setTab('play');
  }
  state.session += 1;
  state.videoId = id;
  state.videoTitle = '';
  state.currentIdx = -1;
  state.lastT = 0;
  state.started = false;
  state.busy = false;
  state.sleepAt = 0;
  state.playerError = null;
  state.startFrom = null;
  state.needsVoiceStart = false;
  releaseScreen();
  renderTimer();
  store.set('last', id);
  wakeUi();

  const cached = store.get(`tracks.${id}`, null);
  if (cached?.title) state.videoTitle = cached.title;
  setTracks(cached?.tracks || [], cached?.source || '');
  renderVideoTitle();

  if (!(await ensurePlayer(id))) return;

  if (!cached?.tracks?.length) {
    if (settings.apiKey) await fetchTracklist(id);
    else {
      setMsg(el.tracksMsg, '이 영상의 곡 목록이 아직 없어요. 설명란이나 댓글의 시간표를 붙여넣거나, 설정에서 YouTube API 키를 넣으면 자동으로 찾아요.', 'warn');
      el.tracksEdit.open = true;
    }
  }
}

function apiError(json, status) {
  const reason = json?.error?.errors?.[0]?.reason || '';
  const message = json?.error?.message || '';
  if (reason === 'keyInvalid' || /API key not valid/i.test(message)) return 'API 키가 올바르지 않아요. 설정에서 다시 확인해 주세요.';
  if (/referer|referrer/i.test(message) || reason === 'ipRefererBlocked') {
    return `API 키가 이 주소(${location.host})에서 쓰도록 허용돼 있지 않아요. Google Cloud 콘솔의 키 제한에 이 주소를 추가해 주세요.`;
  }
  if (reason === 'quotaExceeded') return '오늘 쓸 수 있는 API 사용량을 다 썼어요. 내일 다시 하거나 시간표를 붙여넣어 주세요.';
  return `곡 목록을 가져오지 못했어요 (${status}${message ? `: ${message}` : ''}).`;
}

async function fetchTracklist(id) {
  setMsg(el.tracksMsg, '설명란과 댓글에서 곡 목록을 찾는 중…');
  const key = encodeURIComponent(settings.apiKey);
  const session = state.session;
  const version = state.tracksVersion;
  const stale = () => session !== state.session || id !== state.videoId;
  try {
    const vr = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${key}`);
    const vj = await vr.json();
    if (stale()) return;
    if (!vr.ok) throw new Error(apiError(vj, vr.status));
    const sn = vj.items?.[0]?.snippet;
    if (!sn) throw new Error('영상 정보를 찾지 못했어요. 비공개이거나 삭제된 영상일 수 있어요.');
    state.videoTitle = sn.title || state.videoTitle;
    renderVideoTitle();

    let picked = parseTracklist(sn.description).length >= 3 ? pickTracklist(sn.description) : null;
    if (!picked) {
      const cr = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${id}&maxResults=40&order=relevance&textFormat=plainText&key=${key}`);
      const cj = await cr.json();
      if (stale()) return;
      const comments = cr.ok ? (cj.items || []).map((it) => {
        const c = it.snippet.topLevelComment.snippet;
        return { text: c.textOriginal || c.textDisplay || '', isOwner: c.authorChannelId?.value === sn.channelId };
      }) : [];
      picked = pickTracklist(sn.description, comments);
    }
    if (version !== state.tracksVersion) return; // 그 사이 직접 넣은 목록이 있으면 덮지 않는다
    if (!picked) {
      setMsg(el.tracksMsg, '설명란과 댓글에서 시간표를 찾지 못했어요. 시간표를 직접 붙여넣어 주세요.', 'warn');
      el.tracksEdit.open = true;
      return;
    }
    setTracks(picked.tracks, picked.source);
    saveTracks();
    setMsg(el.tracksMsg, `${picked.source}에서 ${picked.tracks.length}곡을 찾았어요. 맞는지 한 번 훑어봐 주세요.`, 'ok');
  } catch (err) {
    if (stale()) return;
    setMsg(el.tracksMsg, err.message || '곡 목록을 가져오지 못했어요.', 'error');
    el.tracksEdit.open = true;
  }
}

function setTracks(tracks, source) {
  state.tracks = tracks;
  state.source = source;
  state.tracksVersion += 1;
  state.currentIdx = -1;
  state.startFrom = null; // 곡 목록이 바뀌면 고른 곡도 무효
  // 곡 목록 없이 시작했다가 목록이 나중에 생기면 그때 안내한다.
  if (state.started && state.needsVoiceStart && tracks.length) setMsg(el.padNote, NOTE_VOICE_OFF, 'warn');
  el.tracksInput.value = tracksToText(tracks);
  renderTracks();
  renderNow();
  refreshDjAndVoice();
}

function saveTracks() {
  if (!state.videoId) return;
  store.set(`tracks.${state.videoId}`, { tracks: state.tracks, source: state.source, title: state.videoTitle });
}

// 곡 대본(읽는 법 + DJ 멘트): 곡 목록이 그대로면 저장해 둔 대본을 쓰고, 바뀌었으면 OpenAI로 새로 쓴다.
// 읽는 법은 DJ를 꺼도 쓰므로 OpenAI 키가 있으면 항상 만든다.
// OpenAI 키가 없거나 실패하면 규칙으로 다듬은 이름과 준비된 멘트를 쓴다.
let djRun = 0;
// 곡 목록 위와 설정의 DJ 칸 두 곳에 보여 준다. DJ를 꺼도 읽는 법의 상태는 보여야 해서다.
function scriptMsg(text, kind = '') {
  setMsg(el.namesMsg, text, kind);
  setMsg(el.djMsg, text, kind);
}

async function ensureDjScript({ force = false } = {}) {
  const run = ++djRun;
  state.djScript = null;
  scriptMsg('');
  if (!state.tracks.length || !state.videoId) return;
  const tracks = state.tracks;
  const sig = trackSignature(tracks);
  const cached = store.get(`dj.${state.videoId}`, null);
  if (!force && cached?.sig === sig) {
    state.djScript = cached;
    return;
  }
  if (!settings.openaiKey) {
    const english = tracks.filter((tr) => /[A-Za-z]/.test(toSpeech(tr.text))).length;
    if (english) scriptMsg('OpenAI 키를 넣으면 영어 이름도 한글 발음으로 읽어요.');
    else if (settings.dj) scriptMsg('OpenAI 키가 없어서 미리 준비된 멘트를 돌려 써요. 키를 넣으면 곡마다 새 멘트를 써요.');
    return;
  }
  scriptMsg(`곡 이름 읽는 법과 멘트를 쓰는 중… ${tracks.length}곡이면 1분쯤 걸릴 수 있어요.`);
  fillVideoTitle(); // 영상 제목의 분위기를 멘트에 참고한다
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDjRequest({ videoTitle: state.videoTitle, tracks })),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(r.status === 401 ? 'OpenAI API 키가 올바르지 않아요.' : (data.error?.message || `HTTP ${r.status}`));
    if (run !== djRun) return; // 그 사이 곡 목록이나 영상이 바뀜
    const script = { sig, ...parseDjScript(responseText(data), tracks) };
    state.djScript = script;
    store.set(`dj.${state.videoId}`, script);
    const bad = script.entries.filter((e) => !isValidIntro(e?.intro)).length;
    scriptMsg(`${tracks.length}곡의 읽는 법과 멘트를 준비했어요.${settings.dj && bad ? ` ${bad}곡은 규칙에 안 맞아 준비된 멘트로 바꿨어요.` : ''} 곡을 누르면 읽을 문장을 볼 수 있어요.`, 'ok');
  } catch (err) {
    if (run === djRun) scriptMsg(`곡 이름 읽는 법을 받지 못해서 영어 이름은 그대로 읽어요: ${err.message}`, 'error');
  }
}

async function refreshDjAndVoice(options) {
  await ensureDjScript(options);
  renderTracks();
  renderNow(); // 읽는 법 대본이 오면 화면의 가수·제목 나눔도 달라질 수 있다
  prepareVoice();
}

// 음성 파일로 말하는 목소리면 할 말을 미리 만들어 둔다 (밤에 기다리지 않게).
let prepareRun = 0;
async function prepareVoice() {
  const run = ++prepareRun;
  setMsg(el.voiceMsg, '');
  if (!state.tracks.length) return;
  const texts = state.tracks.map((_, i) => spokenSong(i, 0)); // 판을 눌렀을 때는 곡 이름만 또렷하게 말한다
  if (settings.dj) {
    texts.push(djOpening(state.djScript));
    state.tracks.forEach((_, i) => texts.push(djLine(state.tracks, i, state.djScript)));
  } else {
    state.tracks.forEach((_, i) => texts.push(spokenSong(i)));
  }
  const stat = await voice.prepare(texts, (s) => {
    if (run === prepareRun) setMsg(el.voiceMsg, `목소리 준비 중… ${s.done} / ${s.total}`);
  });
  if (run !== prepareRun || !stat.total) return;
  if (stat.failed) setMsg(el.voiceMsg, `목소리 ${stat.failed}개를 만들지 못했어요: ${stat.error}`, 'error');
  else setMsg(el.voiceMsg, `목소리 준비 끝 (${stat.total}개). 밤에는 바로 재생돼요.`, 'ok');
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  document.body.classList.remove('morning'); // 새 영상을 열면 아침 순서를 푼다
  openVideo(el.url.value, { show: true });
});

el.paste.addEventListener('click', async () => {
  document.body.classList.remove('morning');
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      el.url.value = text.trim();
      openVideo(el.url.value, { show: true });
      return;
    }
  } catch { /* 권한 없음: 직접 붙여넣기 */ }
  el.url.focus();
  setMsg(el.loadMsg, '입력칸을 길게 눌러 붙여넣기 해 주세요.', '');
});

el.tracksApply.addEventListener('click', () => {
  const tracks = parseTracklist(el.tracksInput.value);
  if (!tracks.length) {
    setMsg(el.tracksMsg, '시간표를 찾지 못했어요. 줄마다 “04:13 가수 - 제목”처럼 시각이 들어 있어야 해요.', 'error');
    return;
  }
  setTracks(tracks, '직접 입력');
  saveTracks();
  setMsg(el.tracksMsg, `${tracks.length}곡을 적용했어요.`, 'ok');
});

// ── 저장한 노래 / 들은 기록 ────────────────────────────────────────────────
const songKey = (tr, vid = state.videoId) => `${vid}@${tr.t}`;
const isSaved = (tr) => store.get('saved', []).some((s) => s.key === songKey(tr));

/** 저장에 성공하면 true */
function saveSong(tr) {
  const saved = store.get('saved', []);
  saved.unshift({ key: songKey(tr), vid: state.videoId, t: tr.t, text: tr.text, from: state.videoTitle, at: Date.now() });
  const ok = store.set('saved', saved.slice(0, 500));
  setMsg(el.savedMsg, ok ? '' : '이 브라우저에 저장하지 못했어요. 개인 정보 보호 모드인지 확인해 주세요.', ok ? '' : 'error');
  renderSaved();
  renderHistory();
  return ok;
}

function addHistory(tr) {
  const history = store.get('history', []);
  const key = songKey(tr);
  // 같은 곡이 방금(30분 안) 기록됐으면 건너뛴다. 다음 날 밤 같은 곡은 새로 기록한다.
  if (history[0]?.key === key && Date.now() - history[0].at < 30 * 60000) return;
  history.unshift({ key, vid: state.videoId, t: tr.t, text: tr.text, from: state.videoTitle, at: Date.now() });
  store.set('history', history.slice(0, 300));
  renderHistory();
}

// 새벽에 들은 곡도 '전날 밤'으로 묶는다 (정오 전이면 하루 앞으로).
// 5~11시는 그 밤이 이미 끝난 아침이므로, 방금 지난 밤을 '어젯밤'으로 부른다.
function nightLabel(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  const now = new Date(nowMs);
  const morning = now.getHours() >= 5 && now.getHours() < 12;
  const tonight = new Date(now); // 지금 진행 중이거나 방금 끝난 밤
  if (tonight.getHours() < 12) tonight.setDate(tonight.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const before = new Date(tonight);
  before.setDate(tonight.getDate() - 1);
  if (sameDay(d, tonight)) return morning ? '어젯밤' : '오늘 밤';
  if (!morning && sameDay(d, before)) return '어젯밤';
  return `${d.getMonth() + 1}월 ${d.getDate()}일 밤`;
}

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 곡 이름의 밑줄(babymonster_deserve)은 검색어에서 공백으로 바꾼다.
const searchUrl = (text) => `https://www.youtube.com/results?search_query=${encodeURIComponent(text.replace(/_/g, ' '))}`;

function link(href, text, className = '') {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  if (className) a.className = className;
  return a;
}

function songLinks(item) {
  const wrap = document.createElement('span');
  wrap.className = 'links';
  wrap.append(
    link(searchUrl(item.text), '유튜브에서 찾기'),
    link(`https://www.youtube.com/watch?v=${item.vid}&t=${Math.floor(item.t)}s`, '그 부분 듣기'),
  );
  return wrap;
}

const thumbUrl = (vid) => `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;

function thumbImg(className, vid) {
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  img.loading = 'lazy';
  img.src = thumbUrl(vid);
  return img;
}

function renderSaved() {
  const saved = store.get('saved', []);
  el.savedList.replaceChildren();
  el.savedEmpty.hidden = saved.length > 0;
  el.copySaved.hidden = saved.length === 0;
  for (const item of saved) {
    const li = document.createElement('li');
    li.className = 'song';
    const { artist, title: songTitle } = songDisplay(item);
    const main = document.createElement('div');
    main.className = 'song-main';
    const title = document.createElement('p');
    title.className = 'song-title';
    title.textContent = songTitle;
    const meta = document.createElement('p');
    meta.className = 'song-meta';
    meta.textContent = `${artist ? `${artist} · ` : ''}${nightLabel(item.at)} ${clock(item.at)}에 저장`;
    main.append(title, meta);
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = '더 보기';
    more.setAttribute('aria-label', `${item.text} 더 보기`);
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      const open = li.dataset.open === undefined;
      if (open) li.dataset.open = '';
      else delete li.dataset.open;
      more.setAttribute('aria-expanded', String(open));
    });
    const row = document.createElement('div');
    row.className = 'song-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link-btn';
    del.textContent = '지우기';
    del.setAttribute('aria-label', `${item.text} 지우기`);
    // 지우기는 되돌릴 수 없으니 두 번 눌러야 지운다.
    let armTimer = null;
    del.addEventListener('click', () => {
      if (!armTimer) {
        del.textContent = '한 번 더';
        armTimer = setTimeout(() => { armTimer = null; del.textContent = '지우기'; }, 2500);
        return;
      }
      clearTimeout(armTimer);
      store.set('saved', store.get('saved', []).filter((s) => s.key !== item.key));
      renderSaved();
      renderHistory();
    });
    row.append(songLinks(item), del);
    li.append(thumbImg('song-thumb', item.vid), main, more, row);
    el.savedList.append(li);
  }
  renderSaveNow();
}

function renderHistory() {
  const history = store.get('history', []);
  const savedKeys = new Set(store.get('saved', []).map((s) => s.key));
  el.historyList.replaceChildren();
  el.historyEmpty.hidden = history.length > 0;
  let currentLabel = null;
  let ol = null;
  for (const item of history.slice(0, 120)) {
    const label = nightLabel(item.at);
    if (label !== currentLabel) {
      currentLabel = label;
      const h = document.createElement('h3');
      h.className = 'night';
      h.textContent = label;
      ol = document.createElement('ol');
      ol.className = 'history-night';
      el.historyList.append(h, ol);
    }
    const li = document.createElement('li');
    li.className = 'history-item';
    const { artist, title: songTitle } = songDisplay(item);
    const text = document.createElement('span');
    text.className = 'history-text';
    text.textContent = songTitle;
    const time = document.createElement('span');
    time.className = 'clock';
    time.textContent = artist ? `${artist} · ${clock(item.at)}` : clock(item.at);
    const find = link(searchUrl(item.text), '찾기', 'find');
    find.setAttribute('aria-label', `${item.text} 유튜브에서 찾기`);
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    const on = savedKeys.has(item.key);
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', `${item.text} ${on ? '저장됨' : '저장하기'}`);
    star.textContent = on ? '저장됨' : '저장';
    star.addEventListener('click', () => {
      const saved = store.get('saved', []);
      if (saved.some((s) => s.key === item.key)) {
        store.set('saved', saved.filter((s) => s.key !== item.key));
      } else {
        saved.unshift({ ...item, at: Date.now() });
        const ok = store.set('saved', saved.slice(0, 500));
        setMsg(el.savedMsg, ok ? '' : '이 브라우저에 저장하지 못했어요.', ok ? '' : 'error');
      }
      renderSaved();
      renderHistory();
    });
    li.append(thumbImg('song-thumb', item.vid), text, time, find, star);
    ol.append(li);
  }
}

el.copySaved.addEventListener('click', async () => {
  const text = store.get('saved', []).map((s) => s.text).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    el.copySaved.textContent = '복사했어요';
  } catch {
    el.copySaved.textContent = '복사 실패';
  }
  setTimeout(() => { el.copySaved.textContent = '목록 복사'; }, 1800);
});

// ── 탭 / 홈 선반 / 미니 플레이어 / 조작 버튼 (깨어 있을 때만 쓴다) ─────────────
const scrollPos = {}; // 탭마다 스크롤 위치를 기억한다
function setTab(name) {
  const prev = document.body.dataset.tab;
  if (prev !== name) {
    scrollPos[prev] = el.scroller.scrollTop;
    document.body.dataset.tab = name;
    el.scroller.scrollTop = scrollPos[name] || 0;
  }
  el.tabs.forEach((b) => {
    // 홈도 재생 탭 아래에 있으므로 재생 탭이 켜진 것으로 본다.
    if (b.dataset.go === name || (name === 'home' && b.dataset.go === 'play')) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'home') renderShelf();
  if (name === 'set' && settings.engine === 'typecast' && !state.tcVoices.length) loadTypecastVoices();
}

function setSeg(name) {
  document.body.dataset.seg = name;
  el.segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.seg === name)));
}

/** 들은 기록에서 영상마다 가장 최근 것만, 최신순으로 limit개 */
function pickShelf(history, titleOf, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const h of [...history].sort((a, b) => b.at - a.at)) {
    if (!h.vid || seen.has(h.vid)) continue;
    seen.add(h.vid);
    out.push({ vid: h.vid, title: titleOf(h.vid) || h.from || '제목 없는 영상', at: h.at });
    if (out.length >= limit) break;
  }
  return out;
}

function renderShelf() {
  const items = pickShelf(store.get('history', []), (vid) => store.get(`tracks.${vid}`, null)?.title);
  el.shelf.replaceChildren();
  el.shelfWrap.hidden = items.length === 0;
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'card';
    b.dataset.vid = it.vid;
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = it.title;
    const meta = document.createElement('span');
    meta.className = 'card-meta';
    meta.textContent = nightLabel(it.at);
    b.append(thumbImg('card-thumb', it.vid), title, meta);
    b.addEventListener('click', () => {
      if (it.vid === state.videoId) {
        setTab('play');
        return;
      }
      document.body.classList.remove('morning'); // 새 영상을 열면 아침 순서를 푼다
      openVideo(it.vid, { show: true });
    });
    el.shelf.append(b);
  }
}

// 값이 달라질 때만 DOM에 쓴다 (uiTick이 0.25초마다 부르므로)
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
function setAttr(node, name, val) {
  if (node.getAttribute(name) !== val) node.setAttribute(name, val);
}
function setDisabled(node, v) {
  if (node.disabled !== v) node.disabled = v;
}

let miniVid = null;
function renderMini() {
  if (miniVid !== state.videoId) {
    miniVid = state.videoId;
    if (miniVid) {
      el.miniThumb.src = thumbUrl(miniVid);
      el.plHead.style.setProperty('--thumb', `url("${thumbUrl(miniVid)}")`);
    } else {
      el.miniThumb.removeAttribute('src');
      el.plHead.style.removeProperty('--thumb');
    }
  }
  const cur = state.tracks[state.currentIdx];
  const title = cur ? songDisplay(cur, state.djScript?.entries?.[state.currentIdx]).title : (state.videoTitle || (state.videoId ? '영상' : ''));
  setText(el.miniTitle, title);
  renderMiniSub();
}

/** 미니 플레이어 둘째 줄: 가수, 또는 몇 곡 중 몇 번째, 취침 타이머 */
function renderMiniSub() {
  const n = state.tracks.length;
  const i = state.currentIdx;
  const cur = state.tracks[i];
  let text = '';
  if (cur) {
    text = songDisplay(cur, state.djScript?.entries?.[i]).artist || `${n}곡 중 ${i + 1}번째`;
  } else if (n) {
    const k = state.startFrom == null ? -1 : state.tracks.findIndex((tr) => tr.t === state.startFrom);
    text = k >= 0 ? `${n}곡 중 ${k + 1}번째부터` : `${n}곡`;
  }
  const timer = el.timerNote.hidden ? '' : el.timerNote.textContent;
  if (timer) text = text ? `${text} · ${timer}` : timer;
  setText(el.miniSub, text);
}

/** 지금 곡을 저장했는지 표시. 판 누르기와 같은 저장 키를 쓴다. */
function renderSaveNow() {
  const cur = state.tracks[state.currentIdx];
  el.saveNow.hidden = !cur;
  if (!cur) return;
  const on = isSaved(cur);
  setAttr(el.saveNow, 'aria-pressed', String(on));
  setAttr(el.saveNow, 'aria-label', on ? '저장한 노래에서 지우기' : '이 곡 저장하기');
}

// 말없이 저장하거나 지운다.
el.saveNow.addEventListener('click', () => {
  const tr = state.tracks[state.currentIdx];
  if (!tr) return;
  if (isSaved(tr)) {
    store.set('saved', store.get('saved', []).filter((s) => s.key !== songKey(tr)));
    renderSaved();
    renderHistory();
  } else {
    saveSong(tr);
  }
});

/** 곡 행·다음·이전: 위치만 옮기고 말은 하지 않는다. 안내는 tick이 곡 바뀜을 보고 한다. */
function jumpTo(i) {
  const tr = state.tracks[i];
  // 안내하려고 멈춘 동안(busy)에 옮기면 sayOverMusic이 이전 곡 위치로 되돌려 누름이 사라진다.
  if (!tr || !state.playerReady || state.busy || state.playerError) return;
  state.player.seekTo(tr.t, true);
  state.player.playVideo();
}

function stepTrack(dir) {
  voice.unlock();
  const i = state.currentIdx;
  const cur = state.tracks[i];
  // 이전: 곡이 3초 넘게 흘렀으면 이 곡 처음으로 (곡 번호가 그대로라 안내는 없다)
  if (dir < 0 && cur && state.playerReady && (state.player.getCurrentTime() || 0) - cur.t > 3) {
    jumpTo(i);
    return;
  }
  jumpTo(i + dir);
}

function isRunning() {
  const st = state.player?.getPlayerState?.();
  return st === PLAYING || (st === BUFFERING && !state.needsTapToResume);
}

function togglePlay() {
  if (!state.playerReady || !state.started || state.busy || state.playerError) return;
  if (isRunning()) {
    state.resumeOk = true; // checkResumed의 자동 재개를 끊고, 취침 타이머가 사용자 멈춤으로 본다
    state.player.pauseVideo();
    return;
  }
  voice.unlock();
  voice.say([PHRASES.resumed]); // unlock → say → playVideo (사이에 await 없음)
  state.needsTapToResume = false;
  state.needsVoiceStart = false;
  state.timerFiredAt = -1e9; // 사용자가 직접 튼 것이므로 타이머 직후 재생으로 보지 않는다
  state.player.playVideo();
  holdScreen();
  setMsg(el.padNote, '');
}

/** 진행 막대와 버튼 상태. tick과 별개이고 읽기만 한다. 오류가 나도 앱이 멈추지 않게 보호한다. */
function uiTick() {
  try {
    if (document.hidden || document.body.classList.contains('sleeping')) return;
    renderMiniSub();
    const p = state.player;
    if (!p || !state.playerReady || !state.started) return;
    const running = isRunning();
    const i = state.currentIdx;
    const n = state.tracks.length;
    const cur = state.tracks[i];
    const t = p.getCurrentTime() || 0;
    const start = cur?.t ?? 0;
    const end = state.tracks[i + 1]?.t ?? (p.getDuration?.() || 0);
    const span = end - start;
    const frac = span > 0 ? Math.min(1, Math.max(0, (t - start) / span)) : 0;
    const scale = `scaleX(${frac.toFixed(3)})`;
    if (el.progFill.style.transform !== scale) el.progFill.style.transform = scale;
    setText(el.progCur, formatTime(Math.max(0, t - start)));
    setText(el.progEnd, span > 0 ? formatTime(span) : '');
    const playing = String(running || state.busy);
    for (const b of [el.trToggle, el.miniToggle]) {
      if (b.dataset.playing !== playing) b.dataset.playing = playing;
      setAttr(b, 'aria-label', playing === 'true' ? '멈춤' : '재생');
    }
    setDisabled(el.trPrev, state.busy || i < 0 || (i === 0 && t - start <= 3));
    setDisabled(el.trNext, state.busy || i + 1 >= n);
    if (running && document.body.classList.contains('morning')) document.body.classList.remove('morning');
  } catch { /* 화면 갱신 오류가 재생과 안내를 막지 않게 한다 */ }
}
setInterval(uiTick, 250);

el.backHome.addEventListener('click', () => setTab('home'));
el.miniOpen.addEventListener('click', () => setTab('play'));
el.trPrev.addEventListener('click', () => stepTrack(-1));
el.trNext.addEventListener('click', () => stepTrack(1));
el.trToggle.addEventListener('click', togglePlay);
el.miniToggle.addEventListener('click', togglePlay);
el.tabs.forEach((b) => b.addEventListener('click', () => {
  const go = b.dataset.go === 'play' && !state.videoId ? 'home' : b.dataset.go; // 영상이 없으면 재생 탭은 빈 화면이라 홈으로
  if (document.body.dataset.tab === go) el.scroller.scrollTo({ top: 0, behavior: 'smooth' });
  else setTab(go);
}));
el.segBtns.forEach((b) => b.addEventListener('click', () => setSeg(b.dataset.seg)));
// 잠자기 화면으로 들어가면 안쪽 스크롤을 맨 위로 되돌려 판이 가려지지 않게 한다.
let wasSleeping = false;
new MutationObserver(() => {
  const now = document.body.classList.contains('sleeping');
  if (now && !wasSleeping) el.scroller.scrollTop = 0;
  wasSleeping = now;
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ── 곡 목록 / 지금 곡 표시 ─────────────────────────────────────────────────
function renderVideoTitle() {
  el.videoTitle.textContent = state.videoTitle || '';
  el.videoTitle.hidden = !state.videoTitle;
  el.topTitle.textContent = state.videoTitle || '';
  renderMini();
}

function renderTracks() {
  el.trackList.replaceChildren();
  const n = state.tracks.length;
  const src = state.source;
  el.trackMeta.textContent = !n ? ''
    : src === '직접 입력' ? `${n}곡 · 직접 입력`
      : src ? `${n}곡 · ${src}에서 찾음` : `${n}곡`;
  state.tracks.forEach((tr, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'track';
    b.dataset.n = String(i + 1);
    if (i === state.currentIdx) b.setAttribute('aria-current', 'true');
    const { artist, title } = songDisplay(tr, state.djScript?.entries?.[i]);
    const time = document.createElement('span');
    time.className = 'track-time';
    time.textContent = formatTime(tr.t);
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = title;
    b.append(time, name);
    if (artist) {
      const by = document.createElement('span');
      by.className = 'track-artist';
      by.textContent = artist;
      b.append(by);
    }
    // 실제로 어떻게 읽을지 미리 보여 준다.
    const line = document.createElement('span');
    line.className = 'track-dj';
    line.textContent = settings.dj ? djLine(state.tracks, i, state.djScript) : spokenSong(i);
    b.append(line);
    b.addEventListener('click', () => {
      if (!state.playerReady) return;
      if (state.started) {
        jumpTo(i);
        return;
      }
      // 시작 전에는 재생하지 않고 시작할 곡만 고른다. 같은 곡을 다시 누르면 고름을 푼다.
      state.startFrom = state.startFrom === tr.t ? null : tr.t;
      renderPicked();
    });
    li.append(b);
    el.trackList.append(li);
  });
  renderPicked();
}

function renderNow() {
  const i = state.currentIdx;
  const n = state.tracks.length;
  const cur = state.tracks[i];
  const next = state.tracks[i + 1];
  const shownIdx = cur ? i : 0; // 아직 곡이 안 시작했으면 첫 곡을 보여 준다
  const shown = state.tracks[shownIdx];
  const d = shown ? songDisplay(shown, state.djScript?.entries?.[shownIdx]) : null;
  el.nowLabel.textContent = cur ? `${n}곡 중 ${i + 1}번째` : (n ? `${n}곡 준비됨` : '곡 목록 없음');
  const emptyTitle = state.videoId ? '시간표를 넣으면 곡 이름을 읽어 드려요' : '모음 영상 링크를 넣어 주세요';
  el.nowTitle.textContent = d ? d.title : emptyTitle;
  el.nowArtist.textContent = d?.artist || '';
  el.nowArtist.hidden = !d?.artist;
  setText(el.tracksH, state.started ? '다음 트랙' : '곡 목록');
  // 화면 단계(계약): started→live, playerError→loaded, 곡 있음→ready, 영상 있음→loaded, 그 외 empty.
  document.body.dataset.stage = state.started ? 'live'
    : state.playerError ? 'loaded'
      : n ? 'ready'
        : state.videoId ? 'loaded' : 'empty';
  // 다이얼 눈금과 바늘 (CSS 변수)
  el.pad.style.setProperty('--n', String(Math.max(n - 1, 1)));
  el.pad.style.setProperty('--i', String(Math.max(i, 0)));
  el.nowNext.textContent = cur
    ? (next ? `다음은 ${songDisplay(next, state.djScript?.entries?.[i + 1]).title}` : '마지막 곡이에요')
    : (n ? '첫 곡부터 시작해요' : '');
  el.trackList.querySelectorAll('.track').forEach((b, k) => {
    if (k === i) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  renderSaveNow();
  renderMini();
}

// ── 설정 ──────────────────────────────────────────────────────────────────
function renderEngine() {
  el.deviceField.hidden = settings.engine !== 'device';
  el.typecastField.hidden = settings.engine !== 'typecast';
  el.openaiVoiceRow.hidden = settings.engine !== 'openai';
  el.djField.hidden = !settings.dj;
  el.prefixRow.hidden = settings.dj;
}

el.modeRadios.forEach((r) => {
  r.checked = r.value === settings.mode;
  r.addEventListener('change', () => {
    if (!r.checked) return;
    settings.mode = r.value;
    state.resumeBlocked = false;
    saveSettings();
  });
});
el.engineRadios.forEach((r) => {
  r.checked = r.value === settings.engine;
  r.addEventListener('change', () => {
    if (!r.checked) return;
    settings.engine = r.value;
    saveSettings();
    renderEngine();
    if (r.value === 'typecast') loadTypecastVoices();
    prepareVoice();
    renderDiagnostics();
  });
});
renderEngine();

el.dj.checked = settings.dj;
el.dj.addEventListener('change', () => {
  settings.dj = el.dj.checked;
  saveSettings();
  renderEngine();
  refreshDjAndVoice();
});
el.djRewrite.addEventListener('click', () => refreshDjAndVoice({ force: true }));

function renderVoiceSelect() {
  const voices = voice.koreanVoices();
  const keep = settings.voiceURI;
  el.voiceSelect.replaceChildren(new Option('자동 (추천)', ''));
  for (const v of voices) el.voiceSelect.append(new Option(`${v.name}${v.localService ? '' : ' (온라인)'}`, v.voiceURI));
  el.voiceSelect.value = voices.some((v) => v.voiceURI === keep) ? keep : '';
}
renderVoiceSelect();
window.speechSynthesis?.addEventListener?.('voiceschanged', renderVoiceSelect);
el.voiceSelect.addEventListener('change', () => {
  settings.voiceURI = el.voiceSelect.value;
  saveSettings();
});

for (const name of OPENAI_VOICES) el.openaiVoice.append(new Option(name, name));
el.openaiVoice.value = settings.openaiVoice;
el.openaiVoice.addEventListener('change', () => {
  settings.openaiVoice = el.openaiVoice.value;
  saveSettings();
  prepareVoice();
});
el.openaiKey.value = settings.openaiKey;
el.openaiSave.addEventListener('click', () => {
  settings.openaiKey = el.openaiKey.value.trim();
  saveSettings();
  setMsg(el.openaiMsg, settings.openaiKey ? '저장했어요. 이 기기에 보관하고, 음성이나 DJ 멘트를 만들 때만 OpenAI로 보내요.' : 'OpenAI 키를 지웠어요.', 'ok');
  refreshDjAndVoice();
  renderDiagnostics();
});

// ── Typecast 목소리 ───────────────────────────────────────────────────────
function renderTypecastVoices() {
  const byId = new Map(state.tcVoices.map((v) => [v.voice_id, v]));
  const recommended = state.tcRecommended.map((r) => byId.get(r.voice_id)).filter(Boolean);
  const recommendedIds = new Set(recommended.map((v) => v.voice_id));
  const mine = state.tcVoices.filter((v) => v.voice_type === 'custom');
  const rest = state.tcVoices.filter((v) => v.voice_type !== 'custom' && !recommendedIds.has(v.voice_id));
  el.typecastVoice.replaceChildren();
  if (!state.tcVoices.length) {
    showTypecastPlaceholder(settings.typecastKey ? '목소리가 없어요' : 'API 키를 넣으면 목록이 나와요');
    return;
  }
  for (const [label, voices] of [['내 목소리', mine], ['심야 라디오 추천', recommended], ['전체 목소리', rest]]) {
    if (!voices.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const v of voices) group.append(new Option(voiceLabel(v), v.voice_id));
    el.typecastVoice.append(group);
  }
  el.typecastVoice.value = settings.typecastVoice;
}

// 목록이 없을 때 빈 칸 대신 지금 상태를 보여 준다.
function showTypecastPlaceholder(text) {
  el.typecastVoice.replaceChildren(new Option(text, ''));
}

function chooseTypecastVoice(v) {
  Object.assign(settings, voiceSettings(v));
  saveSettings();
  el.typecastVoice.value = v.voice_id;
  prepareVoice();
  renderDiagnostics();
}

let tcLoading = false;
async function loadTypecastVoices() {
  if (!settings.typecastKey || tcLoading) return;
  tcLoading = true;
  setMsg(el.typecastMsg, '목소리 목록을 불러오는 중…');
  if (!state.tcVoices.length) showTypecastPlaceholder('불러오는 중…');
  try {
    const [voices, recommended] = await Promise.all([
      listVoices(settings.typecastKey),
      recommendVoices(settings.typecastKey).catch(() => []),
    ]);
    state.tcVoices = voices;
    state.tcRecommended = recommended;
    renderTypecastVoices();
    const current = voices.find((v) => v.voice_id === settings.typecastVoice);
    const first = voices.find((v) => v.voice_id === recommended[0]?.voice_id) || voices[0];
    if (!current && first) chooseTypecastVoice(first);
    setMsg(el.typecastMsg, voices.length
      ? `목소리 ${voices.length}개를 불러왔어요. 고른 뒤 ‘목소리 들어보기’로 확인해 보세요.`
      : '키는 맞지만 쓸 수 있는 목소리가 없어요. Typecast API 콘솔에서 플랜을 확인해 주세요.', voices.length ? 'ok' : 'warn');
  } catch (err) {
    setMsg(el.typecastMsg, err.message, 'error');
    if (!state.tcVoices.length) showTypecastPlaceholder('목록을 불러오지 못했어요');
  } finally {
    tcLoading = false;
  }
}

function saveTypecastKey() {
  settings.typecastKey = el.typecastKey.value.trim();
  saveSettings();
  state.tcVoices = [];
  state.tcRecommended = [];
  renderTypecastVoices();
  updateCloneButton();
  if (settings.typecastKey) loadTypecastVoices();
  else setMsg(el.typecastMsg, 'Typecast 키를 지웠어요.', 'ok');
}

// 저장 버튼을 누르지 않아도 키를 넣고 칸을 벗어나면 바로 저장한다.
function saveWhenChanged(input, current, save) {
  input.addEventListener('change', () => {
    if (input.value.trim() !== current()) save();
  });
}

el.typecastKey.value = settings.typecastKey;
el.typecastSave.addEventListener('click', saveTypecastKey);
saveWhenChanged(el.typecastKey, () => settings.typecastKey, saveTypecastKey);
saveWhenChanged(el.openaiKey, () => settings.openaiKey, () => el.openaiSave.click());
renderTypecastVoices();
el.typecastVoice.addEventListener('change', () => {
  const v = state.tcVoices.find((x) => x.voice_id === el.typecastVoice.value);
  if (v) chooseTypecastVoice(v);
});

// ── 내 목소리 등록 ────────────────────────────────────────────────────────
el.readingScript.textContent = READING_SCRIPT;

function updateCloneButton() {
  el.cloneBtn.disabled = !(state.cloneWav && el.cloneConsent.checked && settings.typecastKey);
}
el.cloneConsent.addEventListener('change', updateCloneButton);

async function useVoiceSample(blob) {
  state.cloneWav = null;
  el.voicePreview.hidden = true;
  updateCloneButton();
  setMsg(el.cloneMsg, '음성을 확인하는 중…');
  try {
    const { wav, seconds, trimmed } = await toCloneWav(blob);
    state.cloneWav = wav;
    el.voicePreview.src = URL.createObjectURL(wav);
    el.voicePreview.hidden = false;
    setMsg(el.cloneMsg, `${seconds}초 준비됐어요.${trimmed ? ' 150초가 넘어서 앞부분만 써요.' : ''} 들어 보고 괜찮으면 아래 버튼을 눌러 주세요.`, 'ok');
  } catch (err) {
    setMsg(el.cloneMsg, `음성을 쓸 수 없어요. ${err.message}`, 'error');
  }
  updateCloneButton();
}

async function stopRecording() {
  clearInterval(state.recordTimer);
  const recorder = state.recorder;
  state.recorder = null;
  el.recordBtn.textContent = '다시 녹음하기';
  useVoiceSample(await recorder.stop());
}

el.recordBtn.addEventListener('click', async () => {
  if (state.recorder) {
    stopRecording();
    return;
  }
  if (state.player?.getPlayerState?.() === PLAYING) state.player.pauseVideo();
  try {
    state.recorder = await startRecording();
  } catch {
    setMsg(el.cloneMsg, '마이크를 쓸 수 없어요. 설정에서 이 앱의 마이크 권한을 허용하거나, 음성 메모 파일을 골라 주세요.', 'error');
    return;
  }
  const started = Date.now();
  const show = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    el.recordBtn.textContent = `녹음 끝내기 (${sec}초)`;
    if (sec >= 150) stopRecording();
  };
  show();
  state.recordTimer = setInterval(show, 500);
  setMsg(el.cloneMsg, '위 글을 차분하게 읽어 주세요. 1분쯤이면 충분해요.');
});

el.voiceFile.addEventListener('change', () => {
  const file = el.voiceFile.files?.[0];
  if (file) useVoiceSample(file);
});

el.cloneBtn.addEventListener('click', async () => {
  el.cloneBtn.disabled = true;
  setMsg(el.cloneMsg, '내 목소리를 만드는 중…');
  try {
    const name = el.cloneName.value.trim() || '내 목소리';
    const made = await createClone({ key: settings.typecastKey, wav: state.cloneWav, name });
    if (made.status === 'failed') throw new Error('목소리를 만들지 못했어요. 조용한 곳에서 다시 녹음해 주세요.');
    Object.assign(settings, { typecastVoice: made.voice_id, typecastModel: made.model, typecastEmotion: '' });
    saveSettings();
    await loadTypecastVoices();
    el.typecastVoice.value = made.voice_id;
    prepareVoice();
    setMsg(el.cloneMsg, '내 목소리를 만들었어요. ‘목소리 들어보기’로 확인해 보세요.', 'ok');
  } catch (err) {
    setMsg(el.cloneMsg, err.message, 'error');
    updateCloneButton();
  }
});

el.rate.value = String(settings.rate);
el.rateOut.textContent = `${Number(settings.rate).toFixed(1)}배`;
el.rate.addEventListener('input', () => {
  settings.rate = Number(el.rate.value);
  el.rateOut.textContent = `${settings.rate.toFixed(1)}배`;
  saveSettings();
});
el.prefix.checked = settings.prefix;
el.prefix.addEventListener('change', () => {
  settings.prefix = el.prefix.checked;
  saveSettings();
});
// 설정의 '목소리 들어보기'와 잠자기 단계의 복구 도구가 같이 쓴다.
function testVoice() {
  voice.unlock();
  if (state.tracks.length) voice.say(announcement(0));
  else voice.say([PHRASES.next, '아이유, 밤편지']);
}
el.testVoice.addEventListener('click', testVoice);
el.rescueTest?.addEventListener('click', testVoice);
// 음성 진단: 설정과 진단을 열고 그 자리로 간다. 잠자기 화면이면 화면만 먼저 깨운다(말·재생 없음).
el.diagOpen?.addEventListener('click', () => {
  if (document.body.classList.contains('sleeping')) wakeUi();
  setTab('set');
  el.diag.open = true;
  renderDiagnostics();
  el.diag.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

el.sleepTimer.value = String(settings.sleepMinutes);
el.sleepTimer.addEventListener('change', () => {
  settings.sleepMinutes = Number(el.sleepTimer.value);
  saveSettings();
  if (state.started) armSleepTimer();
});

el.apiKey.value = settings.apiKey;
el.apiSave.addEventListener('click', () => {
  settings.apiKey = el.apiKey.value.trim();
  saveSettings();
  setMsg(el.apiMsg, settings.apiKey ? '저장했어요. 이 기기에 보관하고, 곡 목록을 찾을 때만 Google로 보내요.' : 'API 키를 지웠어요.', 'ok');
  if (settings.apiKey && state.videoId && !state.tracks.length) fetchTracklist(state.videoId);
});

// ── 음성 진단 ─────────────────────────────────────────────────────────────
function renderDiagnostics() {
  if (el.diag.open) el.diagText.textContent = voice.diagnostics();
}
voice.onChange(renderDiagnostics);
el.diag.addEventListener('toggle', renderDiagnostics);
el.diagCopy.addEventListener('click', async () => {
  const text = voice.diagnostics();
  el.diagText.textContent = text;
  try {
    await navigator.clipboard.writeText(text);
    el.diagCopy.textContent = '복사했어요';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el.diagText);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    el.diagCopy.textContent = '선택했어요. 길게 눌러 복사하세요';
  }
  setTimeout(() => { el.diagCopy.textContent = '진단 내용 복사'; }, 2500);
});

// ── 처음 화면 ─────────────────────────────────────────────────────────────
updateCloneButton();
if (settings.engine === 'typecast') loadTypecastVoices();
renderSaved();
renderHistory();
renderNow();
setSeg('saved');
setTab('home');
applyMorning();
const fromQuery = new URLSearchParams(location.search).get('v');
const last = fromQuery || store.get('last', null);
if (fromQuery) setTab('play');
if (last) openVideo(last);
