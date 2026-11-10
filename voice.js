// 목소리: 한 번에 한 마디만 말하는 채널.
// - 기기 음성(speechSynthesis): 무료. 아이폰에서는 영상이 재생된 뒤 소리가 안 나는 경우가 있다.
// - OpenAI / Typecast 음성: 문장을 mp3로 받아 <audio>로 재생한다. 미디어 경로라 아이폰에서 더 확실하다.
//   Typecast는 자연스러운 한국어 목소리와 내 목소리(복제)를 쓸 수 있다.
// 새로 말하면 이전 말은 끊는다. 무엇을 말했고 어떻게 됐는지 진단 기록을 남긴다.
import { synthesize } from './typecast.js?v=20261110b';

export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const OPENAI_VOICES = ['marin', 'cedar', 'nova', 'shimmer', 'sage', 'coral', 'alloy', 'ballad', 'verse', 'ash', 'echo', 'fable', 'onyx'];
const TTS_STYLE = '잠들기 직전의 사람에게 들려주듯, 낮고 차분하고 부드럽게 말하세요. 한국어와 영어 이름을 자연스럽게 읽으세요.';
const CACHE_NAME = 'sdj-tts-v1';

// 미리 만들어 두는 고정 문장들 (OpenAI 음성일 때)
export const PHRASES = {
  start: '시작할게요',
  restart: '다시 시작할게요',
  first: '첫 곡,',
  next: '다음 곡,',
  now: '지금 곡은',
  saved: '저장했어요.',
  already: '이미 저장돼 있어요.',
  saveFailed: '이 기기에 저장하지 못했어요.',
  beforeFirst: '아직 첫 곡 전이에요.',
  stalled: '음악이 멈췄어요. 화면을 한 번 누르면 다시 틀어요.',
  resumed: '다시 틀게요.',
  timer: '취침 타이머로 음악을 멈출게요. 잘 자요.',
};

export function createVoice({ getSettings, getPlayerState }) {
  const synth = window.speechSynthesis || null;
  const audio = new Audio();
  audio.setAttribute('playsinline', '');
  audio.preload = 'auto';

  let active = null;          // 지금 말하는 중인 일 { cancel, done }
  const log = [];             // 진단 기록 (최근 것부터)
  const listeners = new Set();
  const clipUrls = new Map(); // 문장 → blob URL
  let silentUrl = null;

  /** 음성 파일로 말할 수 있으면 그 엔진 이름, 아니면 null(기기 음성) */
  const clipEngine = () => {
    const s = getSettings();
    if (s.engine === 'openai' && s.openaiKey) return 'openai';
    if (s.engine === 'typecast' && s.typecastKey && s.typecastVoice) return 'typecast';
    return null;
  };
  const ENGINE_LABEL = { openai: 'OpenAI', typecast: 'Typecast' };

  // ── 진단 기록 ──
  function note(entry) {
    log.unshift(entry);
    if (log.length > 15) log.length = 15;
    listeners.forEach((fn) => fn());
  }
  function changed() { listeners.forEach((fn) => fn()); }

  // ── 기기 목소리 목록 ──
  function koreanVoices() {
    return (synth?.getVoices?.() || []).filter((v) => /^ko/i.test(v.lang));
  }
  function chosenVoice() {
    const uri = getSettings().voiceURI;
    if (!uri) return null; // 기본: 목소리를 지정하지 않는다 (아이폰에서 지정하면 소리가 안 나는 경우가 있어서)
    return koreanVoices().find((v) => v.voiceURI === uri) || null;
  }

  // ── 소리 잠금 풀기: 반드시 화면을 누른 그 순간에 부른다 ──
  function makeSilentWav() {
    const samples = 800; // 8kHz 0.1초
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function unlock() {
    if (clipEngine() && !active) {
      silentUrl ||= makeSilentWav();
      audio.src = silentUrl;
      audio.play().catch(() => {});
    }
    if (synth) {
      try {
        if (synth.paused) synth.resume();
      } catch { /* 무시 */ }
    }
  }

  // ── 기기 음성 ──
  function speakDevice(text, entry, setCancel) {
    return new Promise((resolve) => {
      if (!synth) { entry.result = '이 브라우저에는 기기 음성이 없음'; resolve(false); return; }
      const s = getSettings();
      let done = false;
      let attempt = 0;
      let startTimer = null;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        clearTimeout(endTimer);
        entry.result = why;
        resolve(ok);
      };
      setCancel(() => { try { synth.cancel(); } catch { /* 무시 */ } finish(false, '끊김(새 말)'); });
      const endTimer = setTimeout(() => { try { synth.cancel(); } catch { /* 무시 */ } finish(false, '시간 초과'); },
        5000 + (text.length * 220) / s.rate);
      const go = () => {
        attempt += 1;
        entry.attempts = attempt;
        // 아이폰에서 앞 문장이 '말하는 중'으로 멈춰 버리면 뒤 문장이 모두 막힌다. 먼저 비운다.
        entry.before = `speaking=${synth.speaking} pending=${synth.pending} paused=${synth.paused}`;
        if (synth.speaking || synth.pending) synth.cancel();
        if (synth.paused) synth.resume();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        const voice = chosenVoice();
        if (voice) u.voice = voice;
        entry.voiceName = voice ? voice.name : '자동';
        u.rate = s.rate;
        u.volume = 1;
        u.onstart = () => { entry.started = true; clearTimeout(startTimer); changed(); };
        u.onend = () => finish(true, '끝까지 말함');
        u.onerror = (e) => finish(false, `오류: ${e.error || '알 수 없음'}`);
        synth.speak(u);
        startTimer = setTimeout(() => {
          if (entry.started || done) return;
          try { synth.cancel(); } catch { /* 무시 */ }
          if (attempt < 2) go();
          else finish(false, '시작 안 됨(막힘)');
        }, 1500);
      };
      go();
    });
  }

  // ── 음성 파일 (OpenAI / Typecast) ──
  async function fetchOpenAI(text, s) {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: s.openaiVoice, input: text, instructions: TTS_STYLE, response_format: 'mp3' }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error?.message || msg; } catch { /* 무시 */ }
      if (r.status === 401) msg = 'OpenAI API 키가 올바르지 않아요.';
      if (r.status === 429) msg = 'OpenAI 사용 한도에 걸렸어요 (요금 한도나 요청 수).';
      throw new Error(msg);
    }
    return r.blob();
  }

  async function fetchTypecast(text, s) {
    const args = { key: s.typecastKey, voiceId: s.typecastVoice, model: s.typecastModel, emotion: s.typecastEmotion, text };
    try {
      return await synthesize(args);
    } catch (err) {
      if (err.status === 429) { // 무료 플랜은 동시 요청이 2개까지라 잠깐 쉬었다 다시 한다
        await new Promise((r) => setTimeout(r, 1500));
        return synthesize(args);
      }
      if (err.status === 422 && args.emotion) return synthesize({ ...args, emotion: '' }); // 이 목소리에 없는 감정
      throw err;
    }
  }

  async function getClip(text) {
    const s = getSettings();
    const engine = clipEngine();
    const voiceKey = engine === 'typecast' ? `typecast|${s.typecastVoice}|${s.typecastEmotion}` : `${OPENAI_TTS_MODEL}|${s.openaiVoice}`;
    const key = `${voiceKey}|${text}`;
    if (clipUrls.has(key)) return clipUrls.get(key);
    const req = new Request(`${location.pathname.replace(/[^/]*$/, '')}__tts/${encodeURIComponent(key)}`);
    let blob = null;
    try {
      const hit = await (await caches.open(CACHE_NAME)).match(req);
      if (hit) blob = await hit.blob();
    } catch { /* Cache API 없음 */ }
    if (!blob) {
      blob = engine === 'typecast' ? await fetchTypecast(text, s) : await fetchOpenAI(text, s);
      try {
        await (await caches.open(CACHE_NAME)).put(req, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } }));
      } catch { /* 저장 못 해도 이번엔 재생 */ }
    }
    const url = URL.createObjectURL(blob);
    clipUrls.set(key, url);
    return url;
  }

  async function speakClips(parts, entry, setCancel) {
    let cancelled = false;
    let stopCurrent = () => {};
    setCancel(() => { cancelled = true; stopCurrent(); });
    for (const part of parts) {
      const url = await getClip(part);
      if (cancelled) { entry.result = '끊김(새 말)'; return false; }
      const ok = await new Promise((resolve) => {
        let settled = false;
        const end = (v, why) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          audio.onended = null;
          audio.onerror = null;
          if (why) entry.result = why;
          resolve(v);
        };
        stopCurrent = () => { audio.pause(); end(false, '끊김(새 말)'); };
        const timer = setTimeout(() => { audio.pause(); end(false, '시간 초과'); }, 30000);
        audio.onended = () => end(true);
        audio.onerror = () => end(false, '재생 오류');
        audio.src = url;
        audio.defaultPlaybackRate = getSettings().rate;
        audio.playbackRate = getSettings().rate;
        audio.play()
          .then(() => { entry.started = true; changed(); })
          .catch((e) => end(false, `재생 거부: ${e.name}`));
      });
      if (!ok) return false;
    }
    entry.result = '끝까지 말함';
    return true;
  }

  /**
   * parts: ['다음 곡,', '아이유, 밤편지'] 처럼 나눈 문장. 기기 음성은 이어 붙여 한 번에 말한다.
   * 돌려주는 Promise는 말이 끝나거나(true) 실패·끊김(false)일 때 풀린다.
   */
  function say(parts) {
    parts = parts.filter(Boolean);
    if (active) active.cancel();
    let cancelFn = () => {};
    const engine = clipEngine();
    const entry = {
      at: new Date(),
      engine: ENGINE_LABEL[engine] || '기기',
      text: parts.join(' '),
      started: false,
      result: '말하는 중',
      player: getPlayerState(),
    };
    note(entry);
    const job = { cancel: () => cancelFn() };
    job.done = (async () => {
      let ok = false;
      try {
        ok = engine
          ? await speakClips(parts, entry, (fn) => { cancelFn = fn; })
          : await speakDevice(parts.join(' '), entry, (fn) => { cancelFn = fn; });
      } catch (err) {
        // 음성 파일을 못 만들면 이번 한 번은 기기 음성으로라도 말한다.
        entry.result = `${ENGINE_LABEL[engine]} 실패: ${err.message} → 기기 음성으로`;
        entry.engine = '기기(대신)';
        changed();
        try { ok = await speakDevice(parts.join(' '), entry, (fn) => { cancelFn = fn; }); } catch { ok = false; }
      } finally {
        if (active === job) active = null;
        changed();
      }
      return ok;
    })();
    active = job;
    return job.done;
  }

  /** 지금 하는 말(그리고 그 사이 끼어든 말)이 모두 끝날 때까지 기다린다. */
  async function idle() {
    while (active) await active.done;
  }

  /** 곡 이름들과 고정 문장을 미리 만들어 둔다 (음성 파일로 말할 때만). */
  async function prepare(texts, onProgress) {
    if (!clipEngine()) return { done: 0, total: 0, failed: 0 };
    const list = [...new Set([...Object.values(PHRASES), ...texts])];
    const queue = [...list];
    const stat = { done: 0, total: list.length, failed: 0, error: '' };
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try { await getClip(t); } catch (e) { stat.failed += 1; stat.error = e.message; }
        stat.done += 1;
        onProgress?.({ ...stat });
      }
    };
    await Promise.all([worker(), worker()]); // Typecast 무료 플랜 동시 요청 한도가 2개
    return stat;
  }

  function diagnostics() {
    const s = getSettings();
    const ua = navigator.userAgent.match(/(iPhone OS [\d_]+|Android [\d.]+|Windows NT [\d.]+|Mac OS X [\d_]+)/)?.[0] || navigator.userAgent.slice(0, 60);
    const lines = [
      `기기: ${ua}${navigator.standalone ? ' (홈 화면 앱)' : ''}`,
      `목소리 엔진: ${{ openai: `OpenAI (${OPENAI_TTS_MODEL}, ${s.openaiVoice})`, typecast: `Typecast (${s.typecastVoice}, ${s.typecastModel}, ${s.typecastEmotion || '감정 없음'})` }[clipEngine()] || '기기 음성'}${s.engine !== 'device' && !clipEngine() ? ' — 키나 목소리가 없어 기기 음성 사용' : ''}`,
      `기기 한국어 목소리: ${koreanVoices().length}개, 선택: ${chosenVoice()?.name || '자동'}`,
      synth ? `기기 음성 상태: speaking=${synth.speaking} pending=${synth.pending} paused=${synth.paused}` : '기기 음성: 없음',
      `안내 방식: ${s.mode === 'pause' ? '멈추고 말하기' : '음악 위에 말하기'}, 빠르기 ${s.rate}`,
      '— 최근 기록 (위가 최신) —',
      ...log.map((e) => {
        const t = e.at.toTimeString().slice(0, 8);
        return `${t} [${e.engine}] "${e.text}" → ${e.result}${e.started ? '' : ' (소리 시작 신호 없음)'}${e.attempts > 1 ? `, ${e.attempts}번 시도` : ''}${e.before ? `, 직전 ${e.before}` : ''}, 영상 ${e.player}`;
      }),
    ];
    return lines.join('\n');
  }

  return {
    say, idle, unlock, prepare, diagnostics, koreanVoices,
    get speaking() { return !!active; },
    onChange(fn) { listeners.add(fn); },
  };
}
