#!/usr/bin/env node
const __PROJECT_ROOT__ = require('path').resolve(__dirname, '..', '..');  // 2026-09-26 搬進 apps/TaiwanWater

/**
 * apps/TaiwanWater/build-taiwanwater.js — 水利署水庫水情 → apps/TaiwanWater/taiwanwater-data.js（window.WATER_DATA）
 *
 * 資料源（Phase 0 驗證 2026-07-24，全部免金鑰直抓 opendata.wra.gov.tw）：
 *  - 45501 水庫水情資料（每時，近 24h 滾動窗）：有效蓄水量/水位/本日集水區累積雨量 → 每庫取最新一筆
 *  - 41568 水庫每日營運狀況（每日）：水庫名稱＋有效容量（蓄水率分母正本）
 *  - 32726 水庫基本資料（每年）：目前有效容量/型式/功能/最近庫容測量時間（淤積統計範圍標註）
 *  歷史：apps/TaiwanWater/taiwanwater-history.json（repo根目錄，只增不減入版控）——日更由本檔累積當日快照；
 *        2021 乾旱年＋近一年回補由 apps/TaiwanWater/build-taiwanwater-backfill.js 一次性寫入（fhy GetComparision）。
 *
 * 統計範圍：蓄水率 = 45501 有效蓄水量 ÷ 41568 有效容量（無 41568 分母退用 32726 目前有效容量）。
 *  ⚠ 官方 dataset 註記：勿用綠/黃/橙/紅色階暗示水情燈號（前端一律單色藍 ramp＋文字標註）。
 *
 * 擴章（2026-07-25 計劃書 §8，G0 驗證同日）：地下水位＋河川水位，全部免金鑰直抓：
 *  - 161082 即時地下水水位（每時，近 1h 滾動窗；wellidentifier＋waterlevel 高程 m）
 *  - 32718  地下水水位觀測井井況（縣市/鄉鎮/地下水分區/井深；⚠ API 單趟 1000 列上限、offset 不支援，
 *           758 現役井實測全數命中；未命中時退用白名單內建縣市欄）
 *  - 25768  河川即時水位（每站最新一筆；stationid＋waterlevel 高程 m）
 *  - 22227  河川水位測站站況（basinidentifier=stationid join；站名/河川名/一二三級警戒水位）
 *  白名單＝統計範圍正本（GW_WELLS 彰雲嘉沿海＋高鐵沿線 12 井、RIVER_STATIONS 主要河川 23 站）。
 *  擴章任一源掛掉 → 該章 err 標註不中止主管線；歷史檔 apps/TaiwanWater/taiwanwater-gw-history.json /
 *  apps/TaiwanWater/taiwanwater-river-history.json（只增不減，走 taiwan-lib mergeHistory）。
 *
 * 用法：node apps/TaiwanWater/build-taiwanwater.js [--offline]
 */
const fs = require('fs');
const path = require('path');

const ROOT = __PROJECT_ROOT__;
const OUT = path.join(ROOT, 'apps/TaiwanWater/taiwanwater-data.js');
const RAW = path.join(ROOT, 'apps/TaiwanWater/taiwanwater-raw');
const HISTORY = path.join(ROOT, 'apps/TaiwanWater/taiwanwater-history.json'); // ⚠ 只增不減，勿刪
const UA = 'Mozilla/5.0 (TaiwanWater ETL; WRA open data)';
const SOURCE_STATE = {};

// check＝首列必備欄位（⚠ WRA API 連續請求下會「錯配回應」——2026-07-25 實測 41568 的 URL 回過
// 32726 的內容；欄位不符視同抓取失敗，不寫 raw、走重試，防 raw 污染）
const SOURCES = {
  rt: { id: '45501', url: 'https://opendata.wra.gov.tw/api/v2/2be9044c-6e44-4856-aad5-dd108c2e6679?sort=_importdate%20asc&format=JSON', check: ['reservoiridentifier', 'observationtime'] },
  daily: { id: '41568', url: 'https://opendata.wra.gov.tw/api/v2/51023e88-4c76-4dbc-bbb9-470da690d539?sort=_importdate%20asc&format=JSON', check: ['reservoiridentifier', 'capacity'] },
  basic: { id: '32726', url: 'https://opendata.wra.gov.tw/api/v2/708a43b0-24dc-40b7-9ed2-fca6a291e7ae?sort=_importdate%20asc&format=JSON', check: ['水庫代碼', '水庫名稱'] },
  // 擴章四源（2026-07-25 G0 驗證，皆免金鑰）
  gwLive: { id: '161082', url: 'https://opendata.wra.gov.tw/api/v2/58a7aa39-287a-4b96-985d-47ffbc7abbd4?sort=_importdate%20asc&format=JSON', check: ['wellidentifier', 'recordtime'] },
  gwWell: { id: '32718', url: 'https://opendata.wra.gov.tw/api/v2/3e86faea-e94a-4a91-a870-852d73e83c3d?sort=_importdate%20asc&format=JSON', check: ['wellidentifier', 'countyname'] },
  rivLive: { id: '25768', url: 'https://opendata.wra.gov.tw/api/v2/73c4c3de-4045-4765-abeb-89f9f9cd5ff0?sort=_importdate%20asc&format=JSON', check: ['stationid', 'datetime'] },
  rivSt: { id: '22227', url: 'https://opendata.wra.gov.tw/api/v2/c4acc691-7416-40ca-9464-292c0c00da92?sort=_importdate%20asc&format=JSON', check: ['basinidentifier', 'observatoryname'] },
};

const GW_HISTORY = path.join(ROOT, 'apps/TaiwanWater/taiwanwater-gw-history.json');     // ⚠ 只增不減，勿刪
const RIVER_HISTORY = path.join(ROOT, 'apps/TaiwanWater/taiwanwater-river-history.json'); // ⚠ 只增不減，勿刪
const { mergeHistory } = require('../../taiwan-lib.js');

// 地下水代表井白名單（統計範圍正本；彰雲嘉沿海地層下陷熱區＋雲林高鐵沿線，統一取各站編號(2)中深層井；
// 2026-07-25 G0 實測 12 井當日皆有觀測。縣市/鄉鎮為內建統計範圍（32718 未命中時後備顯示））
const GW_WELLS = [
  { id: '3132014GW07200321', site: '二林(2)', county: '彰化縣', town: '二林鎮' },
  { id: '3132014GW07240223', site: '西港(2)', county: '彰化縣', town: '大城鄉' },
  { id: '3132015GW09130222', site: '興化(2)', county: '雲林縣', town: '麥寮鄉' },
  { id: '3132015GW09160122', site: '海園(2)', county: '雲林縣', town: '臺西鄉' },
  { id: '3132015GW09190122', site: '宜梧(2)', county: '雲林縣', town: '口湖鄉' },
  { id: '3132015GW09180321', site: '明德(2)', county: '雲林縣', town: '四湖鄉' },
  { id: '3132015GW09170222', site: '元長(2)', county: '雲林縣', town: '元長鄉' },
  { id: '3132015GW09030122', site: '虎尾(2)', county: '雲林縣', town: '虎尾鎮' },
  { id: '3132015GW10090121', site: '東石(2)', county: '嘉義縣', town: '東石鄉' },
  { id: '3132015GW10030321', site: '布袋(2)', county: '嘉義縣', town: '布袋鎮' },
  { id: '3132015GW10080121', site: '六腳(2)', county: '嘉義縣', town: '六腳鄉' },
  { id: '3132015GW10100121', site: '平溪(2)', county: '嘉義縣', town: '義竹鄉' },
];

// 河川代表站白名單（統計範圍正本；主要河川各 1 站、皆有官方警戒水位值；2026-07-25 G0 實測皆當日新鮮）
const RIVER_STATIONS = [
  { id: '2560H006', name: '蘭陽大橋', river: '蘭陽溪', region: '北部' },
  { id: '1140H029', name: '台北橋', river: '淡水河', region: '北部' },
  { id: '1140H111', name: '新海大橋', river: '大漢溪', region: '北部' },
  { id: '1140H052', name: '中正橋', river: '新店溪', region: '北部' },
  { id: '1140H077', name: '大直橋', river: '基隆河', region: '北部' },
  { id: '1300H017', name: '經國橋', river: '頭前溪', region: '北部' },
  { id: '1350H012', name: '北勢大橋', river: '後龍溪', region: '中部' },
  { id: '1400H009', name: '義里', river: '大安溪', region: '中部' },
  { id: '1420H055', name: '東勢大橋', river: '大甲溪', region: '中部' },
  { id: '1430H025', name: '大肚橋', river: '烏溪', region: '中部' },
  { id: '1510H058', name: '自強大橋', river: '濁水溪', region: '中部' },
  { id: '1540H009', name: '北港(2)', river: '北港溪', region: '中部' },
  { id: '1550H012', name: '灣內橋', river: '朴子溪', region: '南部' },
  { id: '1580H007', name: '軍輝橋', river: '八掌溪', region: '南部' },
  { id: '1590H012', name: '新營', river: '急水溪', region: '南部' },
  { id: '1630H023', name: '麻善大橋', river: '曾文溪', region: '南部' },
  { id: '1650H017', name: '溪頂寮橋', river: '鹽水溪', region: '南部' },
  { id: '1660H011', name: '39號二仁溪橋', river: '二仁溪', region: '南部' },
  { id: '1730H068', name: '高屏大橋', river: '高屏溪', region: '南部' },
  { id: '1740H002', name: '潮州', river: '東港溪', region: '南部' },
  { id: '2200H011', name: '台東大橋', river: '卑南溪', region: '東部' },
  { id: '2370H017', name: '瑞穗大橋', river: '秀姑巒溪', region: '東部' },
  { id: '2420H024', name: '花蓮大橋', river: '花蓮溪', region: '東部' },
];

// 防災主力水庫（fhy ReservoirStationsApi/GetAll，2026-07-24；單庫趨勢章＝有 2021 回補者）
const MAIN_CODES = ['10201', '10205', '10401', '10405', '10501', '10601', '20101', '20201', '20202', '20501', '20502', '20503', '20509', '30301', '30401', '30501', '30502', '30503', '30802', '30901', '31201'];

const REGION = { 1: '北部', 2: '中部', 3: '南部', 4: '東部', 5: '離島' };

// 41568/32726 皆無名稱的代碼後備表（名稱正本＝fhy ReservoirStationsApi/GetAll）
const FALLBACK_NAMES = { '30901': '高屏溪攔河堰' };

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

// 水利署即時水位欄位以 -999998 表示缺測；地下水高程的正常負值必須保留。
function waterLevel(v) {
  const n = num(v);
  return n === -999998 ? null : n;
}

// WRA API 對連續請求會間歇性截斷 JSON（2026-07-25 實測），重試 3 次退避
async function fetchJson(key) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise(r => setTimeout(r, 2000 * i));
    try {
      const res = await fetch(SOURCES[key].url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${key}(${SOURCES[key].id}) HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) throw new Error(`${key} 空回應`);
      for (const f of SOURCES[key].check || []) {
        if (!(f in data[0])) throw new Error(`${key} 欄位不符（缺 ${f}，疑似 API 錯配回應）`);
      }
      fs.mkdirSync(RAW, { recursive: true });
      const rawFile = path.join(RAW, `${SOURCES[key].id}.json`);
      fs.writeFileSync(rawFile, JSON.stringify(data));
      SOURCE_STATE[key] = { status: 'fresh', cachedAt: fs.statSync(rawFile).mtime.toISOString() };
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function readRaw(key) {
  const rawFile = path.join(RAW, `${SOURCES[key].id}.json`);
  const data = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  SOURCE_STATE[key] = { status: 'cached', cachedAt: fs.statSync(rawFile).mtime.toISOString() };
  return data;
}

async function getSource(key, offline) {
  if (offline) return readRaw(key);
  try { return await fetchJson(key); }
  catch (e) {
    console.warn(`  ! ${key} 抓取失敗（${e.message}），改用既有 raw`);
    return readRaw(key); // raw 也沒有 → throw → 保留舊 data.js
  }
}

function loadHistory() {
  if (!fs.existsSync(HISTORY)) return { _note: '水庫每日蓄水史（只增不減勿刪）。值=[蓄水量萬m3, 蓄水率%]。來源：日更取 45501 當日最新＋backfill 取 fhy GetComparision 07:00 快照。', series: {} };
  return JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
}

/* ── 擴章：地下水位＋河川水位（計劃書 §8；失敗容忍，絕不中止主管線） ── */

// 擴章專用軟抓取：live 源失敗退既有 raw、raw 也沒有 → null（該章標暫無資料）
async function getSourceSoft(key, offline) {
  try { return await getSource(key, offline); }
  catch (e) { console.warn(`  ! 擴章源 ${key} 不可用（${e.message}），該章標暫無資料`); return null; }
}

// 擴章 history（rows=[{d,id,v}]，只增不減走 taiwan-lib mergeHistory）
function mergeExtHistory(file, note, newRows) {
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { _note: note, rows: [] };
  const { rows, added } = mergeHistory(old.rows, newRows, r => `${r.d}|${r.id}`);
  fs.writeFileSync(file, JSON.stringify({ _note: note, rows }));
  return { rows, added };
}

// 地下水章：白名單 12 井最新觀測＋井況 join＋history 累積
async function buildGroundwater(offline) {
  const [live, meta] = await Promise.all([getSourceSoft('gwLive', offline), getSourceSoft('gwWell', offline)]);
  if (!live) return { err: '即時地下水位源（161082）暫時無法取得', wells: [], history: readExtHistoryRows(GW_HISTORY) };
  const latest = new Map();
  for (const r of live) {
    const k = r.wellidentifier;
    if (!k) continue;
    if (!latest.has(k) || r.recordtime > latest.get(k).recordtime) latest.set(k, r);
  }
  const metaMap = new Map();
  for (const r of meta || []) metaMap.set(r.wellidentifier, r);
  const wells = GW_WELLS.map(w => {
    const o = latest.get(w.id);
    const m = metaMap.get(w.id);
    return {
      id: w.id, site: w.site, county: w.county, town: w.town,
      zone: m ? m.groundwaterzone : null,
      depth: m ? num(m.welldepth) : null,
      level: o ? waterLevel(o.waterlevel) : null,
      at: o ? o.recordtime : null,
    };
  });
  const got = wells.filter(w => w.level != null);
  const newRows = got.map(w => ({ d: w.at.slice(0, 10), id: w.id, v: w.level }));
  const { rows, added } = mergeExtHistory(GW_HISTORY,
    '地下水代表井每日水位史（只增不減勿刪）。rows=[{d:日期,id:井代碼,v:水位高程m}]。來源：161082 即時地下水位，日更取當日最新觀測。', newRows);
  console.log(`  地下水章：${got.length}/${GW_WELLS.length} 井有觀測、history 新增 ${added} 格`);
  return { err: got.length ? null : '白名單井當日皆無觀測', wells, history: validWaterHistory(rows) };
}

function readExtHistoryRows(file) {
  const rows = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).rows || []) : [];
  return validWaterHistory(rows);
}

function validWaterHistory(rows) {
  return rows.filter(r => r && waterLevel(r.v) != null).map(r => ({ ...r, v: waterLevel(r.v) }));
}

// 河川章：白名單 23 站最新水位＋站況警戒值 join＋history 累積
async function buildRiver(offline) {
  const [live, st] = await Promise.all([getSourceSoft('rivLive', offline), getSourceSoft('rivSt', offline)]);
  if (!live) return { err: '河川即時水位源（25768）暫時無法取得', stations: [], history: readExtHistoryRows(RIVER_HISTORY) };
  const liveMap = new Map();
  for (const r of live) if (r.stationid) liveMap.set(r.stationid, r);
  const stMap = new Map();
  for (const r of st || []) stMap.set(r.basinidentifier, r);
  const stations = RIVER_STATIONS.map(s => {
    const o = liveMap.get(s.id);
    const m = stMap.get(s.id);
    const level = o ? waterLevel(o.waterlevel) : null;
    const a1 = m ? num(m.alertlevel1) : null, a2 = m ? num(m.alertlevel2) : null, a3 = m ? num(m.alertlevel3) : null;
    let status = null; // 文字標註（色彩合規：不用綠黃橙紅色階）
    if (level != null) {
      if (a1 == null && a2 == null && a3 == null) status = '警戒基準缺失，無法判定';
      else if (a1 != null && level >= a1) status = '達一級警戒';
      else if (a2 != null && level >= a2) status = '達二級警戒';
      else if (a3 != null && level >= a3) status = '達三級警戒';
      else status = '未達警戒';
    }
    return { id: s.id, name: s.name, river: s.river, region: s.region, level, at: o ? o.datetime : null, a1, a2, a3, status };
  });
  const got = stations.filter(s => s.level != null);
  const newRows = got.map(s => ({ d: s.at.slice(0, 10), id: s.id, v: s.level }));
  const { rows, added } = mergeExtHistory(RIVER_HISTORY,
    '河川代表站每日水位史（只增不減勿刪）。rows=[{d:日期,id:站代碼,v:水位高程m}]。來源：25768 河川即時水位，日更取各站最新觀測。', newRows);
  console.log(`  河川章：${got.length}/${RIVER_STATIONS.length} 站有觀測、history 新增 ${added} 格`);
  return { err: got.length ? null : '白名單站當日皆無觀測', stations, history: validWaterHistory(rows) };
}

async function main() {
  const offline = process.argv.includes('--offline');
  console.log(`[1/3] 抓取三源（offline=${offline}）`);
  const [rt, daily, basic] = await Promise.all([getSource('rt', offline), getSource('daily', offline), getSource('basic', offline)]);
  console.log(`  45501:${rt.length} 筆、41568:${daily.length} 筆、32726:${basic.length} 筆`);

  console.log('[2/3] 合併與蓄水率計算');
  // 45501 每庫取最新觀測
  const latest = new Map();
  for (const r of rt) {
    const k = r.reservoiridentifier;
    if (!k) continue;
    if (!latest.has(k) || r.observationtime > latest.get(k).observationtime) latest.set(k, r);
  }
  const name41 = new Map(), cap41 = new Map();
  for (const r of daily) {
    if (r.reservoiridentifier) {
      name41.set(r.reservoiridentifier, r.reservoirname);
      const c = num(r.capacity);
      if (c > 0) cap41.set(r.reservoiridentifier, c);
    }
  }
  const basicMap = new Map();
  for (const r of basic) {
    basicMap.set(r['水庫代碼'], {
      name: r['水庫名稱'], type: r['型式'], func: r['功能'], town: r['鄉鎮市區名稱'],
      curEffCap: num(r['目前有效容量']), measuredAt: String(r['最近完成庫容測量時間'] || '').trim(),
    });
  }

  const reservoirs = [];
  let computable = 0;
  for (const [code, r] of latest) {
    const b = basicMap.get(code);
    const name = name41.get(code) || (b && b.name) || FALLBACK_NAMES[code] || null;
    if (!name) continue; // 無名稱代碼（40701/30803）不上卡片牆
    const storage = num(r.effectivewaterstoragecapacity);
    const capSrc = cap41.has(code) ? '41568' : (b && b.curEffCap > 0 ? '32726' : null);
    const capacity = cap41.get(code) || (b && b.curEffCap > 0 ? b.curEffCap : null);
    let rate = null;
    if (storage != null && storage >= 0 && capacity > 0) {
      rate = Math.round(storage / capacity * 1000) / 10;
      if (rate > 130) rate = null; // 蓄水量>容量 130% 以上視為統計範圍異常不顯示比率
      else computable++;
    }
    reservoirs.push({
      code, name,
      region: REGION[code[0]] || '其他',
      obsTime: r.observationtime,
      storage: storage != null && storage >= 0 ? storage : null,
      capacity: capacity || null,
      capSrc,
      rate,
      level: waterLevel(r.waterlevel),
      rainToday: num(r.accumulaterainfallincatchment),
      main: MAIN_CODES.includes(code),
      type: b ? b.type : null, func: b ? b.func : null, town: b ? b.town : null,
      measuredAt: b ? b.measuredAt : null,
    });
  }
  if (computable < 40) throw new Error(`可算蓄水率僅 ${computable} 座（預期 ≥55），中止不覆寫`);
  reservoirs.sort((a, b) => (b.capacity || 0) - (a.capacity || 0));

  // 全台合計（有量且有分母者）
  let totS = 0, totC = 0;
  for (const r of reservoirs) if (r.rate != null) { totS += r.storage; totC += r.capacity; }
  const national = { storage: Math.round(totS), capacity: Math.round(totC), rate: Math.round(totS / totC * 1000) / 10, n: computable };

  console.log('[3/4] 擴章：地下水位＋河川水位（失敗容忍）');
  let gw, river;
  try { gw = await buildGroundwater(offline); }
  catch (e) { console.warn(`  ! 地下水章失敗（${e.message}）`); gw = { err: e.message, wells: [], history: readExtHistoryRows(GW_HISTORY) }; }
  try { river = await buildRiver(offline); }
  catch (e) { console.warn(`  ! 河川章失敗（${e.message}）`); river = { err: e.message, stations: [], history: readExtHistoryRows(RIVER_HISTORY) }; }

  console.log('[4/4] 歷史累積＋輸出');
  const hist = loadHistory();
  const builtAt = new Date().toISOString();
  let histAdd = 0;
  for (const r of reservoirs) {
    if (r.rate == null) continue;
    const s = hist.series[r.code] || (hist.series[r.code] = {});
    const day = r.obsTime.slice(0, 10);
    if (!s[day]) { s[day] = [Math.round(r.storage * 10) / 10, r.rate]; histAdd++; }
  }
  fs.writeFileSync(HISTORY, JSON.stringify(hist));

  // 單庫趨勢資料：主力庫近 400 日＋2021 全年
  const trends = {};
  for (const code of MAIN_CODES) {
    const s = hist.series[code];
    if (!s) continue;
    const keys = Object.keys(s).sort();
    const y2021 = keys.filter(d => d.startsWith('2021')).map(d => [d.slice(5), s[d][1]]);
    const recent = keys.filter(d => d > '2022').slice(-400).map(d => [d, s[d][1]]);
    trends[code] = { y2021, recent };
  }

  // 頂層快照時間必須來自觀測，不得以離線重建時間冒充新資料。
  const snapshotAt = reservoirs.map(r => r.obsTime)
    .concat(gw.wells.map(w => w.at), river.stations.map(s => s.at))
    .filter(Boolean).sort().pop() || null;

  const data = {
    meta: {
      title: '水庫水情監測站',
      generatedAt: snapshotAt,
      snapshotAt,
      builtAt,
      sourceStatus: SOURCE_STATE,
      fetchError: null,
      source: '經濟部水利署開放資料（45501 水庫水情、41568 水庫每日營運、32726 水庫基本資料、161082 即時地下水位、32718 觀測井井況、25768 河川即時水位、22227 水位測站站況，opendata.wra.gov.tw 直抓）；歷史回補：水利署防災資訊服務網水庫歷史比較（fhy.wra.gov.tw）',
      license: '政府資料開放授權條款－第 1 版（須註明出處：經濟部水利署）',
      colorNote: '依水利署開放資料注意事項，本站不以綠/黃/橙/紅色階表示蓄水率，避免與官方水情燈號混淆；水情燈號請以水利署網站為準。',
      today: snapshotAt ? snapshotAt.slice(0, 10) : null,
      counts: { reservoirs: reservoirs.length, computable, histAdd, gwWells: gw.wells.filter(w => w.level != null).length, rivStations: river.stations.filter(s => s.level != null).length },
    },
    national,
    reservoirs,
    trends,
    gw,
    river,
  };
  fs.writeFileSync(OUT, 'window.WATER_DATA = ' + JSON.stringify(data) + ';\n');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`→ apps/TaiwanWater/taiwanwater-data.js 產出（${kb} KB；${reservoirs.length} 座、可算蓄水率 ${computable} 座、history 新增 ${histAdd} 日格；全台主要水庫 ${national.rate}%；地下水 ${data.meta.counts.gwWells}/${GW_WELLS.length} 井、河川 ${data.meta.counts.rivStations}/${RIVER_STATIONS.length} 站）`);
}

main().catch(e => { console.error('build 失敗（保留既有 apps/TaiwanWater/taiwanwater-data.js）:', e.message); process.exit(1); });
