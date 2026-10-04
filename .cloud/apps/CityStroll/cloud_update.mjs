#!/usr/bin/env node
/**
 * 城市散步 雲端更新（在 weococreate/Taiwan repo 的 GitHub Actions 跑；本機也可離線測）
 *
 * 做的事：抓文化部「藝文活動-所有類別」JSON → 篩雙北、未過期、60 天內開始 → 合進底稿資料 → 套進頁面模板 → 寫出 CityStroll.html。
 * 底稿（citystroll-base.json：固定場所、配套、行政區輪廓、捷運站）與模板（CityStroll.template.html：已含 GA4／隱私／免責的頁面，
 * 資料位置是 null /*__CITYSTROLL_DATA__*\/ 佔位）由本機 make_base.py 產生後推上來；雲端只讀它們、只寫 CityStroll.html。
 * 零相依，Node 20 以上。
 *
 * 環境變數：SITE_REPO_ROOT（網站 repo 根目錄，預設目前目錄）、CITYSTROLL_EVENTS_FILE（離線測試用：讀本機 JSON 不連網）、GITHUB_OUTPUT。
 * 規則與本機 scripts/build_data.py 的展覽活動段一致；里別在雲端算不出來（村里界圖在本機），留空。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SITE_REPO_ROOT || process.cwd();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE = path.join(HERE, 'citystroll-base.json');
const TEMPLATE = path.join(HERE, 'CityStroll.template.html');
const OUT = path.join(ROOT, 'CityStroll.html');
const URL_EVENTS = 'https://cloud.culture.tw/frontsite/trans/SearchShowAction.do?method=doFindTypeJ&category=all';
const EV_TYPE = { '1': '音樂', '2': '戲劇', '3': '舞蹈', '4': '親子', '5': '獨立音樂', '6': '展覽', '7': '講座', '8': '電影', '11': '綜藝', '13': '競賽', '14': '徵選', '15': '其他', '16': '演唱會', '17': '研習課程', '19': '旅遊', '200': '文化' };
const NEAR_M = 300, HORIZON_DAYS = 60;

const todayTaipei = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const dist = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * 111000, (aLon - bLon) * 111000 * Math.cos(25 * Math.PI / 180));
function inRing(lat, lon, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [yi, xi] = ring[i], [yj, xj] = ring[j]; if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
const townOf = (towns, lat, lon) => towns.find(t => t.rings.some(r => inRing(lat, lon, r))) || null;
const pdate = s => { const m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(String(s || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

async function loadEvents() {
  if (process.env.CITYSTROLL_EVENTS_FILE) return JSON.parse(fs.readFileSync(process.env.CITYSTROLL_EVENTS_FILE, 'utf8').replace(/^﻿/, ''));
  const res = await fetch(URL_EVENTS, { headers: { 'User-Agent': 'Mozilla/5.0 (CityStroll cloud update; github actions)' }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`文化部回 HTTP ${res.status}`);
  const text = (await res.text()).replace(/^﻿/, '');
  const ev = JSON.parse(text);
  if (!Array.isArray(ev) || ev.length < 100 || !('showInfo' in ev[0])) throw new Error('文化部資料格式不對或筆數太少');
  return ev;
}

function buildEvents(raw, base, today) {
  const horizon = addDays(today, HORIZON_DAYS);
  const sup = base.support; const near = (lat, lon) => {
    const found = {}; for (const s of sup) { const d = dist(lat, lon, s[0], s[1]); if (d <= NEAR_M) { const k = s[2]; found[k] = found[k] || { n: 0, nearest_m: 1e9, nearest: '' }; found[k].n++; if (d < found[k].nearest_m) { found[k].nearest_m = Math.round(d); found[k].nearest = s[3]; } } }
    return found;
  };
  const groups = new Map();
  for (const e of raw) for (const sh of e.showInfo || []) {
    const lat = sh.latitude ? Number(sh.latitude) : null, lon = sh.longitude ? Number(sh.longitude) : null;
    if (!lat || !lon || !(lat > 24.6 && lat < 25.4 && lon > 121.2 && lon < 122.1)) continue;
    const st = pdate(sh.time), en = pdate(sh.endTime || sh.time); if (!st || !en) continue;
    const k = `${e.UID}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
    const g = groups.get(k) || { e, lat, lon, start: st, end: en, venue: sh.locationName || '', addr: sh.location || '', price: sh.price || '' };
    if (st < g.start) g.start = st; if (en > g.end) g.end = en; groups.set(k, g);
  }
  const out = []; let seen = 0;
  for (const [k, g] of groups) {
    seen++; if (g.end < today || g.start > horizon) continue;
    const t = townOf(base.towns, g.lat, g.lon); if (!t) continue;
    const e = g.e; let url = (e.sourceWebPromote || e.webSales || '').trim(); if (url && !url.startsWith('http')) url = '';
    out.push({ id: `EV:${e.UID}:${g.lat.toFixed(4)},${g.lon.toFixed(4)}`, src: 'I03', cat: '展覽活動', name: String(e.title || '').trim().slice(0, 60), lat: +g.lat.toFixed(5), lon: +g.lon.toFixed(5), city: t.city, district: t.town, address: g.addr.trim().slice(0, 60), near: near(g.lat, g.lon), vill: '', start: g.start, end: g.end, info: { kind: EV_TYPE[String(e.category)] || '活動', venue: g.venue.slice(0, 40), price: String(g.price || '').trim().slice(0, 60), unit: String(e.showUnit || '').trim().slice(0, 30), url } });
  }
  return { events: out, seen };
}

function assemble(base, events, today) {
  const places = base.places.concat(events);
  const byCat = {}; for (const p of places) byCat[p.cat] = (byCat[p.cat] || 0) + 1;
  const byDist = {}; for (const p of places) { const c = p.city; byDist[c] = byDist[c] || {}; byDist[c][p.district] = (byDist[c][p.district] || 0) + 1; }
  const districts = {}; for (const city of ['臺北市', '新北市']) districts[city] = Object.entries(byDist[city] || {}).sort((a, b) => b[1] - a[1]).map(([district, n]) => ({ district, n }));
  const meta = { ...base.meta, generated: today, places: places.length, by_cat: Object.fromEntries(base.meta.cat_order.filter(c => byCat[c]).map(c => [c, byCat[c]])), districts, cloud_update: today };
  return { meta, towns: base.towns, stations: base.stations, places, support: base.support };
}

function selfCheck(html, events) {
  const must = [['gtag(', 'GA4 追蹤碼'], ['免責', '免責聲明'], ['name="referrer"', 'referrer 標頭'], ['隱私', '隱私聲明']];
  for (const [needle, label] of must) if (!html.includes(needle)) throw new Error(`產物缺 ${label}`);
  const ext = [...html.matchAll(/<script[^>]*src="(https?:[^"]+)"/g)].map(m => m[1]).filter(u => !/googletagmanager\.com/.test(u));
  if (ext.length) throw new Error('產物有不該有的外部 script：' + ext.join(' '));
  if (/__CITYSTROLL_DATA__/.test(html)) throw new Error('佔位沒換掉');
  if (events.length < 30 || events.length > 5000) throw new Error(`活動筆數異常 ${events.length}`);
  if (html.length > 4 * 1024 * 1024) throw new Error('產物超過 4 MB');
}

async function main() {
  const today = todayTaipei();
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes('null /*__CITYSTROLL_DATA__*/')) throw new Error('模板沒有資料佔位');
  const raw = await loadEvents();
  const { events, seen } = buildEvents(raw, base, today);
  const data = assemble(base, events, today);
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  const html = template.replace('null /*__CITYSTROLL_DATA__*/', json);
  selfCheck(html, events);
  const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const strip = s => s.replace(/"generated":"\d{4}-\d{2}-\d{2}"/g, '').replace(/"cloud_update":"\d{4}-\d{2}-\d{2}"/g, '');
  const changed = strip(before) !== strip(html);
  if (changed) fs.writeFileSync(OUT, html);
  console.log(`文化部活動 ${raw.length} 筆、場地組 ${seen}、雙北未過期 60 天內 ${events.length} 筆；地點合計 ${data.places.length}；${changed ? '已寫出 CityStroll.html' : '內容沒變，不寫'}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

main().catch(e => { console.error('✗ 雲端更新失敗：', e.message); process.exit(1); });
