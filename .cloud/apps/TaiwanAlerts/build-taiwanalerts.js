#!/usr/bin/env node
const __PROJECT_ROOT__ = require('path').resolve(__dirname, '..', '..');  // 2026-09-26 搬進 apps/TaiwanAlerts

/**
 * apps/TaiwanAlerts/build-taiwanalerts.js — 災防警報即時站資料引擎
 * 抓官方端點 → 存 apps/TaiwanAlerts/taiwanalerts-raw/ → 解析彙總 → 產 apps/TaiwanAlerts/taiwanalerts-data.js（window.ALERTS_DATA）
 *
 * 資料源正本（SOURCES 常數表，全部免 key 直抓；2026-07-23 實測）：
 *  - NCDR JSONAtomFeed：生效中災防示警（Public Domain）
 *  - CWA opendata S3：36h 預報 F-C0032-001、颱風警報 W-C0034-005、雷達 O-A0058-005（OGDL v1）
 *  - CWA 颱風資料庫 TDB：歷年警報颱風清單（1958–今，POST API）
 *
 * 防禦性：任一來源抓取失敗 → fallback 讀 apps/TaiwanAlerts/taiwanalerts-raw/ 既有檔並記 meta.fetchErrors；
 * 未列入 LIFE_CATS 的類別一律歸災防組（寧多勿漏）不 crash。
 * TAIWANALERTS_OFFLINE=1 時跳過抓取直用 raw（冪等測試用）。
 */
const fs = require('fs'), path = require('path');
const RAW = path.join(__PROJECT_ROOT__, 'apps/TaiwanAlerts/taiwanalerts-raw');
const OUT = path.join(__PROJECT_ROOT__, 'apps/TaiwanAlerts/taiwanalerts-data.js');
const OFFLINE = process.env.TAIWANALERTS_OFFLINE === '1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const SOURCES = {
  ncdr:    { url: 'https://alerts.ncdr.nat.gov.tw/JSONAtomFeed.ashx', raw: 'ncdr-feed.json', name: 'NCDR 災害示警公開資料（CAP 整合 feed）', license: 'Public Domain' },
  cwa36h:  { url: 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Forecast/F-C0032-001.json', raw: 'cwa-36h.json', name: '中央氣象署 F-C0032-001 一般天氣預報-今明36小時', license: 'OGDL v1' },
  typhoon: { url: 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Warning/W-C0034-005.json', raw: 'cwa-typhoon.json', name: '中央氣象署 W-C0034-005 颱風消息與警報', license: 'OGDL v1' },
  tdb:     { url: 'https://rdc28.cwa.gov.tw/TDB/public/warning_typhoon_list/get_warning_typhoon', raw: 'cwa-warning-typhoon-list.json', name: '中央氣象署颱風資料庫（歷年警報颱風）', license: '氣象署颱風資料庫', post: true },
};
const RADAR_URL = 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Observation/O-A0058-005.png';

const COUNTIES = ['臺北市','新北市','桃園市','臺中市','臺南市','高雄市','基隆市','新竹縣','新竹市','苗栗縣','彰化縣','南投縣','雲林縣','嘉義縣','嘉義市','屏東縣','宜蘭縣','花蓮縣','臺東縣','澎湖縣','金門縣','連江縣'];
// 生活/工程通報類（其餘一律視為災防警特報）
const LIFE_CATS = new Set(['停水','火災','鐵路事故','消防安全檢查重大不合格場所','海洋污染','行動電話中斷','市話通訊中斷','道路封閉']);

const fetchErrors = [];
const sourceStatus = {};

async function grab(key) {
  const s = SOURCES[key];
  const rawPath = path.join(RAW, s.raw);
  if (!OFFLINE) {
    try {
      const res = await fetch(s.url, {
        method: s.post ? 'POST' : 'GET',
        headers: { 'User-Agent': UA, ...(s.post ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let text = await res.text();
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // TDB 帶 BOM
      const json = JSON.parse(text); // 先驗可解析才覆寫 raw
      fs.writeFileSync(rawPath, JSON.stringify(json));
      sourceStatus[key] = { state: 'fresh', checkedAt: new Date().toISOString(), sourceAt: new Date().toISOString() };
      return json;
    } catch (e) {
      fetchErrors.push(`${key}: ${e.message}（改用既有快照）`);
    }
  }
  const buf = fs.readFileSync(rawPath, 'utf8');
  sourceStatus[key] = { state: 'cached', checkedAt: new Date().toISOString(), sourceAt: fs.statSync(rawPath).mtime.toISOString() };
  return JSON.parse(buf.charCodeAt(0) === 0xFEFF ? buf.slice(1) : buf);
}

// "2026/7/23 下午 10:18:40" → "2026-07-23T22:18:40+08:00"（NCDR 中文 12 小時制；上午12=00、下午12=12）
function zhTimeToISO(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(上午|下午)\s*(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[5]) % 12;
  if (m[4] === '下午') h += 12;
  const p = n => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}T${p(h)}:${m[6]}:${m[7]}+08:00`;
}

const norm = s => String(s || '').replace(/台/g, '臺');
function extractCounties(text) {
  const t = norm(text);
  return COUNTIES.filter(c => t.includes(c) || t.includes(c.slice(0, 2)));
}
const asArr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };

function classifyAlertAt(item, at) {
  const now = typeof at === 'number' ? at : Date.parse(at);
  const effective = Date.parse(item.effective || '');
  const expires = Date.parse(item.expires || '');
  if (!Number.isFinite(now) || !Number.isFinite(effective) || !Number.isFinite(expires)) return 'unknown';
  if (now < effective) return 'pending';
  if (now >= expires) return 'expired';
  return 'active';
}

function buildAlerts(feed) {
  const root = feed.feed || feed;
  const entries = asArr(root.entry);
  // 同一 CAP 檔多筆示警共用 id（如整批停水公告）→ 以 id+summary 去重、保留 updated 最新
  const seen = new Map();
  for (const e of entries) {
    const summary = String((e.summary && e.summary['#text']) || '').trim();
    const k = e.id + '|' + summary;
    if (!seen.has(k) || String(e.updated) > String(seen.get(k).updated)) seen.set(k, e);
  }
  const parsedSnapshotAt = Date.parse(root.updated || '');
  const snapshotAt = Number.isFinite(parsedSnapshotAt) ? parsedSnapshotAt : null;
  const items = [];
  const catStat = new Map();
  for (const e of seen.values()) {
    const cat = (e.category && e.category['@term']) || '其他';
    const expISO = zhTimeToISO(e.expires);
    const effective = zhTimeToISO(e.effective);
    const state = e.msgType === 'Cancel' ? 'cancelled' : (snapshotAt == null ? 'unknown' : classifyAlertAt({ effective, expires: expISO }, snapshotAt));
    const active = state === 'active';
    const st = catStat.get(cat) || { category: cat, total: 0, active: 0 };
    st.total++; if (active) st.active++;
    catStat.set(cat, st);
    if (state === 'cancelled' || state === 'expired') continue;
    const summary = String((e.summary && e.summary['#text']) || '').trim();
    items.push({
      id: e.id, category: cat,
      group: LIFE_CATS.has(cat) ? 'life' : 'disaster',
      author: (e.author && e.author.name) || '',
      summary: summary.length > 300 ? summary.slice(0, 300) + '…' : summary,
      link: (e.link && e.link['@href']) || null,
      updated: e.updated || null,
      effective,
      expires: expISO,
      snapshotState: state,
      msgType: e.msgType || '',
      counties: extractCounties(summary),
    });
  }
  items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const byCategory = [...catStat.values()].sort((a, b) => b.active - a.active || b.total - a.total);
  return { feedUpdated: root.updated || null, snapshotAt: snapshotAt == null ? null : new Date(snapshotAt).toISOString(), entryTotal: entries.length, activeTotal: items.filter(i => i.snapshotState === 'active').length,
           disasterActive: items.filter(i => i.group === 'disaster' && i.snapshotState === 'active').length,
           lifeActive: items.filter(i => i.group === 'life' && i.snapshotState === 'active').length,
           byCategory, items };
}

function zhVal(x) { // MovingPrediction / StateTransfer 取 zh-hant；S3 版 {"@lang","#text"}、MCP 版 {lang,value} 都收
  const a = asArr(x);
  const hit = a.find(v => v && (v['@lang'] === 'zh-hant' || v.lang === 'zh-hant')) || a[0];
  if (!hit) return null;
  const v = hit['#text'] != null ? hit['#text'] : (hit.value != null ? hit.value : hit);
  return typeof v === 'string' ? v : null;
}

function buildTyphoon(j) {
  const root = j.cwaopendata || j;
  const ds = root.Dataset || root.dataset || {};
  const cyclones = asArr(ds.TropicalCyclones && ds.TropicalCyclones.TropicalCyclone);
  const storms = cyclones.map(t => {
    const fixes = asArr(t.AnalysisData && t.AnalysisData.Fix);
    const fc = asArr(t.ForecastData && t.ForecastData.Fix);
    const mkFix = f => ({
      time: f.DateTime || null, lon: num(f.CoordinateLongitude), lat: num(f.CoordinateLatitude),
      maxWind: num(f.MaxWindSpeed), gust: num(f.MaxGustSpeed), pressure: num(f.Pressure),
      movingSpeed: num(f.MovingSpeed), movingDir: f.MovingDirection || null,
      movingText: zhVal(f.MovingPrediction),
      r15: num(f.Circle15ms && f.Circle15ms.Radius), r25: num(f.Circle25ms && f.Circle25ms.Radius),
    });
    return {
      year: t.Year || null,
      name: t.CwaTyphoonName || t.TyphoonName || '未命名',
      engName: t.TyphoonName || '',
      tyNo: t.CwaTyNo || null, tdNo: t.CwaTdNo || null,
      isNamed: (t.TyphoonName || '') !== 'NONAME',
      track: fixes.map(mkFix),
      latest: fixes.length ? mkFix(fixes[fixes.length - 1]) : null,
      forecast: fc.map(f => Object.assign(mkFix(f), { hour: num(f.ForecastHour), initialTime: f.InitialTime || null,
        prob70: num(f.Radius70PercentProbability), state: zhVal(f.StateTransfer) })),
    };
  });
  return { present: storms.length > 0, issued: root.Sent || root.sent || null, storms };
}

function buildForecast(j) {
  const root = j.cwaopendata || j;
  const ds = root.dataset || root.Dataset || {};
  const locs = asArr(ds.location);
  const locations = locs.map(l => {
    const elems = {};
    for (const w of asArr(l.weatherElement)) elems[w.elementName] = asArr(w.time);
    const wxTimes = elems.Wx || [];
    const periods = wxTimes.map((t, i) => {
      const g = k => (elems[k] && elems[k][i] && elems[k][i].parameter) || {};
      return {
        start: t.startTime || null, end: t.endTime || null,
        wx: g('Wx').parameterName || '', wxCode: num(g('Wx').parameterValue),
        maxT: num(g('MaxT').parameterName), minT: num(g('MinT').parameterName),
        pop: num(g('PoP').parameterName), ci: g('CI').parameterName || '',
      };
    });
    return { name: norm(l.locationName), periods };
  });
  return { issued: root.sent || root.Sent || null, locations };
}

function buildHistory(list) {
  const arr = asArr(list);
  const byYear = {}, byMonth = {}, byIntensity = { s: 0, m: 0, w: 0 };
  for (const t of arr) {
    const y = String(t.id).slice(0, 4);
    byYear[y] = (byYear[y] || 0) + 1;
    const mo = t.sea_start_datetime ? Number(t.sea_start_datetime.slice(5, 7)) : null;
    if (mo) byMonth[mo] = (byMonth[mo] || 0) + 1;
    if (byIntensity[t.max_intensity] != null) byIntensity[t.max_intensity]++;
  }
  const years = Object.keys(byYear).map(Number);
  const recent = arr.slice(0, 10).map(t => ({
    id: t.id, name: t.cht_name, eng: t.eng_name, intensity: t.max_intensity,
    maxWind: num(t.max_wind_speed), minPressure: num(t.min_pressure),
    start: t.sea_start_datetime, end: t.sea_end_datetime, warningCount: num(t.warning_count),
  }));
  return { total: arr.length, yearMin: Math.min(...years), yearMax: Math.max(...years),
           byYear, byMonth, byIntensity, recent,
           note: '統計範圍＝中央氣象署曾發布颱風警報（海上警報以上）之颱風，非所有侵臺或生成之颱風' };
}

async function radarMeta() {
  if (!OFFLINE) {
    try {
      const res = await fetch(RADAR_URL, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const lm = res.headers.get('last-modified');
        return { imageUrl: RADAR_URL, lastModified: lm ? new Date(lm).toISOString() : null, ok: true };
      }
      fetchErrors.push('radar: HTTP ' + res.status);
    } catch (e) { fetchErrors.push('radar: ' + e.message); }
  }
  return { imageUrl: RADAR_URL, lastModified: null, ok: false };
}

async function main() {
  const ncdr = await grab('ncdr');
  const f36 = await grab('cwa36h');
  const ty = await grab('typhoon');
  const tdb = await grab('tdb');
  const radar = await radarMeta();
  const data = {
    meta: {
      title: '災防警報即時站',
      generatedAt: new Date().toISOString(),
      // 台北時間 ISO（前端「今/明」判斷與顯示都用這個，勿用 UTC 的 generatedAt 取日期）
      generatedAtTaipei: new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00'),
      fetchErrors: fetchErrors.length ? fetchErrors : null,
      sourceStatus,
      offline: OFFLINE || undefined,
      sources: Object.values(SOURCES).map(s => ({ name: s.name, license: s.license })),
      disclaimer: '本站為每日快照、非官方防災管道；災害應變與逃生決策以中央氣象署、國家災害防救科技中心及各級政府官方發布為準。',
    },
    alerts: buildAlerts(ncdr),
    typhoon: buildTyphoon(ty),
    forecast36h: buildForecast(f36),
    radar,
    history: buildHistory(tdb),
  };
  // 合理性哨兵：36h 應有 22 縣市；警報 feed 應非空
  if (data.forecast36h.locations.length < 20) throw new Error('36h 預報縣市數異常: ' + data.forecast36h.locations.length);
  if (data.alerts.entryTotal < 1) throw new Error('NCDR feed 空');
  fs.writeFileSync(OUT, 'window.ALERTS_DATA = ' + JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>') + ';\n');
  console.log(`→ apps/TaiwanAlerts/taiwanalerts-data.js 產出（feed ${data.alerts.entryTotal} 筆、生效 ${data.alerts.activeTotal}（災防 ${data.alerts.disasterActive}／生活 ${data.alerts.lifeActive}）、颱風 ${data.typhoon.storms.length}、36h ${data.forecast36h.locations.length} 縣市、歷史 ${data.history.total} 颱風${fetchErrors.length ? '；⚠ ' + fetchErrors.join('; ') : ''}）`);
}
if (require.main === module) {
  main().catch(e => { console.error('build 失敗（保留既有 apps/TaiwanAlerts/taiwanalerts-data.js）:', e.message); process.exit(1); });
}

module.exports = { classifyAlertAt, buildAlerts, zhTimeToISO };
