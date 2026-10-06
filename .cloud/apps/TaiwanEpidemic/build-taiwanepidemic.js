#!/usr/bin/env node
const __PROJECT_ROOT__ = require('path').resolve(__dirname, '..', '..');  // 2026-09-26 搬進 apps/TaiwanEpidemic

/**
 * apps/TaiwanEpidemic/build-taiwanepidemic.js — 讀 apps/TaiwanEpidemic/taiwanepidemic-raw/*.csv → 彙總 → 產 apps/TaiwanEpidemic/taiwanepidemic-data.js（window.EPIDEMIC_DATA）
 *
 * 資料源：疾管署急診傳染病監測（od.cdc.gov.tw RODS_*.csv，開放授權第1版）。
 * 統計範圍（Phase 0 驗證）：欄位為急診「就診人次」絕對數，非「就診比率」；源檔未附分母（急診總人次），
 *   依計劃書 §7 不自算比率，只呈現官方人次。跨年比較受各年急診量變動影響，頁面標注。
 * 資料範圍：2007W01 起，每檔約 5.4萬~10.9萬列，22 縣市，5 年齡別（呼吸道 vs 幼兒分組不同）。
 * 台/臺：來源縣市一律用「台」（台北/台中/台南/台東），仍統一正規化為「台」。
 *
 * 防禦性：任一 CSV 讀不到 → 保留既有 apps/TaiwanEpidemic/taiwanepidemic-data.js 不覆寫，並在 meta.fetchError 記錄。
 */
const fs = require('fs'), path = require('path');
const RAW = path.join(__PROJECT_ROOT__, 'apps/TaiwanEpidemic/taiwanepidemic-raw');
const OUT = path.join(__PROJECT_ROOT__, 'apps/TaiwanEpidemic/taiwanepidemic-data.js');

// 五症候群定義：檔名、顯示名、值欄位、年齡別排序、更新頻率
const SYND = [
  { key: 'ili',      file: 'ili.csv',            name: '類流感',       freq: '每日',
    ages: ['0~6', '7~12', '13~18', '19~64', '65+'] },
  { key: 'entero',   file: 'entero.csv',         name: '腸病毒',       freq: '每日',
    ages: ['0', '1~3', '4~6', '7~15', '16+'] },
  { key: 'diarrhea', file: 'diarrhea.csv',       name: '急性腹瀉',     freq: '每週',
    ages: ['0~6', '7~12', '13~18', '19~64', '65+'] },
  { key: 'conj',     file: 'conjunctivitis.csv', name: '紅眼症',       freq: '每日',
    ages: ['0~6', '7~12', '13~18', '19~64', '65+'] },
  { key: 'herp',     file: 'herpangina.csv',     name: '疱疹性咽峽炎', freq: '每日',
    ages: ['0', '1~3', '4~6', '7~15', '16+'] },
];

// 縣市顯示順序（六都→省轄市→縣，離島殿後）
const COUNTY_ORDER = [
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
  '基隆市', '新竹市', '嘉義市',
  '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣',
  '澎湖縣', '金門縣', '連江縣',
];
const normCounty = s => (s || '').replace(/臺/g, '台').trim();

// 極簡 CSV 解析（本資料無引號逗號）
function readCsv(fp) {
  const txt = fs.readFileSync(fp, 'utf-8').replace(/^﻿/, '');
  const lines = txt.split(/\r?\n/).filter(l => l.length);
  return lines.slice(1).map(l => l.split(',')); // [年,週,年齡別,縣市,人次,縣市別代碼]
}

function pct(cur, prev) {
  if (prev == null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function buildSyndrome(s) {
  const rows = readCsv(path.join(RAW, s.file));
  const weekly = {}, countyWk = {}, ageWk = {};
  const yearsSet = new Set();
  for (const r of rows) {
    const [yr, wkRaw, age, cRaw, vRaw] = r;
    if (!yr || !wkRaw) continue;
    const wk = parseInt(wkRaw, 10);
    const v = parseInt(vRaw, 10);
    if (!Number.isFinite(wk) || !Number.isFinite(v)) continue;
    const county = normCounty(cRaw);
    yearsSet.add(yr);
    (weekly[yr] = weekly[yr] || {})[wk] = (weekly[yr][wk] || 0) + v;
    (countyWk[yr] = countyWk[yr] || {})[wk] = countyWk[yr][wk] || {};
    countyWk[yr][wk][county] = (countyWk[yr][wk][county] || 0) + v;
    (ageWk[yr] = ageWk[yr] || {})[wk] = ageWk[yr][wk] || {};
    ageWk[yr][wk][age] = (ageWk[yr][wk][age] || 0) + v;
  }
  const years = [...yearsSet].sort();
  const latestYear = years[years.length - 1];
  const latestWeek = Math.max(...Object.keys(weekly[latestYear]).map(Number));

  // 全國週序列（給曲線）：每年一條 {week: value}
  const series = {};
  for (const y of years) series[y] = weekly[y];

  // 近十年（不含當年）同週基線 min/median/max，做「往年同期範圍」參考帶
  const baselineYears = years.filter(y => y < latestYear).slice(-10);
  const baseline = {};
  for (let wk = 1; wk <= 53; wk++) {
    const vals = baselineYears.map(y => (weekly[y] || {})[wk]).filter(v => v != null).sort((a, b) => a - b);
    if (!vals.length) continue;
    const med = vals.length % 2 ? vals[(vals.length - 1) / 2]
      : Math.round((vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2);
    baseline[wk] = { min: vals[0], med, max: vals[vals.length - 1] };
  }

  // KPI
  const curVal = weekly[latestYear][latestWeek];
  const prevVal = (weekly[latestYear][latestWeek - 1] != null) ? weekly[latestYear][latestWeek - 1] : null;
  const prevYear = String(parseInt(latestYear, 10) - 1);
  const yoyVal = (weekly[prevYear] || {})[latestWeek];
  const bl = baseline[latestWeek];
  let vsBaseline = null;
  if (bl) vsBaseline = curVal > bl.max ? 'above' : (curVal < bl.min ? 'below' : 'within');

  const latestCounty = {};
  for (const c of COUNTY_ORDER) latestCounty[c] = (countyWk[latestYear][latestWeek] || {})[c] || 0;
  const latestAge = {};
  for (const a of s.ages) latestAge[a] = (ageWk[latestYear][latestWeek] || {})[a] || 0;

  return {
    key: s.key, name: s.name, freq: s.freq, ages: s.ages,
    years, latestYear, latestWeek, series, baseline,
    kpi: {
      value: curVal,
      wow: pct(curVal, prevVal),
      yoy: (yoyVal != null) ? pct(curVal, yoyVal) : null,
      yoyValue: yoyVal != null ? yoyVal : null,
      vsBaseline,
      baselineMed: bl ? bl.med : null,
    },
    latestCounty, latestAge,
  };
}

async function main() {
  let syndromes;
  try {
    syndromes = SYND.map(buildSyndrome);
  } catch (e) {
    console.error('build 失敗（保留既有 apps/TaiwanEpidemic/taiwanepidemic-data.js）:', e.message);
    if (fs.existsSync(OUT)) process.exit(1);
    fs.writeFileSync(OUT, 'window.EPIDEMIC_DATA = ' + JSON.stringify({
      meta: { generatedAt: new Date().toISOString(), fetchError: e.message, title: '傳染病急診監測' },
      syndromes: [],
    }) + ';\n');
    process.exit(1);
  }

  const latestYear = syndromes[0].latestYear, latestWeek = syndromes[0].latestWeek;
  const data = {
    meta: {
      generatedAt: new Date().toISOString(),
      fetchError: null,
      title: '傳染病急診監測',
      latestYear, latestWeek,
      source: '衛生福利部疾病管制署　急診傳染病監測（od.cdc.gov.tw）',
      license: '政府資料開放授權條款-第1版',
      caliber: '數值為急診「就診人次」（實際看診人數），非就診比率；源檔未附急診總人次分母，故不換算比率。跨年比較受各年急診量變動影響。',
      disclaimer: '本站為疫情趨勢監測參考，非醫療診斷依據；確診數與流行研判以疾管署公告為準。',
    },
    countyOrder: COUNTY_ORDER,
    syndromes,
  };
  fs.writeFileSync(OUT, 'window.EPIDEMIC_DATA = ' + JSON.stringify(data) + ';\n');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`→ apps/TaiwanEpidemic/taiwanepidemic-data.js 產出（${kb} KB）最新 ${latestYear}W${latestWeek}，${syndromes.length} 症候群`);
}
main().catch(e => { console.error('build 失敗（保留既有 apps/TaiwanEpidemic/taiwanepidemic-data.js）:', e.message); process.exit(1); });
