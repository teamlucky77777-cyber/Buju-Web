// ====================================================
// Buju Market — 통합 서버 (ALL-IN-ONE)
//   [웹앱]   부주 리포트 폼 → Discord 웹훅 발송
//   [카톡]   본주 카톡 조회 스킬 (POST /kakao)
//   [봇]     Discord 리포트 메시지 파싱 → Supabase 저장
// 한 Node 프로세스에서 Express(웹앱+카톡) + discord.js 봇을 함께 실행.
// Render 무료 서비스 1개로 돌리기 위함.
// ====================================================

const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 루트 = 부주 리포트 폼
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 헬스체크 (UptimeRobot 핑 / 깨우기용)
app.get('/health', (req, res) => res.send('OK'));


// ████████████████████████████████████████████████████
// [웹앱] 부주 리포트 폼 → Discord 웹훅
// ████████████████████████████████████████████████████

// ---------- 숫자 포맷 ----------
function fmtAdena(n) {
  if (n == null || n === '') return '0';
  const num = Math.round(Number(n));
  return String(Math.abs(num)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtAdenaSigned(n) {
  const num = Number(n);
  if (num < 0) return '-' + fmtAdena(-num);
  return fmtAdena(num);
}

function fmtExp(n) {
  if (n == null || n === '') return '0.00';
  // 반올림 없이 소수점 2자리로 잘라냄 (예: 23.2345 → 23.23)
  const truncated = Math.floor(Number(n) * 100) / 100;
  return truncated.toFixed(2);
}

function fmtExpSigned(n) {
  const num = Number(n);
  // 반올림 없이 잘라냄
  const truncated = num >= 0
    ? Math.floor(num * 100) / 100
    : -Math.floor(-num * 100) / 100;
  return (num >= 0 ? '+' : '') + truncated.toFixed(2);
}

// ---------- 시간/평균 계산 (쉬는시간 제외) + ANSI 색상 ----------
// ANSI 색상 (Discord ansi 코드블록용)
const C = {
  reset:  '\u001b[0m',
  green:  '\u001b[1;32m', // 체크인
  cyan:   '\u001b[1;36m', // 1시간
  yellow: '\u001b[1;33m', // 체크아웃
};

// "HH:MM" → 자정부터 분 단위
function parseTimeToMin(t) {
  if (!t) return null;
  const m = String(t).trim().match(/(\d{1,2})[:.\s](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function overlapMin(s, e, bs, be) {
  return Math.max(0, Math.min(e, be) - Math.max(s, bs));
}

// 쉬는시간(주간 15:00~16:00, 야간 05:00~06:00) 제외한 유효 플레이 시간(시간 단위)
function effectiveHours(playStart, playEnd) {
  const S = parseTimeToMin(playStart);
  const Eraw = parseTimeToMin(playEnd);
  if (S == null || Eraw == null) return null;
  let span = Eraw - S;
  if (span <= 0) span += 1440; // 자정 넘김
  const start = S, end = S + span;
  const breaks = [[900, 960], [300, 360]]; // 15-16시, 05-06시
  let breakMin = 0;
  for (const [bs, be] of breaks) {
    breakMin += overlapMin(start, end, bs, be);               // 당일
    breakMin += overlapMin(start, end, bs + 1440, be + 1440); // 다음날
  }
  const effMin = span - breakMin;
  return effMin > 0 ? effMin / 60 : null;
}

// ---------- 양식 빌더 ----------
function buildCheckin(f) {
  return `${C.green}CHECK IN REPORT${C.reset}
────────────────────────────
PC              : ${f.pc}
CLIENT No.      : ${f.clientNoLabel}
CLIENT NICKNAME : ${f.nickname}
PLAY TIME       : ${f.playStart} ~ ${f.playEnd} (korea time)
MAP             : ${f.map}
LV              : ${f.lv}
EXP             : ${fmtExp(f.exp)}%
ADENA           : ${fmtAdena(f.adena)}
RED POTION      : ${f.potion || 0}
NOTE            : ${f.note || '-'}
SCREENSHOT      : ${f.hasScreenshot ? 'O' : 'X'}`;
}

function buildHourly(f) {
  const levelDiff = (Number(f.lv) - Number(f.prevLv)) || 0;
  const expGained = (levelDiff * 100 + Number(f.exp) - Number(f.prevExp));
  const adenaGained = Number(f.adena) - Number(f.prevAdena);

  return `${C.cyan}SESSION REPORT · Every 1 hour${C.reset}
────────────────────────────
PC              : ${f.pc}
CLIENT No.      : ${f.clientNoLabel}
CLIENT NICKNAME : ${f.nickname}
MAP             : ${f.map}
LV              : ${f.lv}
EXP             : ${fmtExp(f.prevExp)}% → ${fmtExp(f.exp)}%
EXP GAINED      : ${fmtExpSigned(expGained)}%
ADENA           : ${fmtAdena(f.prevAdena)} → ${fmtAdena(f.adena)}
ADENA GAINED    : ${adenaGained >= 0 ? '+' : ''}${fmtAdenaSigned(adenaGained)}
RED POTION USE  : ${f.potion || 0}
DROP            : ${f.drop || 0}
DEAD            : ${f.dead || 0}
NOTE            : ${f.note || '-'}
SCREENSHOT      : ${f.hasScreenshot ? '1' : '0'}
PLAY TIME       : ${f.playStart} ~ ${f.playEnd} (korean time)`;
}

function buildCheckout(f) {
  const levelDiff = (Number(f.lv) - Number(f.prevLv)) || 0;
  const expGained = (levelDiff * 100 + Number(f.exp) - Number(f.prevExp));
  const adenaGained = Number(f.adena) - Number(f.prevAdena);
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const effHrs = effectiveHours(f.playStart, f.playEnd);
  const expPerHr = effHrs ? expGained / effHrs : null;
  const adenaPerHr = effHrs ? adenaGained / effHrs : null;
  const expPerHrStr = expPerHr != null ? fmtExpSigned(expPerHr) + '%' : '-';
  const adenaPerHrStr = adenaPerHr != null ? (adenaPerHr >= 0 ? '+' : '') + fmtAdenaSigned(adenaPerHr) : '-';

  return `${C.yellow}CHECK OUT REPORT · Shift End${C.reset}
────────────────────────────
PC              : ${f.pc}
CLIENT No.      : ${f.clientNoLabel}
CLIENT NICKNAME : ${f.nickname}
DATE            : ${today}
PLAY TIME       : ${f.playStart} ~ ${f.playEnd} (korea time)
MAP             : ${f.map}
LV              : ${f.lv}
EXP             : ${fmtExp(f.prevExp)}% → ${fmtExp(f.exp)}%
EXP GAINED      : ${fmtExpSigned(expGained)}%
EXP / HOUR      : ${expPerHrStr}
ADENA           : ${fmtAdena(f.prevAdena)} → ${fmtAdena(f.adena)}
ADENA GAINED    : ${adenaGained >= 0 ? '+' : ''}${fmtAdenaSigned(adenaGained)}
ADENA / HOUR    : ${adenaPerHrStr}
POTION USED     : ${f.potionTotal || 0}
TOTAL DEAD      : ${f.totalDead || 0}
NOTE            : ${f.note || '-'}
SCREENSHOT      : ${f.hasScreenshot ? 'Attached' : 'None'}`;
}

// ---------- 클라이언트 번호 → 표시 이름 ----------
async function resolveClientByNumber(num) {
  if (!num) return null;
  const { data } = await supabase
    .from('clients')
    .select('number, display_name, keywords')
    .eq('number', Number(num))
    .maybeSingle();
  return data;
}

// ---------- 라우트 ----------
app.get('/api/clients', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('number, display_name')
    .order('number');
  if (error) {
    console.error('[/api/clients] Supabase error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// 관리용 — 전체 필드 (keywords 포함)
app.get('/api/clients/admin', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('number, display_name, keywords')
    .order('number');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// 클라이언트 추가
app.post('/api/clients', async (req, res) => {
  try {
    const { number, display_name, keywords } = req.body;
    if (!number || !display_name) {
      return res.status(400).json({ error: 'number와 display_name는 필수' });
    }
    const { data, error } = await supabase
      .from('clients')
      .insert([{ 
        number: Number(number), 
        display_name: String(display_name).trim(),
        keywords: keywords ? String(keywords).trim() : String(display_name).trim()
      }])
      .select()
      .single();
    if (error) {
      // unique constraint violation
      if (error.code === '23505') {
        return res.status(409).json({ error: `PC ${number}번은 이미 사용 중입니다` });
      }
      throw error;
    }
    res.json(data);
  } catch (err) {
    console.error('[POST /api/clients] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 클라이언트 수정
app.patch('/api/clients/:number', async (req, res) => {
  try {
    const { display_name, keywords } = req.body;
    const updates = {};
    if (display_name !== undefined) updates.display_name = String(display_name).trim();
    if (keywords !== undefined) updates.keywords = String(keywords).trim();
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '수정할 내용이 없습니다' });
    }
    
    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('number', Number(req.params.number))
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[PATCH /api/clients] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 클라이언트 삭제
app.delete('/api/clients/:number', async (req, res) => {
  try {
    const { error } = await supabase
      .from('clients')
      .delete()
      .eq('number', Number(req.params.number));
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/clients] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 특정 캐릭터(이름)의 가장 최근 로그 — 레거시 (이름 기준)
app.get('/api/last-session/:client', async (req, res) => {
  const { data, error } = await supabase
    .from('session_logs')
    .select('*')
    .eq('client_name', req.params.client)
    .neq('report_type', 'CHECKOUT')
    .order('logged_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data?.[0] || null);
});

// 번호 기반 직전 세션 조회 — 새 폼이 이걸 씀
// ?type=CHECKIN 쿼리 파라미터로 특정 리포트 타입만 조회 가능 (체크아웃용)
app.get('/api/last-session-by-no/:num', async (req, res) => {
  try {
    const client = await resolveClientByNumber(req.params.num);
    if (!client) {
      return res.json({ clientName: null, session: null, error: '미등록 번호' });
    }

    let query = supabase
      .from('session_logs')
      .select('*')
      .eq('client_name', client.display_name);
    
    // type=CHECKIN 등으로 특정 타입 강제, 없으면 CHECKOUT 제외 (기존 동작)
    if (req.query.type) {
      query = query.eq('report_type', req.query.type);
    } else {
      query = query.neq('report_type', 'CHECKOUT');
    }
    
    const { data, error } = await query
      .order('logged_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    res.json({ clientName: client.display_name, session: data?.[0] || null });
  } catch (err) {
    console.error('[/api/last-session-by-no] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 리포트 제출 → Discord 웹훅으로 발송
app.post('/api/report', upload.single('screenshot'), async (req, res) => {
  try {
    const { type } = req.body;
    const fields = JSON.parse(req.body.fields);
    fields.hasScreenshot = !!req.file;

    // clientNo → 캐릭터 이름 조회
    if (fields.clientNo) {
      const client = await resolveClientByNumber(fields.clientNo);
      if (!client) {
        return res.status(400).json({ error: `번호 ${fields.clientNo}에 등록된 캐릭터가 없습니다. Supabase clients 테이블 확인 필요.` });
      }
      fields.nickname = client.display_name;
      // CLIENT No. 필드는 "1 마석도님" 형식으로 (첫 키워드를 보조 이름으로)
      const firstKw = (client.keywords || '').split(',')[0]?.trim();
      fields.clientNoLabel = firstKw && firstKw !== String(client.number)
        ? `${client.number} ${firstKw}`
        : String(client.number);
    } else {
      return res.status(400).json({ error: '캐릭터를 선택해주세요.' });
    }

    let text;
    if (type === 'checkin') text = buildCheckin(fields);
    else if (type === 'hourly') text = buildHourly(fields);
    else if (type === 'checkout') text = buildCheckout(fields);
    else return res.status(400).json({ error: '알 수 없는 리포트 타입' });

    // Discord 웹훅으로 POST
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return res.status(500).json({ error: 'DISCORD_WEBHOOK_URL 미설정' });

    // 포럼 채널 처리: thread_id 있으면 기존 스레드에, 없으면 새 스레드 생성
    let webhookEndpoint = webhookUrl;
    const payloadObj = { content: '```ansi\n' + text + '\n```' };

    if (fields.threadId) {
      // 기존 스레드에 메시지 추가
      const separator = webhookUrl.includes('?') ? '&' : '?';
      webhookEndpoint = `${webhookUrl}${separator}thread_id=${encodeURIComponent(fields.threadId)}`;
    } else {
      // thread_id 없으면 thread_name으로 새 스레드 (포럼 채널 fallback)
      const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const dateStr = nowKst.toISOString().slice(5, 16).replace('T', ' ');
      const typeLabel = type === 'checkin' ? '체크인' : type === 'hourly' ? '1시간' : '체크아웃';
      payloadObj.thread_name = `[${typeLabel}] PC${fields.pc} ${fields.nickname} ${dateStr}`.slice(0, 100);
    }

    const form = new FormData();
    form.append('payload_json', JSON.stringify(payloadObj));
    if (req.file) {
      const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
      form.append('files[0]', blob, req.file.originalname || 'screenshot.png');
    }

    const r = await fetch(webhookEndpoint, { method: 'POST', body: form });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Discord 웹훅 실패: ${r.status} ${errText}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Report Error]', err);
    res.status(500).json({ error: err.message });
  }
});


// ████████████████████████████████████████████████████
// [카톡] 본주 카톡 조회 스킬 (POST /kakao)
// ████████████████████████████████████████████████████

function formatNumber(n) {
  if (n == null) return '-';
  return Math.round(n).toLocaleString('ko-KR');
}

function formatDate(dateStr) {
  const d = new Date(new Date(dateStr).getTime() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

function formatTime(dateStr) {
  const d = new Date(new Date(dateStr).getTime() + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

// "21.00" 또는 "21:00" → [시, 분]
function parseHM(t) {
  const parts = String(t).split(/[.:]/);
  return [parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0];
}

// 점(.)을 콜론(:)으로 (21.00 → 21:00)
function colon(t) {
  return t ? String(t).replace('.', ':') : t;
}

// 시간 범위가 운영시간 윈도우 안에 완전히 포함되는지 (자정 가로지름 처리)
function windowContains(startStr, endStr, targetStartStr, targetEndStr) {
  if (!startStr || !endStr) return false;
  const [sh, sm] = parseHM(startStr);
  const [eh, em] = parseHM(endStr);
  const [tsh, tsm] = parseHM(targetStartStr);
  const [teh, tem] = parseHM(targetEndStr);

  const sMin = sh * 60 + sm;
  let eMin = eh * 60 + em;
  if (eMin <= sMin) eMin += 24 * 60; // 운영시간이 자정 가로지름

  let tsMin = tsh * 60 + tsm;
  let teMin = teh * 60 + tem;
  // target도 윈도우 시작점 이후가 되도록 정규화
  if (tsMin < sMin) {
    tsMin += 24 * 60;
    teMin += 24 * 60;
  }

  return tsMin >= sMin && teMin <= eMin;
}

// 휴식시간 정보 (운영시간 윈도우에 휴식 시간대가 포함되는지로 판단)
function getBreakInfo(playStart, playEnd, clientName) {
  if (!playStart || !playEnd) {
    console.warn(`[휴식시간 미인식] ${clientName}: play_time 정보 부족 (start=${playStart}, end=${playEnd})`);
    return { line: '', hours: 0 };
  }
  // 운영시간 안에 15:00~16:00 포함 → 주간 휴식
  if (windowContains(playStart, playEnd, '15:00', '16:00')) {
    return { line: '쉬는시간 : 15:00 ~ 16:00', hours: 1 };
  }
  // 운영시간 안에 05:00~06:00 포함 → 야간 휴식
  if (windowContains(playStart, playEnd, '05:00', '06:00')) {
    return { line: '쉬는시간 : 05:00 ~ 06:00', hours: 1 };
  }
  console.warn(`[휴식시간 미인식] ${clientName}: 운영시간 ${playStart}~${playEnd}에 휴식 시간대 없음`);
  return { line: '', hours: 0 };
}

// 휴식 종료 시각 (24시간제, KST)
function getBreakEndHour(playStart, playEnd) {
  if (!playStart || !playEnd) return null;
  if (windowContains(playStart, playEnd, '15:00', '16:00')) return 16;
  if (windowContains(playStart, playEnd, '05:00', '06:00')) return 6;
  return null;
}

// 운영시간 시작 시각(UTC) 계산
function getWindowStart(playTimeStart, latestLogStr) {
  const [h, m] = parseHM(playTimeStart);
  const latestKST = new Date(new Date(latestLogStr).getTime() + 9 * 60 * 60 * 1000);
  let candKST = new Date(Date.UTC(
    latestKST.getUTCFullYear(),
    latestKST.getUTCMonth(),
    latestKST.getUTCDate(),
    h, m, 0, 0
  ));
  if (candKST.getTime() > latestKST.getTime()) {
    candKST = new Date(candKST.getTime() - 24 * 60 * 60 * 1000);
  }
  return new Date(candKST.getTime() - 9 * 60 * 60 * 1000);
}

// 운영시간 길이(ms). 자정 넘어가면 +24h, end 없으면 24시간.
function windowDurationMs(startStr, endStr) {
  if (!endStr) return 24 * 60 * 60 * 1000;
  const [sh, sm] = parseHM(startStr);
  const [eh, em] = parseHM(endStr);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins * 60 * 1000;
}

// 실제 체크인 시각을 보고 표준 시프트 추정 (시나리오 C 보정용)
function suggestShift(actualHour) {
  const dist = (a, b) => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));
  if (dist(actualHour, 9)  <= 1) return { start: '09:00', end: '21:00' };
  if (dist(actualHour, 21) <= 1) return { start: '21:00', end: '09:00' };
  return null;
}

// CHECK IN과 CHECK OUT의 play_time 비교 → 신뢰할 만한 쪽 선택
// 둘 다 일치하지만 실제 체크인 시각과 동떨어진 경우(시나리오 C)도 처리
function pickPlayTime(ci, co, clientName) {
  const ciS = ci?.play_time_start, ciE = ci?.play_time_end;
  const coS = co?.play_time_start, coE = co?.play_time_end;
  if (!ciS && !coS) return [null, null];
  if (!ciS) return [coS, coE];
  if (!coS) return [ciS, ciE];

  const actualHour = (new Date(ci.logged_at).getUTCHours() + 9) % 24;
  const dist = (a, b) => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));

  // CI/CO 일치 — 둘 다 오타일 수도 있으니 실제 시각과 비교
  if (ciS === coS && ciE === coE) {
    const ciHour = parseInt(String(ciS).split(/[:.]/)[0], 10);
    const diff = dist(actualHour, ciHour);
    if (diff > 2) {
      const suggested = suggestShift(actualHour);
      if (suggested) {
        console.warn(
          `[운영시간 둘 다 오타 의심] ${clientName}: 텍스트=${ciS}~${ciE}, 실제체크인=${actualHour}시 → ${suggested.start}~${suggested.end} 추정`
        );
        return [suggested.start, suggested.end];
      }
      console.warn(
        `[운영시간 의심] ${clientName}: 둘 다 ${ciS}~${ciE} 일치하지만 실제 체크인=${actualHour}시. 추정 불가, 그대로 사용.`
      );
    }
    return [ciS, ciE];
  }

  // CI/CO 불일치 — 실제 체크인 시각에 더 가까운 쪽
  const ciHour = parseInt(String(ciS).split(/[:.]/)[0], 10);
  const coHour = parseInt(String(coS).split(/[:.]/)[0], 10);
  const ciDiff = dist(actualHour, ciHour);
  const coDiff = dist(actualHour, coHour);

  console.warn(
    `[운영시간 불일치] ${clientName}: CHECK IN ${ciS}~${ciE} / CHECK OUT ${coS}~${coE} / 실제체크인=${actualHour}시 → ${ciDiff <= coDiff ? 'CHECK IN' : 'CHECK OUT'} 채택`
  );
  return ciDiff <= coDiff ? [ciS, ciE] : [coS, coE];
}

function makeTextResponse(text) {
  return {
    version: '2.0',
    template: { outputs: [{ simpleText: { text } }] },
  };
}

function makeImageTextResponse(imageUrl, altText, text) {
  return {
    version: '2.0',
    template: {
      outputs: [
        { simpleImage: { imageUrl, altText } },
        { simpleText: { text } },
      ],
    },
  };
}

// 닉네임 → display_name 해석
function resolveClient(allClients, nicknameQuery) {
  if (!allClients || !nicknameQuery) return null;
  const q = nicknameQuery.toLowerCase();
  for (const c of allClients) {
    const keywords = (c.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.some(k => q.includes(k)) || keywords.some(k => k.includes(q))) {
      return c.display_name;
    }
  }
  return null;
}

// ---------- 카톡 스킬 라우트 ----------
app.post('/kakao', async (req, res) => {
  const utterance = req.body?.userRequest?.utterance?.trim();

  if (!utterance) {
    return res.json(makeTextResponse(
      '캐릭터 닉네임을 입력해주세요.\n예) 지옥도깨비'
    ));
  }

  // 클라이언트 매칭
  const { data: allClients } = await supabase.from('clients').select('*');
  const clientDisplayName = resolveClient(allClients, utterance) || utterance;

  try {
    return await handleCurrentSession(res, clientDisplayName);
  } catch (err) {
    console.error('[Handler Error]', err);
    return res.json(makeTextResponse(`처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.`));
  }
});

// 현재 세션 / 마지막 체크아웃 분기
async function handleCurrentSession(res, clientDisplayName) {
  const { data: lastAnyArr } = await supabase
    .from('session_logs')
    .select('*')
    .eq('client_name', clientDisplayName)
    .order('logged_at', { ascending: false })
    .limit(1);
  const lastAny = lastAnyArr?.[0];

  if (!lastAny) {
    return res.json(makeTextResponse(
      `"${clientDisplayName}" 님의 세션 기록이 없습니다.\n아직 체크인이 되지 않았을 수 있습니다.`
    ));
  }

  if (lastAny.report_type === 'CHECKOUT') {
    return await renderCheckoutSummary(res, clientDisplayName, lastAny);
  }
  return await renderActiveSession(res, clientDisplayName, lastAny);
}

// 체크아웃 요약 (운영 종료 상태)
async function renderCheckoutSummary(res, clientDisplayName, checkoutLog) {
  const { data: priorCheckins } = await supabase
    .from('session_logs')
    .select('*')
    .eq('client_name', clientDisplayName)
    .eq('report_type', 'CHECKIN')
    .lt('logged_at', checkoutLog.logged_at)
    .order('logged_at', { ascending: false });

  if (!priorCheckins || priorCheckins.length === 0) {
    return res.json(makeTextResponse(
      `"${clientDisplayName}" 님은 체크아웃 상태이고, 이전 세션 기록이 없습니다.`
    ));
  }

  // 윈도우 안 가장 빠른 체크인 (교대 체크인 다 포함해서 첫 체크인)
  let sessionCheckin = priorCheckins[0];
  if (sessionCheckin.play_time_start) {
    const winStart = getWindowStart(sessionCheckin.play_time_start, checkoutLog.logged_at);
    const inWindow = priorCheckins.filter(c => new Date(c.logged_at) >= winStart);
    if (inWindow.length > 0) sessionCheckin = inWindow[inWindow.length - 1];
  }

  const [playStart, playEnd] = pickPlayTime(sessionCheckin, checkoutLog, clientDisplayName);
  const breakInfo = getBreakInfo(playStart, playEnd, clientDisplayName);

  // 시작값/종료값
  const startExp   = sessionCheckin.exp_after;
  const endExp     = checkoutLog.exp_after;
  const startAdena = sessionCheckin.adena_after;
  const endAdena   = checkoutLog.adena_after;
  const startLevel = sessionCheckin.level;
  const endLevel   = checkoutLog.level;

  // 사냥시간 = 운영시간 - 휴식시간
  const hours = (playStart && playEnd)
    ? Math.max(0, Math.round(windowDurationMs(playStart, playEnd) / (1000 * 60 * 60)) - breakInfo.hours)
    : Math.max(0, Math.round((new Date(checkoutLog.logged_at) - new Date(sessionCheckin.logged_at)) / (1000 * 60 * 60)) - breakInfo.hours);

  // 획득 (레벨업/다운 반영)
  const levelDiff = (endLevel != null && startLevel != null) ? (endLevel - startLevel) : 0;
  const expGained = (endExp != null && startExp != null)
    ? (levelDiff * 100 + endExp - startExp).toFixed(4) : null;
  const adenaGained = (endAdena != null && startAdena != null) ? endAdena - startAdena : null;

  // 1시간 평균
  const expAvg   = expGained   != null && hours > 0 ? (parseFloat(expGained) / hours).toFixed(4) : null;
  const adenaAvg = adenaGained != null && hours > 0 ? Math.round(adenaGained / hours) : null;

  const dateLabel = formatDate(checkoutLog.logged_at);
  const screenshotUrl = checkoutLog.screenshot_url || null;

  const text =
`${clientDisplayName} (운영 종료)
운영시간 : ${playStart ? colon(playStart) : '?'} ~ ${playEnd ? colon(playEnd) : '?'}${breakInfo.line ? `\n${breakInfo.line}` : ''}
${dateLabel}
총 사냥시간 : ${hours}시간

[경험치]
레벨 : ${endLevel != null ? endLevel : '-'}
시작 : ${startExp != null ? startExp.toFixed(4) + '%' : '-'}
종료 : ${endExp   != null ? endExp.toFixed(4)   + '%' : '-'}
획득 : ${expGained != null ? (parseFloat(expGained) >= 0 ? '+' + expGained : expGained) + '%' : '-'}
1시간 평균 : ${expAvg != null ? (parseFloat(expAvg) >= 0 ? '+' + expAvg : expAvg) + '%' : '-'}

[아덴]
시작 : ${formatNumber(startAdena)}
종료 : ${formatNumber(endAdena)}
획득 : ${adenaGained != null ? (adenaGained >= 0 ? '+' : '') + formatNumber(adenaGained) : '-'}
1시간 평균 : ${formatNumber(adenaAvg)}`;

  if (screenshotUrl) {
    return res.json(makeImageTextResponse(screenshotUrl, `${clientDisplayName} 종료 스크린샷`, text));
  }
  return res.json(makeTextResponse(text));
}

// 진행 중 세션
async function renderActiveSession(res, clientDisplayName, latestLog) {
  // play_time 있는 가장 최근 체크인 = 현재 운영 윈도우 정의
  const { data: ptCheckIns } = await supabase
    .from('session_logs')
    .select('*')
    .eq('client_name', clientDisplayName)
    .eq('report_type', 'CHECKIN')
    .not('play_time_start', 'is', null)
    .order('logged_at', { ascending: false });
  const windowCheckIn = ptCheckIns?.[0];

  let logs;
  let windowStart = null;
  let useWindow = false;

  if (windowCheckIn?.play_time_start) {
    windowStart = getWindowStart(windowCheckIn.play_time_start, latestLog.logged_at);
    const windowEnd = new Date(
      windowStart.getTime() + windowDurationMs(windowCheckIn.play_time_start, windowCheckIn.play_time_end)
    );
    const latestT = new Date(latestLog.logged_at).getTime();
    if (latestT >= windowStart.getTime() && latestT <= windowEnd.getTime()) {
      useWindow = true;
    }
  }

  if (useWindow) {
    const { data: winLogs } = await supabase
      .from('session_logs')
      .select('*')
      .eq('client_name', clientDisplayName)
      .neq('report_type', 'CHECKOUT')
      .gte('logged_at', windowStart.toISOString())
      .order('logged_at', { ascending: true });
    logs = winLogs;
  } else {
    const { data: lastCheckOut } = await supabase
      .from('session_logs')
      .select('*')
      .eq('client_name', clientDisplayName)
      .eq('report_type', 'CHECKOUT')
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    let q = supabase
      .from('session_logs')
      .select('*')
      .eq('client_name', clientDisplayName)
      .neq('report_type', 'CHECKOUT')
      .order('logged_at', { ascending: true });
    if (lastCheckOut) q = q.gt('logged_at', lastCheckOut.logged_at);
    const { data: fbLogs } = await q;
    logs = fbLogs;
  }

  if (!logs || logs.length === 0) {
    return res.json(makeTextResponse(
      `"${clientDisplayName}" 님의 세션 기록이 없습니다.\n아직 체크인이 되지 않았을 수 있습니다.`
    ));
  }

  const sessionStart = logs[0];
  const checkInLog = logs.slice().reverse().find(l => l.report_type === 'CHECKIN') || sessionStart;
  const lastLog = logs[logs.length - 1];

  // play_time 출처: 윈도우면 windowCheckIn, 아니면 세션 내 play_time 있는 체크인
 const ptSource = (useWindow && windowCheckIn)
  ? windowCheckIn
  : (logs.slice().reverse().find(l => l.report_type === 'CHECKIN' && l.play_time_start) || checkInLog);

  const playStartStr = ptSource.play_time_start;
  const playEndStr   = ptSource.play_time_end;
  const breakInfo = getBreakInfo(playStartStr, playEndStr, clientDisplayName);

  // 사냥시간 = 경과시간 - (휴식 끝 시각 지났으면 휴식시간)
  const rawHours = Math.round((new Date(lastLog.logged_at) - new Date(sessionStart.logged_at)) / (1000 * 60 * 60));
  let breakDeduction = 0;
  if (windowStart && breakInfo.hours > 0 && playStartStr) {
    const breakEndHour = getBreakEndHour(playStartStr, playEndStr);
    const startHour = parseInt(String(playStartStr).split(/[:.]/)[0], 10);
    let hoursFromShiftStartToBreakEnd = breakEndHour - startHour;
    if (hoursFromShiftStartToBreakEnd <= 0) hoursFromShiftStartToBreakEnd += 24;
    const breakEndAbsolute = windowStart.getTime() + hoursFromShiftStartToBreakEnd * 60 * 60 * 1000;
    if (new Date(lastLog.logged_at).getTime() >= breakEndAbsolute) {
      breakDeduction = 1;
    }
  }
  const hours = Math.max(0, rawHours - breakDeduction);

  // 시작값 / 현재값
  const expStart   = checkInLog.exp_after;
  const adenaStart = checkInLog.adena_after;
  const expNow     = lastLog.exp_after;
  const adenaNow   = lastLog.adena_after;
  const levelStart = checkInLog.level;
  const levelNow   = lastLog.level;

  const levelDiff = (levelNow != null && levelStart != null) ? (levelNow - levelStart) : 0;
  const expGained = (expNow != null && expStart != null) ? (levelDiff * 100 + expNow - expStart).toFixed(4) : null;
  const adenaGained = (adenaNow != null && adenaStart != null) ? adenaNow - adenaStart : null;

  const expAvg   = expGained   != null && hours > 0 ? (parseFloat(expGained) / hours).toFixed(4) : null;
  const adenaAvg = adenaGained != null && hours > 0 ? Math.round(adenaGained / hours) : null;

  const dateLabel = formatDate(useWindow ? windowStart.toISOString() : sessionStart.logged_at);
  const timeStart = playStartStr ? colon(playStartStr) : formatTime(sessionStart.logged_at);
  const timeEnd   = formatTime(lastLog.logged_at);

  const screenshotUrl = lastLog.screenshot_url || null;

  const text =
`${clientDisplayName}
운영시간 : ${playStartStr ? colon(playStartStr) : '?'} ~ ${playEndStr ? colon(playEndStr) : '?'}${breakInfo.line ? `\n${breakInfo.line}` : ''}
${dateLabel} ${timeStart} ~ ${timeEnd}
현재까지 사냥시간 : ${hours}시간

[경험치]
레벨 : ${levelNow != null ? levelNow : '-'}
시작 : ${expStart != null ? expStart.toFixed(4) + '%' : '-'}
현재 : ${expNow   != null ? expNow.toFixed(4)   + '%' : '-'}
획득 : ${expGained != null ? (parseFloat(expGained) >= 0 ? '+' + expGained : expGained) + '%' : '-'}
1시간 평균 : ${expAvg != null ? (parseFloat(expAvg) >= 0 ? '+' + expAvg : expAvg) + '%' : '-'}

[아덴]
시작 : ${formatNumber(adenaStart)}
현재 : ${formatNumber(adenaNow)}
획득 : ${adenaGained != null ? (adenaGained >= 0 ? '+' : '') + formatNumber(adenaGained) : '-'}
1시간 평균 : ${formatNumber(adenaAvg)}`;

  if (screenshotUrl) {
    return res.json(makeImageTextResponse(screenshotUrl, `${clientDisplayName} 세션 스크린샷`, text));
  }
  return res.json(makeTextResponse(text));
}


// ████████████████████████████████████████████████████
// [디스코드 봇] 리포트 메시지 파싱 → Supabase 저장
// ████████████████████████████████████████████████████

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// 클라이언트 번호/키워드로 display_name 조회
async function resolveClientName(raw) {
  if (!raw) return null;
  raw = raw.trim();

  // "1. 흰쌀" 형태 → 이름 부분 먼저 추출
  const numNameMatch = raw.match(/^\d+[\.\s]+(.+)/);
  if (numNameMatch) {
    raw = numNameMatch[1].trim();
  }

  // 키워드로 매칭
  const { data: allClients } = await supabase.from('clients').select('*');
  if (allClients) {
    for (const c of allClients) {
      const keywords = (c.keywords || '').split(',');
      for (const kw of keywords) {
        if (kw.trim() && raw.includes(kw.trim())) {
          return c.display_name;
        }
      }
    }
  }

  // 그냥 원문 반환
  return raw;
}

// 경험치 파싱 (소수점 포함)
function parseExp(str) {
  if (!str) return null;
  str = str.trim().replace(/^\+/, '').replace(/%/g, '').trim();
  // 콤마를 점으로 변환 (유럽식 소수점)
  str = str.replace(',', '.');
  return parseFloat(str) || null;
}

// 아덴 파싱 (천단위 구분자 제거)
function parseAdena(str) {
  if (!str) return null;
  str = str.trim().replace(/[.,]/g, '');
  return parseInt(str) || null;
}

function get(content, key) {
  const regex = new RegExp(`${key}\\s*:\\s*(.+)`);
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

async function parseReport(content) {
  // 리포트 타입 감지
  let reportType = 'SESSION';
  if (content.includes('CHECK IN')) reportType = 'CHECKIN';
  else if (content.includes('CHECK OUT')) reportType = 'CHECKOUT';

  // 클라이언트 이름
  const clientRaw = get(content, 'CLIENT NICKNAME');
  const clientName = await resolveClientName(clientRaw);

  // PLAY TIME 파싱 (체크인 전용)
  const playTimeRaw = content.match(/PLAY\s*TIME\s*[:=\s]\s*(.+)/i)?.[1]?.trim();
  let playTimeStart = null, playTimeEnd = null;
  if (playTimeRaw) {
    const pt = playTimeRaw?.match(/(\d{1,2}[:.]?\d{2})\s*[-~–]\s*(\d{1,2}[:.]?\d{2})/);
    if (pt) {
      playTimeStart = pt[1];
      playTimeEnd = pt[2];
    }
  }

  // 레벨
  const level = parseInt(get(content, 'LV')) || null;

  // 경험치
  const expRaw = get(content, 'EXP');
  let expBefore = null, expAfter = null;
  if (expRaw) {
    // 범위: "8.8261% → 9.6099%" or "77.284% > 78.8013%"
    const m = expRaw.match(/([\d.,]+)%?\s*(?:->|→|>)\s*([\d.,]+)%?/);
    if (m) {
      expBefore = parseExp(m[1]);
      expAfter  = parseExp(m[2]);
    } else {
      // 단일값 (CHECK IN)
      expAfter = parseExp(expRaw.replace(/%/g, '').trim());
    }
  }

  const expGainedRaw = get(content, 'EXP GAINED');
  const expGained = expGainedRaw ? parseExp(expGainedRaw) : null;

  // 아덴
  const adenaRaw = get(content, 'ADENA');
  let adenaBefore = null, adenaAfter = null;
  if (adenaRaw) {
    const m = adenaRaw.match(/([\d.,]+)\s*(?:->|→|>)\s*([\d.,]+)/);
    if (m) {
      adenaBefore = parseAdena(m[1]);
      adenaAfter  = parseAdena(m[2]);
    } else {
      // 단일값 (CHECK IN)
      adenaAfter = parseAdena(adenaRaw.trim());
    }
  }

  const adenaGainedRaw = get(content, 'ADENA GAINED');
  const adenaGained = adenaGainedRaw ? parseAdena(adenaGainedRaw) : null;

  return { clientName, level, expBefore, expAfter, expGained, adenaBefore, adenaAfter, adenaGained, reportType, playTimeStart, playTimeEnd };
}

client.on('threadCreate', async (thread) => {
  thread.join();
});

client.on('messageCreate', async (message) => {
  console.log(`메시지 수신: ${message.channel.name} / ${message.channel.parent?.name}`);
  if (message.author.bot && !message.webhookId) return;

  if (!message.content.includes('SESSION REPORT') &&
      !message.content.includes('CHECK IN REPORT') &&
      !message.content.includes('CHECK OUT REPORT')) return;

  console.log('리포트 감지!');

  const parts = message.channel.name.split(/[-\/]/).map(p => p.trim());
  const boosterName = parts[parts.length - 1].toUpperCase();

  const parsed = await parseReport(message.content);
  console.log(`파싱 결과: ${parsed.clientName} / ${parsed.reportType}`);

  if (!parsed.clientName) {
    try { await message.react('❌'); } catch(e) {}
    return;
  }

  const attachment = message.attachments.first();
  const screenshotUrl = attachment ? attachment.url : null;

  const { error } = await supabase.from('session_logs').insert({
    client_name:     parsed.clientName,
    booster_channel: boosterName,
    level:           parsed.level,
    exp_before:      parsed.expBefore,
    exp_after:       parsed.expAfter,
    exp_gained:      parsed.expGained,
    adena_before:    parsed.adenaBefore,
    adena_after:     parsed.adenaAfter,
    adena_gained:    parsed.adenaGained,
    screenshot_url:  screenshotUrl,
    report_type:     parsed.reportType,
    logged_at:       new Date().toISOString(),
    play_time_start: parsed.playTimeStart,
    play_time_end:   parsed.playTimeEnd,
  });

  if (error) {
    console.log('DB 저장 실패:', error.message);
    try { await message.react('❌'); } catch(e) {}
  } else {
    console.log('DB 저장 성공!');
    try { await message.react('✅'); } catch(e) {}
  }
});


// ████████████████████████████████████████████████████
// 서버 시작 + 봇 로그인
// ████████████████████████████████████████████████████

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`통합 서버 실행 중 - 포트 ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
