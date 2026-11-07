import {
  parseTracklist, pickTracklist, toSpeech, extractVideoId, indexAt, formatTime, tracksToText,
} from './tracklist.js?v=20261107c';
import { createVoice, PHRASES, OPENAI_VOICES } from './voice.js?v=20261107c';
import {
  buildDjRequest, responseText, parseDjScript, trackSignature, isValidIntro, djLine, djOpening, songSentence,
} from './dj.js?v=20261107c';
import {
  listVoices, recommendVoices, voiceSettings, voiceLabel, createClone, toCloneWav, startRecording, READING_SCRIPT,
} from './typecast.js?v=20261107c';

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
};

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
  tracksInput: $('#tracks-input'), tracksApply: $('#tracks-apply'), tracksMsg: $('#tracks-msg'), voiceMsg: $('#voice-msg'),
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
  settingsBox: $('#settings'), sleepTimer: $('#sleep-timer'),
  apiKey: $('#api-key'), apiSave: $('#api-save'), apiMsg: $('#api-msg'),
  diag: $('#diag'), diagText: $('#diag-text'), diagCopy: $('#diag-copy'),
};

function setMsg(node, text, kind = '') {
  node.textContent = text;
  node.dataset.kind = kind;
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
  await voice.say(parts);
  await voice.idle(); // 그 사이 화면을 눌러 끼어든 말까지 끝난 뒤에 음악을 튼다
  if (!pause) return;
  if (session !== state.session) {
    state.busy = false;
    return;
  }
  if (resumeAt != null) p.seekTo(resumeAt, true);
  state.resumeOk = false;
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
    setMsg(el.padNote, '말한 뒤 음악을 자동으로 다시 틀지 못했어요. 이 판을 한 번 누르면 다시 틀어요. 앞으로는 음악을 멈추지 않고 말할게요.', 'warn');
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
    state.resumeOk = true;
    state.needsTapToResume = false;
    if (!state.started) beginSession(false);
    holdScreen();
    fillVideoTitle();
  } else if (e.data === PAUSED) {
    if (!state.busy) releaseScreen(); // 사용자가 멈춤 → 화면이 꺼질 수 있게
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
  setMsg(el.loadMsg, msg, 'error');
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
  checkSleepTimer();
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
  state.sleepTimerFired = true;
  state.sleepAt = 0;
  const p = state.player;
  if (p?.getPlayerState?.() === PLAYING) {
    voice.say([PHRASES.timer]).then(() => {
      p.pauseVideo();
      releaseScreen();
    });
  } else {
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
  document.body.classList.add('sleeping');
  window.scrollTo(0, 0);
  el.menu.hidden = false;
  el.start.hidden = true;
  el.tap.hidden = false;
  if (!fromButton) {
    armSleepTimer();
    setMsg(el.padNote, '아이폰에서는 ‘재생 시작’ 버튼으로 시작해야 목소리가 나와요. ‘메뉴 열기’ → ‘다시 시작’을 눌러 주세요.', 'warn');
  }
  renderNow();
}

function startListening() {
  if (!state.playerReady) {
    setMsg(el.loadMsg, '먼저 위에 모음 영상 링크를 넣어 주세요.', 'warn');
    el.url.focus();
    return;
  }
  if (!state.tracks.length) {
    setMsg(el.tracksMsg, '곡 목록이 있어야 곡 이름을 알려드릴 수 있어요. 시간표를 붙여넣어 주세요.', 'warn');
    el.tracksEdit.open = true;
    el.tracksEdit.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  // 아이폰은 버튼을 누른 그 순간에 소리를 내야 이후에도 소리를 낼 수 있다.
  const again = state.started;
  voice.unlock();
  const greeting = settings.dj ? djOpening(state.djScript) : PHRASES.start;
  voice.say([again ? PHRASES.restart : greeting]);
  state.resumeBlocked = false;
  state.needsTapToResume = false;
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
      setMsg(el.padNote, '광고가 나오는 중이면 끝난 뒤 시작돼요. 영상이 멈춰 있으면 위 영상의 ▶를 한 번 눌러 주세요.', 'warn');
      state.startHint = true;
    }
  }, 2500);
}

function wakeUi() {
  document.body.classList.remove('sleeping');
  el.menu.hidden = true;
  el.tap.hidden = true;
  el.start.hidden = false;
  el.start.textContent = state.started ? '다시 시작' : '재생 시작';
  renderDiagnostics();
}

el.start.addEventListener('click', startListening);
el.menu.addEventListener('click', wakeUi);

// 잠자기 화면의 큰 판 누르기 → 지금 곡 다시 말하고 저장 (음악이 멈춰 있었으면 다시 틀기)
el.tap.addEventListener('click', () => {
  const now = Date.now();
  if (now - state.lastTapAt < 1200) return; // 잠결에 여러 번 닿아도 한 번만
  state.lastTapAt = now;
  voice.unlock();
  const p = state.player;
  if (state.needsTapToResume && p?.getPlayerState?.() !== PLAYING) {
    state.needsTapToResume = false;
    p.playVideo();
    holdScreen();
    setMsg(el.padNote, '');
    voice.say([PHRASES.resumed]);
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
async function openVideo(input) {
  const id = extractVideoId(input);
  if (!id) {
    setMsg(el.loadMsg, '유튜브 링크를 알아보지 못했어요. 유튜브 앱에서 공유 → 링크 복사 후 붙여넣어 주세요.', 'error');
    return;
  }
  setMsg(el.loadMsg, '');
  state.session += 1;
  state.videoId = id;
  state.videoTitle = '';
  state.currentIdx = -1;
  state.lastT = 0;
  state.started = false;
  state.busy = false;
  state.sleepAt = 0;
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
async function ensureDjScript({ force = false } = {}) {
  const run = ++djRun;
  state.djScript = null;
  setMsg(el.djMsg, '');
  if (!state.tracks.length || !state.videoId) return;
  const tracks = state.tracks;
  const sig = trackSignature(tracks);
  const cached = store.get(`dj.${state.videoId}`, null);
  if (!force && cached?.sig === sig) {
    state.djScript = cached;
    setMsg(el.djMsg, `DJ 멘트 ${tracks.length}곡 준비돼 있어요.`, 'ok');
    return;
  }
  if (!settings.openaiKey) {
    setMsg(el.djMsg, 'OpenAI 키가 없어서 미리 준비된 멘트를 돌려 써요. 키를 넣으면 곡마다 새 멘트를 쓰고 곡 이름도 더 자연스럽게 읽어요.', '');
    return;
  }
  setMsg(settings.dj ? el.djMsg : el.voiceMsg, `곡 이름 읽는 법과 멘트를 쓰는 중… ${tracks.length}곡이면 1분쯤 걸릴 수 있어요.`);
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
    setMsg(el.djMsg, `DJ 멘트 ${tracks.length}곡을 썼어요.${bad ? ` ${bad}곡은 규칙에 안 맞아 준비된 멘트로 바꿨어요.` : ''} 곡 목록에서 읽어 볼 수 있어요.`, 'ok');
  } catch (err) {
    if (run === djRun) setMsg(el.djMsg, `DJ 멘트를 쓰지 못해 준비된 멘트를 써요: ${err.message}`, 'warn');
  }
}

async function refreshDjAndVoice(options) {
  await ensureDjScript(options);
  renderTracks();
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
  openVideo(el.url.value);
});

el.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      el.url.value = text.trim();
      openVideo(el.url.value);
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
function nightLabel(ms) {
  const d = new Date(ms);
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  const today = new Date();
  if (today.getHours() < 12) today.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return '오늘 밤';
  if (sameDay(d, yesterday)) return '어젯밤';
  return `${d.getMonth() + 1}월 ${d.getDate()}일 밤`;
}

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const searchUrl = (text) => `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;

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

function renderSaved() {
  const saved = store.get('saved', []);
  el.savedList.replaceChildren();
  el.savedEmpty.hidden = saved.length > 0;
  el.copySaved.hidden = saved.length === 0;
  for (const item of saved) {
    const li = document.createElement('li');
    li.className = 'song';
    const title = document.createElement('p');
    title.className = 'song-title';
    title.textContent = item.text;
    const meta = document.createElement('p');
    meta.className = 'song-meta';
    meta.textContent = `${nightLabel(item.at)} ${clock(item.at)}에 저장`;
    const row = document.createElement('div');
    row.className = 'song-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link-btn';
    del.textContent = '지우기';
    del.setAttribute('aria-label', `${item.text} 지우기`);
    del.addEventListener('click', () => {
      store.set('saved', store.get('saved', []).filter((s) => s.key !== item.key));
      renderSaved();
      renderHistory();
    });
    row.append(songLinks(item), del);
    li.append(title, meta, row);
    el.savedList.append(li);
  }
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
    const time = document.createElement('span');
    time.className = 'clock';
    time.textContent = clock(item.at);
    const text = document.createElement('span');
    text.className = 'history-text';
    text.textContent = item.text;
    const find = link(searchUrl(item.text), '찾기', 'find');
    find.setAttribute('aria-label', `${item.text} 유튜브에서 찾기`);
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    const on = savedKeys.has(item.key);
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', `${item.text} ${on ? '저장됨' : '저장하기'}`);
    star.textContent = on ? '★' : '☆';
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
    li.append(time, text, find, star);
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

// ── 곡 목록 / 지금 곡 표시 ─────────────────────────────────────────────────
function renderVideoTitle() {
  el.videoTitle.textContent = state.videoTitle || '';
  el.videoTitle.hidden = !state.videoTitle;
}

function renderTracks() {
  el.trackList.replaceChildren();
  const n = state.tracks.length;
  el.trackMeta.textContent = n ? `${n}곡 · ${state.source}` : '';
  state.tracks.forEach((tr, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'track';
    if (i === state.currentIdx) b.setAttribute('aria-current', 'true');
    const time = document.createElement('span');
    time.className = 'track-time';
    time.textContent = formatTime(tr.t);
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = tr.text;
    b.append(time, name);
    // 실제로 어떻게 읽을지 미리 보여 준다.
    const line = document.createElement('span');
    line.className = 'track-dj';
    line.textContent = settings.dj ? djLine(state.tracks, i, state.djScript) : spokenSong(i);
    b.append(line);
    b.addEventListener('click', () => {
      if (!state.playerReady) return;
      state.player.seekTo(tr.t, true);
      if (!state.started) startListening();
      else state.player.playVideo();
    });
    li.append(b);
    el.trackList.append(li);
  });
}

function renderNow() {
  const i = state.currentIdx;
  const n = state.tracks.length;
  const cur = state.tracks[i];
  const next = state.tracks[i + 1];
  el.nowLabel.textContent = cur ? `지금 곡 · ${i + 1} / ${n}` : (n ? `${n}곡 준비됨` : '곡 목록 없음');
  const emptyTitle = state.videoId ? '아래 ‘곡 목록’에 시간표를 넣어 주세요' : '모음 영상 링크를 넣어 주세요';
  el.nowTitle.textContent = cur ? cur.text : (n ? state.tracks[0].text : emptyTitle);
  el.nowNext.textContent = cur ? (next ? `다음 · ${next.text}` : '마지막 곡') : (n ? '첫 곡' : '');
  el.trackList.querySelectorAll('.track').forEach((b, k) => {
    if (k === i) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
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
el.settingsBox.addEventListener('toggle', () => {
  if (el.settingsBox.open && settings.engine === 'typecast' && !state.tcVoices.length) loadTypecastVoices();
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
el.testVoice.addEventListener('click', () => {
  voice.unlock();
  if (state.tracks.length) voice.say(announcement(0));
  else voice.say([PHRASES.next, '아이유, 밤편지']);
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
const fromQuery = new URLSearchParams(location.search).get('v');
const last = fromQuery || store.get('last', null);
if (last) {
  el.url.value = fromQuery ? fromQuery : `https://youtu.be/${last}`;
  openVideo(last);
}
