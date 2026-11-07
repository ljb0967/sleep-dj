// Typecast(한국 음성 합성 서비스) API와 내 목소리 등록.
// 문서: https://typecast.ai/docs/ko/api-reference/text-to-speech/text-to-speech
const API = 'https://api.typecast.ai';
export const TC_MODEL = 'ssfm-v31';
export const RECOMMEND_QUERY = '차분하고 따뜻한 심야 라디오 DJ, 잠들기 전에 듣기 좋은 낮은 한국어 목소리';
const MIN_SECONDS = 5;
const MAX_SECONDS = 150;

// 내 목소리를 만들 때 읽을 글. 차분하게 읽을수록 그 말투로 복제된다.
export const READING_SCRIPT = `안녕하세요. 오늘 밤도 잠결 DJ와 함께해 주셔서 고맙습니다.
하루가 조용히 저물고, 창밖에는 가로등 불빛만 남았어요.
오늘 하루도 정말 수고 많으셨습니다.
잠이 오지 않는 밤에는 억지로 잠들려고 하지 않아도 괜찮아요.
불을 끄고, 편안하게 누워서, 천천히 숨을 내쉬어 보세요.
이 시간에는 좋아하는 노래 한 곡이면 충분하니까요.
지금부터 신청곡 들려드릴게요. 눈을 감고 함께 들어요.`;

function errorMessage(status, json) {
  const detail = json?.message || json?.detail?.message || (typeof json?.detail === 'string' ? json.detail : '') || '';
  if (status === 401) return 'Typecast API 키가 올바르지 않아요.';
  if (status === 402) return 'Typecast 크레딧이 부족해요. 이번 달 사용량을 확인해 주세요.';
  if (status === 403) return '이 Typecast 플랜에서는 쓸 수 없는 기능이에요. 내 목소리는 유료 API 플랜이 필요해요.';
  if (status === 404) return '목소리를 찾지 못했어요. 설정에서 목소리를 다시 골라 주세요.';
  if (status === 413) return '음성 파일이 너무 커요 (25MB 이하).';
  if (status === 429) return 'Typecast 요청이 너무 많아요. 잠시 뒤에 다시 해 주세요.';
  return `Typecast 오류 ${status}${detail ? `: ${detail}` : ''}`;
}

async function fail(r) {
  let json = null;
  try { json = await r.json(); } catch { /* 본문 없음 */ }
  const err = new Error(errorMessage(r.status, json));
  err.status = r.status;
  return err;
}

/** 문장 → mp3 Blob */
export async function synthesize({ key, voiceId, model, emotion, text }) {
  const body = {
    voice_id: voiceId,
    text,
    model: model || TC_MODEL,
    language: 'kor',
    output: { audio_format: 'mp3', target_lufs: -16 },
  };
  if (emotion) body.prompt = { emotion_type: 'preset', emotion_preset: emotion, emotion_intensity: 0.8 };
  const r = await fetch(`${API}/v1/text-to-speech`, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await fail(r);
  return r.blob();
}

/** 쓸 수 있는 목소리 전체. 내 목소리는 모델과 상관없이 모두 가져온다. */
export async function listVoices(key) {
  const get = async (query) => {
    const r = await fetch(`${API}/v3/voices?${query}`, { headers: { 'X-API-KEY': key } });
    if (!r.ok) throw await fail(r);
    const json = await r.json();
    return Array.isArray(json) ? json : (json.voices || json.items || json.data || []);
  };
  // 내 목소리가 없는 플랜에서 이 요청이 실패해도 성우 목소리는 보여 준다.
  const [custom, original] = await Promise.all([
    get('voice_type=custom').catch(() => []),
    get(`voice_type=original&model=${TC_MODEL}`),
  ]);
  // 플랜에 따라 모델별 목록이 비어 있을 수 있어서, 그때는 모델 조건 없이 다시 본다.
  return [...custom, ...(original.length ? original : await get('voice_type=original'))];
}

/** 심야 라디오에 어울리는 추천 목소리 */
export async function recommendVoices(key) {
  const q = encodeURIComponent(RECOMMEND_QUERY);
  const r = await fetch(`${API}/v1/voices/recommendations?query=${q}&count=10`, { headers: { 'X-API-KEY': key } });
  if (!r.ok) throw await fail(r);
  return r.json();
}

/** 목소리 하나를 재생에 쓸 설정으로 바꾼다. */
export function voiceSettings(voice) {
  const m = voice.models?.find((x) => x.version === TC_MODEL) || voice.models?.[0];
  return {
    typecastVoice: voice.voice_id,
    typecastModel: m?.version || TC_MODEL,
    // 자장가처럼 낮은 톤이 있으면 쓴다. 내 목소리는 normal뿐이라 설정하지 않는다.
    typecastEmotion: m?.emotions?.includes('tonedown') ? 'tonedown' : '',
  };
}

const AGE = { child: '어린이', teenager: '10대', young_adult: '청년', middle_age: '중년', elder: '노년' };
const GENDER = { female: '여성', male: '남성' };

export function voiceLabel(v) {
  const name = v.voice_name?.kor || v.voice_name?.eng || v.voice_id;
  const tags = [GENDER[v.gender], AGE[v.age]].filter(Boolean).join(' ');
  return tags ? `${name} · ${tags}` : name;
}

/** 내 목소리 만들기. 성공하면 만들어진 목소리 정보를 돌려준다. */
export async function createClone({ key, wav, name }) {
  for (const model of [TC_MODEL, 'ssfm-v30']) {
    const form = new FormData();
    form.append('file', wav, 'my-voice.wav');
    form.append('name', name.slice(0, 30));
    form.append('model', model);
    const r = await fetch(`${API}/v1/custom-voices/instant-clone`, {
      method: 'POST',
      headers: { 'X-API-KEY': key },
      body: form,
    });
    if (r.ok) return r.json();
    const err = await fail(r);
    // 계정에 따라 지원 모델이 달라서, 모델이 안 맞으면 이전 모델로 한 번 더 해 본다.
    if (r.status !== 422 || model === 'ssfm-v30') throw err;
  }
  throw new Error('내 목소리를 만들지 못했어요.');
}

/** 16비트 모노 WAV로 포장 */
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * 녹음·음성 메모(m4a 등) → Typecast가 받는 WAV.
 * 150초가 넘으면 앞부분만 쓴다. 5초보다 짧으면 예외.
 */
export async function toCloneWav(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (audio.duration < MIN_SECONDS) throw new Error(`${Math.floor(audio.duration)}초예요. ${MIN_SECONDS}초 이상 녹음해 주세요. 1분쯤이 좋아요.`);
    const length = Math.min(audio.length, Math.floor(MAX_SECONDS * audio.sampleRate));
    const mono = new Float32Array(length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    return { wav: encodeWav(mono, audio.sampleRate), seconds: Math.round(length / audio.sampleRate), trimmed: audio.duration > MAX_SECONDS };
  } finally {
    ctx.close?.();
  }
}

/** 마이크 녹음기. stop()은 녹음 파일 Blob을 돌려준다. 끝나면 마이크를 바로 놓는다. */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start();
  return {
    stop: () => new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' }));
      };
      recorder.stop();
    }),
  };
}
