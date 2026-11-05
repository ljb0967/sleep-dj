// 모음 영상의 시간표(곡 목록)를 읽고, 음성으로 읽기 좋게 다듬는 순수 함수들.
// DOM이나 네트워크에 의존하지 않으므로 node로도 바로 시험할 수 있다.

// 시간표 한 개: 1:02:33, 04:13, 4:13 … 앞뒤로 숫자나 ':'가 붙어 있으면 시간표가 아니다.
const TS_SRC = '(^|[^\\d:])((?:(\\d{1,2}):)?(\\d{1,2}):(\\d{2}))(?![\\d:])';
const TS_ONE = new RegExp(TS_SRC);
const TS_ALL = new RegExp(TS_SRC, 'g');

// 줄 앞뒤에 붙는 장식 문자들 (글머리표, 화살표, 음표, 이모지 등)
const EDGE = "\\s\\-–—:|·•,~>*_=+\\u2022\\u25A0-\\u25FF\\u266A-\\u266F\\u2661\\u2665\\u2764\\u2605\\u2606\\u2192\\u2190\\p{Extended_Pictographic}\\uFE0F";
const EDGE_HEAD = new RegExp(`^[${EDGE}.]+`, 'u');
const EDGE_TAIL = new RegExp(`[${EDGE}]+$`, 'u');
// 곡 번호: "1." "01)" "#1" "No.1" "Track 1" "01"(0으로 시작하는 두 자리)
const NUMBERING = /^(?:(?:#|no\.?\s?|track\s?)\d{1,3}|\d{1,3}[.)]|0\d)(?=\s|$)\s*/i;
// 곡이 아니라 공지로 보이는 줄 ("10:00 이후 광고 없음", "30:00부터 2부")
const NOTICE = /^(?:이후|부터|까지|에서|~)|광고\s*(?:없|있|제거|포함|나옴|나와)/;
// 시간표를 빼고 남은 빈 괄호
const EMPTY_BRACKETS = /[\[(【「<{]\s*[\])】」>}]/g;

/** 시간표 앞뒤 텍스트에서 곡 이름만 남긴다. */
export function cleanTitle(s) {
  let x = String(s).replace(EMPTY_BRACKETS, ' ').replace(/\s+/g, ' ').trim();
  x = x.replace(EDGE_HEAD, '');
  x = x.replace(NUMBERING, '');
  x = x.replace(EDGE_HEAD, '').replace(EDGE_TAIL, '');
  return x.replace(/\s+/g, ' ').trim();
}

function isBlankAround(part) {
  // 시간표 앞쪽(또는 뒤쪽)에 번호·장식·괄호만 있으면 '비어 있다'고 본다.
  return cleanTitle(part.replace(/[\[\](){}【】「」<>]/g, ' ')) === '';
}

/**
 * 시간표 텍스트 → [{ t: 초, text: '아이유 - 밤편지' }] (시간순, 같은 시각은 하나만)
 * 문장 중간에 시각이 나오는 줄("※ 10:00 이후 광고 없음")은 곡으로 치지 않는다.
 */
export function parseTracklist(text) {
  if (!text) return [];
  const found = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[​‎‏]/g, '').trim();
    const m = TS_ONE.exec(line);
    if (!m) continue;
    const hasHour = m[3] !== undefined;
    const h = hasHour ? Number(m[3]) : 0;
    const mi = Number(m[4]);
    const s = Number(m[5]);
    if (s >= 60 || (hasHour && mi >= 60)) continue;

    const start = m.index + m[1].length;
    const before = line.slice(0, start);
    const after = line.slice(start + m[2].length);
    if (!isBlankAround(before) && !isBlankAround(after.replace(TS_ALL, '$1'))) continue;

    // "00:00 - 03:45 곡" 처럼 끝 시각이 함께 적힌 경우도 있으니 나머지 시간표도 지운다.
    const name = cleanTitle((before + ' ' + after).replace(TS_ALL, '$1'));
    if (!name || NOTICE.test(name)) continue;
    found.push({ t: h * 3600 + mi * 60 + s, text: name });
  }
  found.sort((a, b) => a.t - b.t);
  const out = [];
  for (const e of found) {
    if (!out.length || out[out.length - 1].t !== e.t) out.push(e);
  }
  return out;
}

/**
 * 설명란과 댓글 중에서 곡 목록으로 보이는 것을 고른다.
 * comments: [{ text, isOwner }] — 영상 주인이 쓴 댓글(보통 고정 댓글)을 먼저 본다.
 */
export function pickTracklist(description, comments = []) {
  const fromDesc = parseTracklist(description);
  if (fromDesc.length >= 3) return { tracks: fromDesc, source: '설명란' };
  let best = null;
  for (const c of comments) {
    const tracks = parseTracklist(c.text);
    if (tracks.length < 3) continue;
    const score = tracks.length + (c.isOwner ? 10000 : 0);
    if (!best || score > best.score) {
      best = { tracks, score, source: c.isOwner ? '작성자 댓글' : '댓글' };
    }
  }
  if (best) return { tracks: best.tracks, source: best.source };
  if (fromDesc.length >= 2) return { tracks: fromDesc, source: '설명란' };
  return null;
}

const NOISE = '(?:official|m\\/?v|lyrics?|audio|visuali[sz]er|가사|뮤직\\s?비디오|공식|eng\\s?sub|4k|hd)';
const NOISE_BRACKETS = new RegExp(`[(\\[【][^()\\[\\]【】]*${NOISE}[^()\\[\\]【】]*[)\\]】]`, 'gi');

/** 화면용 곡 이름 → 소리 내어 읽기 좋은 문장 ("아이유 - 밤편지 (feat. X)" → "아이유, 밤편지 피처링 X") */
export function toSpeech(text) {
  let x = ` ${text} `;
  x = x.replace(/\p{Extended_Pictographic}|️/gu, ' ');
  x = x.replace(NOISE_BRACKETS, ' ');
  x = x.replace(/(^|[\s(\[])(?:feat|ft)\.?\s/gi, '$1피처링 ');
  x = x.replace(/[♪♬♩♫♡♥★☆※#*_~<>\[\]【】「」『』〈〉《》()■-◿]/g, ' ');
  x = x.replace(/\s+[-–—|/:]\s+/g, ', ');
  x = x.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
  x = x.replace(/^[,\s]+|[,\s]+$/g, '');
  return x;
}

/** 공유 문구나 링크에서 유튜브 영상 ID(11자)를 꺼낸다. */
export function extractVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const found = s.match(/(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/\S*/i);
  if (!found) return null;
  let url;
  try {
    url = new URL(/^https?:/i.test(found[0]) ? found[0] : `https://${found[0]}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(?:www|m|music)\./, '');
  const ok = (id) => (id && /^[\w-]{11}$/.test(id) ? id : null);
  if (host === 'youtu.be') return ok(url.pathname.slice(1, 12));
  const v = ok(url.searchParams.get('v'));
  if (v) return v;
  const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

/** t초에 재생 중인 곡의 번호. 첫 곡 전이면 -1. */
export function indexAt(tracks, t) {
  let idx = -1;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].t <= t + 0.05) idx = i;
    else break;
  }
  return idx;
}

/** 초 → "4:13" 또는 "1:02:33" */
export function formatTime(sec) {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 곡 목록 → 편집용 텍스트 */
export function tracksToText(tracks) {
  return tracks.map((tr) => `${formatTime(tr.t)} ${tr.text}`).join('\n');
}
