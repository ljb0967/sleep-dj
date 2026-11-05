import {
  parseTracklist, pickTracklist, toSpeech, extractVideoId, indexAt, formatTime, tracksToText,
} from './tracklist.js';

const $ = (sel) => document.querySelector(sel);
const PLAYING = 1;
const BUFFERING = 3;
const ENDED = 0;
const CUED = 5;

// ── 이 기기에만 저장 (localStorage가 막혀 있어도 앱은 동작) ──────────────────
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`sdj.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(`sdj.${key}`, JSON.stringify(val)); } catch { /* 저장 불가: 무시 */ }
  },
};

const settings = { mode: 'pause', rate: 1, prefix: true, apiKey: '', ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

const state = {
  player: null,
  playerReady: false,
  videoId: null,
  videoTitle: '',
  tracks: [],
  source: '',
  started: false,
  busy: false,          // 안내 멘트를 말하는 중 (이때 멈춘 건 사용자가 멈춘 게 아님)
  currentIdx: -1,
  lastT: 0,
  wakeLock: null,
  resumeBlocked: false,
};

// ── 화면 요소 ─────────────────────────────────────────────────────────────
const el = {
  form: $('#load-form'), url: $('#url-input'), paste: $('#paste-btn'), loadMsg: $('#load-msg'),
  playerEmpty: $('#player-empty'), videoTitle: $('#video-title'),
  pad: $('#pad'), start: $('#start-btn'), tap: $('#tap-area'),
  nowLabel: $('#now-label'), nowTitle: $('#now-title'), nowNext: $('#now-next'), padNote: $('#pad-note'),
  menu: $('#menu-btn'),
  trackMeta: $('#tracks-meta'), trackList: $('#track-list'), tracksEdit: $('#tracks-edit'),
  tracksInput: $('#tracks-input'), tracksApply: $('#tracks-apply'), tracksMsg: $('#tracks-msg'),
  savedList: $('#saved-list'), savedEmpty: $('#saved-empty'), copySaved: $('#copy-saved'),
  historyList: $('#history-list'), historyEmpty: $('#history-empty'),
  modeRadios: document.querySelectorAll('input[name="mode"]'),
  rate: $('#rate'), rateOut: $('#rate-out'), prefix: $('#prefix'), testVoice: $('#test-voice'),
  apiKey: $('#api-key'), apiSave: $('#api-save'), apiMsg: $('#api-msg'),
};

function setMsg(node, text, kind = '') {
  node.textContent = text;
  node.dataset.kind = kind;
}

// ── 목소리 ────────────────────────────────────────────────────────────────
let koVoice = null;
function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const ko = voices.filter((v) => /^ko/i.test(v.lang));
  koVoice = ko.find((v) => v.localService && /yuna|유나/i.test(v.name)) || ko.find((v) => v.localService) || ko[0] || null;
}
window.speechSynthesis?.addEventListener?.('voiceschanged', pickVoice);
pickVoice();

function speak(text) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || !text) { resolve(false); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    if (koVoice) u.voice = koVoice;
    u.rate = settings.rate;
    u.volume = 1;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // 아이폰에서 onend가 안 오는 경우가 있어서, 넉넉한 시간이 지나면 끝난 것으로 본다.
    const timer = setTimeout(() => finish(false), 2500 + (text.length * 190) / settings.rate);
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    synth.speak(u);
  });
}

/**
 * 설정에 따라 음악을 잠깐 멈추고 말하거나, 음악 위에 말한다.
 * resumeAt: 말한 뒤 이 위치(초)로 돌아가서 재생 (곡의 첫 부분을 놓치지 않게)
 */
async function sayOverMusic(text, resumeAt = null) {
  const p = state.player;
  const wasPlaying = p?.getPlayerState?.() === PLAYING;
  const pause = settings.mode === 'pause' && !state.resumeBlocked && wasPlaying;
  state.busy = true;
  try {
    if (pause) p.pauseVideo();
    await speak(text);
    if (pause) {
      if (resumeAt != null) p.seekTo(resumeAt, true);
      p.playVideo();
      state.lastT = resumeAt ?? p.getCurrentTime();
      checkResumed();
    }
  } finally {
    state.busy = false;
  }
}

// 말한 뒤 음악이 다시 안 나오면 한 번 더 시도하고, 그래도 안 되면 '음악 위에 말하기'로 바꾼다.
function checkResumed(attempt = 1) {
  setTimeout(() => {
    const st = state.player?.getPlayerState?.();
    if (st === PLAYING || st === BUFFERING || st === ENDED || state.busy) return;
    if (attempt === 1) {
      state.player.playVideo();
      checkResumed(2);
    } else {
      state.resumeBlocked = true;
      setMsg(el.padNote, '말한 뒤 음악을 자동으로 다시 틀 수 없었어요. 이제부터는 음악을 멈추지 않고 말할게요. 영상의 ▶를 눌러 주세요.', 'warn');
    }
  }, 2500);
}

// ── 화면 꺼짐 방지 (영상이 끝나면 풀어서 폰이 잠들 수 있게) ─────────────────
async function holdScreen() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch { /* 지원 안 함 */ }
}
function releaseScreen() {
  try { state.wakeLock?.release(); } catch { /* 무시 */ }
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.player?.getPlayerState?.() === PLAYING) holdScreen();
});

// ── 유튜브 플레이어 ────────────────────────────────────────────────────────
const ytReady = new Promise((resolve) => {
  if (window.YT?.Player) { resolve(); return; }
  window.onYouTubeIframeAPIReady = resolve;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => setMsg(el.loadMsg, '유튜브 플레이어를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', 'error');
  document.head.appendChild(s);
});

async function ensurePlayer(videoId) {
  await ytReady;
  el.playerEmpty.hidden = true;
  if (state.player) {
    state.player.cueVideoById(videoId);
    return;
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
}

function onStateChange(e) {
  if (e.data === PLAYING) {
    holdScreen();
    if (!state.started) beginSession(false);
    fillVideoTitle();
  } else if (e.data === ENDED) {
    releaseScreen();
    setMsg(el.padNote, '영상이 끝났어요. 이제 화면이 꺼질 수 있어요.', '');
  } else if (e.data === CUED) {
    fillVideoTitle();
  }
}

function onError(e) {
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
  const st = p.getPlayerState();
  const t = p.getCurrentTime() || 0;
  if (st !== PLAYING) {
    state.lastT = t;
    return;
  }
  // 광고가 나오는 동안에는 본 영상 시간이 멈춰 있으니, 시간이 실제로 흐를 때만 본다.
  const advancing = t > state.lastT + 0.01 && t > 0.05;
  state.lastT = t;
  if (!advancing || !state.tracks.length) return;

  const idx = indexAt(state.tracks, t);
  if (idx === state.currentIdx) return;
  state.currentIdx = idx;
  renderNow();
  if (idx < 0) return;
  const tr = state.tracks[idx];
  addHistory(tr);
  const lead = settings.prefix ? (idx === 0 ? '첫 곡, ' : '다음 곡, ') : '';
  const resumeAt = t - tr.t < 4 ? tr.t : null;
  sayOverMusic(lead + toSpeech(tr.text), resumeAt);
}
setInterval(tick, 250);

// ── 시작 / 잠자기 화면 ─────────────────────────────────────────────────────
function beginSession(fromButton) {
  state.started = true;
  document.body.classList.add('sleeping');
  window.scrollTo(0, 0);
  el.menu.hidden = false;
  el.start.hidden = true;
  el.tap.hidden = false;
  if (!fromButton) {
    setMsg(el.padNote, '아이폰에서는 아래 ‘재생 시작’ 버튼으로 시작해야 목소리가 나와요. 소리가 안 나면 영상을 멈추고 메뉴에서 다시 시작해 주세요.', 'warn');
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
  // 아이폰은 버튼을 누른 그 순간에 한 번 말해야 이후에도 목소리를 낼 수 있다.
  speak('시작할게요');
  holdScreen();
  state.resumeBlocked = false;
  state.player.playVideo();
  beginSession(true);
  setMsg(el.padNote, '');
  setTimeout(() => {
    const st = state.player.getPlayerState();
    // 첫 곡 안내 때문에 잠깐 멈춘 것일 수 있으니, 아직 아무 곡도 시작 안 했을 때만 안내한다.
    if (st !== PLAYING && st !== BUFFERING && !state.busy && state.currentIdx < 0) {
      setMsg(el.padNote, '영상이 시작되지 않으면 위 영상의 ▶를 한 번 눌러 주세요.', 'warn');
    }
  }, 2500);
}

function wakeUi() {
  document.body.classList.remove('sleeping');
  el.menu.hidden = true;
}

el.start.addEventListener('click', startListening);
el.menu.addEventListener('click', wakeUi);

// 잠자기 화면 아무 데나 누르기 → 지금 곡 다시 말하고 저장
el.tap.addEventListener('click', () => {
  const idx = state.currentIdx;
  const tr = state.tracks[idx];
  let text = '아직 첫 곡 전이에요';
  if (tr) {
    const already = isSaved(tr);
    if (!already) saveSong(tr);
    el.pad.classList.remove('flash');
    void el.pad.offsetWidth;
    el.pad.classList.add('flash');
    text = `지금 곡은 ${toSpeech(tr.text)}. ${already ? '이미 저장돼 있어요.' : '저장했어요.'}`;
  }
  // 곡 안내를 말하는 중에 눌렀으면 그 말 뒤에 이어서 말한다 (눈 감고 누른 걸 놓치지 않게).
  if (state.busy) speak(text);
  else sayOverMusic(text);
});

// ── 영상 불러오기 ──────────────────────────────────────────────────────────
async function openVideo(input) {
  const id = extractVideoId(input);
  if (!id) {
    setMsg(el.loadMsg, '유튜브 링크를 알아보지 못했어요. 유튜브 앱에서 공유 → 링크 복사 후 붙여넣어 주세요.', 'error');
    return;
  }
  setMsg(el.loadMsg, '');
  state.videoId = id;
  state.videoTitle = '';
  state.currentIdx = -1;
  state.lastT = 0;
  state.started = false;
  el.start.hidden = false;
  el.tap.hidden = true;
  store.set('last', id);
  wakeUi();

  const cached = store.get(`tracks.${id}`, null);
  setTracks(cached?.tracks || [], cached?.source || '');
  if (cached?.title) state.videoTitle = cached.title;
  renderVideoTitle();

  await ensurePlayer(id);

  if (!cached?.tracks?.length) {
    if (settings.apiKey) await fetchTracklist(id);
    else {
      setMsg(el.tracksMsg, '이 영상의 곡 목록이 아직 없어요. 설명란이나 고정 댓글의 시간표를 붙여넣거나, 설정에서 YouTube API 키를 넣으면 자동으로 찾아요.', 'warn');
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
  try {
    const vr = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${key}`);
    const vj = await vr.json();
    if (!vr.ok) throw new Error(apiError(vj, vr.status));
    const sn = vj.items?.[0]?.snippet;
    if (!sn) throw new Error('영상 정보를 찾지 못했어요. 비공개이거나 삭제된 영상일 수 있어요.');
    state.videoTitle = sn.title || state.videoTitle;
    renderVideoTitle();

    let picked = parseTracklist(sn.description).length >= 3 ? pickTracklist(sn.description) : null;
    if (!picked) {
      const cr = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${id}&maxResults=40&order=relevance&textFormat=plainText&key=${key}`);
      const cj = await cr.json();
      const comments = cr.ok ? (cj.items || []).map((it) => {
        const c = it.snippet.topLevelComment.snippet;
        return { text: c.textOriginal || c.textDisplay || '', isOwner: c.authorChannelId?.value === sn.channelId };
      }) : [];
      picked = pickTracklist(sn.description, comments);
    }
    if (id !== state.videoId) return;
    if (!picked) {
      setMsg(el.tracksMsg, '설명란과 댓글에서 시간표를 찾지 못했어요. 시간표를 직접 붙여넣어 주세요.', 'warn');
      el.tracksEdit.open = true;
      return;
    }
    setTracks(picked.tracks, picked.source);
    saveTracks();
    setMsg(el.tracksMsg, `${picked.source}에서 ${picked.tracks.length}곡을 찾았어요.`, 'ok');
  } catch (err) {
    setMsg(el.tracksMsg, err.message || '곡 목록을 가져오지 못했어요.', 'error');
    el.tracksEdit.open = true;
  }
}

function setTracks(tracks, source) {
  state.tracks = tracks;
  state.source = source;
  state.currentIdx = -1;
  el.tracksInput.value = tracksToText(tracks);
  renderTracks();
  renderNow();
}

function saveTracks() {
  if (!state.videoId) return;
  store.set(`tracks.${state.videoId}`, { tracks: state.tracks, source: state.source, title: state.videoTitle });
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

function saveSong(tr) {
  const saved = store.get('saved', []);
  saved.unshift({ key: songKey(tr), vid: state.videoId, t: tr.t, text: tr.text, from: state.videoTitle, at: Date.now() });
  store.set('saved', saved.slice(0, 500));
  renderSaved();
  renderHistory();
}

function addHistory(tr) {
  const history = store.get('history', []);
  const key = songKey(tr);
  if (history[0]?.key === key) return;
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

function songLinks(item) {
  const wrap = document.createElement('span');
  wrap.className = 'links';
  const search = document.createElement('a');
  search.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(item.text)}`;
  search.target = '_blank';
  search.rel = 'noopener';
  search.textContent = '유튜브에서 찾기';
  const part = document.createElement('a');
  part.href = `https://www.youtube.com/watch?v=${item.vid}&t=${Math.floor(item.t)}s`;
  part.target = '_blank';
  part.rel = 'noopener';
  part.textContent = '그 부분 듣기';
  wrap.append(search, part);
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
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    const on = savedKeys.has(item.key);
    star.setAttribute('aria-pressed', String(on));
    star.setAttribute('aria-label', on ? '저장됨' : '저장하기');
    star.textContent = on ? '★' : '☆';
    star.addEventListener('click', () => {
      const saved = store.get('saved', []);
      if (saved.some((s) => s.key === item.key)) {
        store.set('saved', saved.filter((s) => s.key !== item.key));
      } else {
        saved.unshift({ ...item, at: Date.now() });
        store.set('saved', saved.slice(0, 500));
      }
      renderSaved();
      renderHistory();
    });
    li.append(time, text, star);
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
el.modeRadios.forEach((r) => {
  r.checked = r.value === settings.mode;
  r.addEventListener('change', () => {
    if (!r.checked) return;
    settings.mode = r.value;
    state.resumeBlocked = false;
    saveSettings();
  });
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
  const sample = state.tracks[0]?.text || '아이유 - 밤편지';
  speak(`${settings.prefix ? '다음 곡, ' : ''}${toSpeech(sample)}`);
});
el.apiKey.value = settings.apiKey;
el.apiSave.addEventListener('click', () => {
  settings.apiKey = el.apiKey.value.trim();
  saveSettings();
  setMsg(el.apiMsg, settings.apiKey ? '저장했어요. 이 기기에만 보관돼요.' : 'API 키를 지웠어요.', 'ok');
  if (settings.apiKey && state.videoId && !state.tracks.length) fetchTracklist(state.videoId);
});

// ── 처음 화면 ─────────────────────────────────────────────────────────────
renderSaved();
renderHistory();
renderNow();
const fromQuery = new URLSearchParams(location.search).get('v');
const last = fromQuery || store.get('last', null);
if (last) {
  el.url.value = fromQuery ? fromQuery : `https://youtu.be/${last}`;
  openVideo(last);
}
