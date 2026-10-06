#!/usr/bin/env node
/**
 * TaiwanData 三支日更／週更頁的雲端更新（2026-10-06 使用者裁定；AutoDeploy 計劃書 #taiwandata-publish-scope）。
 * 在網站 repo（weococreate/Taiwan）的 GitHub Actions 內執行，放在 .cloud/cloud_update_taiwandata.mjs。
 *
 * .cloud/ 的資料夾長得和本機專案根目錄一樣（apps/<名稱>/、vendor/、deploy/、deploy-lib.js、taiwan-lib.js），
 * 所以各支的 build-*.js 原封不動就能跑，不必為雲端另寫一份。
 *
 * 每支依序：抓資料並重算 → 打包成單一網頁 → 補 GA4／免責／隱私 → 檢查 → 和線上那份不同才寫到 repo 根目錄。
 * 任一步失敗：那一支不寫、累積歷史檔還原成執行前的樣子，其他支照常；結果一律記進 .cloud/status/taiwandata.json。
 * 雲端沒有上一輪的原始檔可退，來源抓不到就是失敗，不會拿舊資料冒充新資料。
 *
 * 本檔只輸出「要提交哪些檔」，提交與發布由工作流程做。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLOUD = path.dirname(fileURLToPath(import.meta.url));          // .cloud/
const SITE = process.env.SITE_REPO_ROOT || path.dirname(CLOUD);       // repo 根目錄（對外網頁所在）
const EVENT = process.env.CLOUD_EVENT || 'manual';                   // schedule／push／workflow_dispatch
const STATUS = path.join(CLOUD, 'status', 'taiwandata.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const APPS = [
  { id: 'TaiwanAlerts', dataVar: 'ALERTS_DATA', minBytes: 100_000 },
  { id: 'TaiwanWater', dataVar: 'WATER_DATA', minBytes: 200_000,
    // 只增不減的累積歷史：雲端是唯一寫入者，每輪跟著網頁一起提交；變小就當失敗並還原。
    state: ['taiwanwater-history.json', 'taiwanwater-gw-history.json', 'taiwanwater-river-history.json'] },
  { id: 'TaiwanEpidemic', dataVar: 'EPIDEMIC_DATA', minBytes: 100_000,
    scheduleWeekday: 2,            // 排程時只在台北時間週二跑（週更）；手動或推送程式時照跑
    prefetch: fetchEpidemic },
];

const taipei = () => new Date(Date.now() + 8 * 3600e3);
const nowTaipei = () => taipei().toISOString().replace('Z', '+08:00').slice(0, 19) + '+08:00';
const run = (cmd, args, opt = {}) => execFileSync(cmd, args, { cwd: CLOUD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000, ...opt });
const tail = (s, n = 400) => String(s || '').trim().slice(-n);

/** 疾管署 od.cdc.gov.tw 送出的憑證鏈缺中介憑證，要用「系統憑證＋已存的 TWCA 中介憑證」才能安全下載（同本機 update 腳本）。 */
function fetchEpidemic(appDir) {
  const raw = path.join(appDir, 'taiwanepidemic-raw');
  const sys = ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem'].find(f => fs.existsSync(f));
  if (!sys) throw new Error('找不到系統憑證檔');
  const bundle = path.join(raw, 'ca-bundle.pem');
  fs.writeFileSync(bundle, fs.readFileSync(sys, 'utf8') + '\n' + fs.readFileSync(path.join(raw, 'twca-ssl-intermediate.pem'), 'utf8'));
  const files = [
    ['RODS_Influenza_like_illness.csv', 'ili.csv'], ['RODS_EnteroviralInfection.csv', 'entero.csv'],
    ['RODS_AcuteDiarrhea.csv', 'diarrhea.csv'], ['RODS_AcuteHemorrhagicConjunctivitis.csv', 'conjunctivitis.csv'],
    ['RODS_Herpangina.csv', 'herpangina.csv'],
  ];
  for (const [src, dst] of files) {
    const out = path.join(raw, dst);
    run('curl', ['-fsS', '--retry', '2', '--max-time', '120', '--cacert', bundle, '-A', UA, '-o', out, `https://od.cdc.gov.tw/eic/${src}`]);
    const head = fs.readFileSync(out, 'utf8').slice(0, 300);
    if (!head.includes('就診人次')) throw new Error(`${dst} 內容不是預期的 CSV`);
  }
}

function checkPage(html, app, publishedSize) {
  const must = [['gtag(', 'GA4 追蹤碼'], ['與 Claude Code', '免責聲明（Taiwan 站文字）'], ['name="referrer"', 'referrer 標頭'], ['隱私', '隱私聲明'], [`window.${app.dataVar}`, '內嵌資料']];
  for (const [needle, label] of must) if (!html.includes(needle)) throw new Error(`產物缺 ${label}`);
  const ext = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).filter(u => !/^https:\/\/www\.googletagmanager\.com\//.test(u));
  if (ext.length) throw new Error('產物有不該有的 script 來源：' + ext.join(' '));
  if (/\/Users\/|\/home\/runner|\.cloud\//.test(html)) throw new Error('產物含本機或雲端機器的路徑');
  const size = Buffer.byteLength(html);
  if (size < app.minBytes) throw new Error(`產物只有 ${size} bytes，小於下限 ${app.minBytes}`);
  if (size > 4 * 1024 * 1024) throw new Error('產物超過 4 MB');
  if (publishedSize && size < publishedSize * 0.6) throw new Error(`產物比線上那份小四成以上（${size} vs ${publishedSize}），疑似資料缺一塊`);
}

function updateOne(app) {
  const low = app.id.toLowerCase();
  const appDir = path.join(CLOUD, 'apps', app.id);
  const outLocal = path.join(appDir, `${app.id}.html`);
  const published = path.join(SITE, `${app.id}.html`);
  fs.mkdirSync(path.join(appDir, `${low}-raw`), { recursive: true });
  const stateFiles = (app.state || []).map(f => path.join(appDir, f));
  const before = stateFiles.map(f => (fs.existsSync(f) ? fs.readFileSync(f) : null));
  try {
    if (app.prefetch) app.prefetch(appDir);
    const log = run('node', [`apps/${app.id}/build-${low}.js`]);
    run('node', [`apps/${app.id}/build-${low}-deploy.js`]);
    run('python3', ['deploy/ensure-ga4.py', outLocal]);
    run('python3', ['deploy/ensure-disclaimer.py', outLocal], { env: { ...process.env, DISCLAIMER_SITE: 'Taiwan' } });
    run('python3', ['deploy/ensure-privacy.py', outLocal]);
    const html = fs.readFileSync(outLocal, 'utf8');
    checkPage(html, app, fs.existsSync(published) ? fs.statSync(published).size : 0);
    stateFiles.forEach((f, i) => {
      const now = fs.existsSync(f) ? fs.statSync(f).size : 0;
      if (before[i] && now < before[i].length * 0.98) throw new Error(`${path.basename(f)} 變小了（${before[i].length} → ${now}），累積歷史不該減少`);
    });
    const changed = !fs.existsSync(published) || fs.readFileSync(published, 'utf8') !== html;
    if (changed) fs.writeFileSync(published, html);
    const files = (changed ? [`${app.id}.html`] : []).concat(stateFiles.filter((f, i) => !before[i] || !before[i].equals(fs.readFileSync(f))).map(f => path.relative(SITE, f)));
    return { ok: true, changed, bytes: Buffer.byteLength(html), note: tail(log, 300), files };
  } catch (e) {
    // 失敗：累積歷史還原成執行前的樣子，網頁不動。
    stateFiles.forEach((f, i) => { if (before[i]) fs.writeFileSync(f, before[i]); else if (fs.existsSync(f)) fs.rmSync(f); });
    return { ok: false, changed: false, error: tail(e.message + '\n' + (e.stderr || '') + '\n' + (e.stdout || ''), 900), files: [] };
  }
}

function main() {
  const prev = fs.existsSync(STATUS) ? JSON.parse(fs.readFileSync(STATUS, 'utf8')) : { apps: {} };
  const status = { _note: 'TaiwanData 雲端更新最近一次的結果（每支一筆；ok=false 表示那一支這輪沒更新，網頁維持上一版）。', event: EVENT, ranAt: nowTaipei(), apps: { ...prev.apps } };
  const files = [];
  let failed = 0;
  for (const app of APPS) {
    if (EVENT === 'schedule' && app.scheduleWeekday != null && taipei().getUTCDay() !== app.scheduleWeekday) {
      console.log(`- ${app.id}：今天不是排定的更新日，略過`);
      continue;
    }
    const r = updateOne(app);
    files.push(...r.files);
    status.apps[app.id] = { ok: r.ok, at: nowTaipei(), changed: r.changed, ...(r.ok ? { bytes: r.bytes, note: r.note } : { error: r.error }),
      lastOkAt: r.ok ? nowTaipei() : (prev.apps[app.id] && prev.apps[app.id].lastOkAt) || null };
    if (r.ok) console.log(`✓ ${app.id}：${r.changed ? '已更新' : '內容沒變'}（${r.bytes} bytes）`);
    else { failed++; console.log(`::error title=${app.id} 雲端更新失敗::${r.error.replace(/\r?\n/g, ' ｜ ').slice(0, 600)}`); }
  }
  fs.mkdirSync(path.dirname(STATUS), { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 1) + '\n');
  files.push(path.relative(SITE, STATUS));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `files=${files.join(' ')}\nfailed=${failed}\n`);
  console.log(`完成：${APPS.length} 支中失敗 ${failed} 支；要提交 ${files.length} 個檔`);
}

main();
