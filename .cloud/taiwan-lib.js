#!/usr/bin/env node
/*
 * taiwan-lib.js — 台灣資料 app 共用函式庫（TaiwanOS Phase 3）
 *
 * 七件套：normalizeCounty（台/臺＋縣市名正規化）、rocDate（民國年↔西元＋月鍵比較）、
 *         decodeBig5（Big5/CP950 → UTF-8，殼 iconv）、toHalfWidth（全形→半形）、
 *         maskPerson（自然人姓名遮罩）、mergeHistory（只增不減＋近期覆寫收斂）、
 *         loadPopDenominator（人口分母標準件，TaiwanFusion P2-1）。
 *
 * 原則（計劃書 §5）：新 build 引用本庫；舊 build 遇修改時順手收編，不強制回頭大改。
 * 各函式皆取自既有 build 的實戰版本（出處註記於各函式），非重新發明。
 * 自我測試：node taiwan-lib.js --selftest（改本檔必跑；run-tests --fast 亦掛）。
 */
"use strict";

const { execFileSync } = require("child_process");

/* ── 1. 縣市正規化（出處：apps/TaiwanCrime/build-taiwancrime.js 等 22 縣市 app 慣例） ── */
const COUNTY_CANON = [
  "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
  "基隆市", "新竹市", "嘉義市", "新竹縣", "苗栗縣", "彰化縣",
  "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣",
  "臺東縣", "澎湖縣", "金門縣", "連江縣",
];
const COUNTY_SET = new Set(COUNTY_CANON);

/** 「台北市」「臺北市政府」「台東」→「臺北市」「臺北市」「臺東縣」；比不出回傳 null。 */
function normalizeCounty(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/台/g, "臺").replace(/\s+/g, "");
  const m = s.match(/^(臺北|新北|桃園|臺中|臺南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|臺東|澎湖|金門|連江)(市|縣)?/);
  if (!m) return null;
  if (m[2]) {
    const full = m[1] + m[2];
    return COUNTY_SET.has(full) ? full : null;
  }
  // 未帶市/縣：唯一者補綴（新竹/嘉義同名雙轄比不出，回 null 要求呼叫端帶全名）
  const cands = COUNTY_CANON.filter((c) => c.startsWith(m[1]));
  return cands.length === 1 ? cands[0] : null;
}

/* ── 2. 民國年（出處：apps/TaiwanTax/build-taiwantax.js cmpMonthKey——2/3 位民國年不可字串排序） ── */
const rocDate = {
  /** 民國年 → 西元年（113 → 2024）。 */
  toAD(rocYear) { return Number(rocYear) + 1911; },
  /** 西元年 → 民國年。 */
  toROC(adYear) { return Number(adYear) - 1911; },
  /** 「113年 6月」「113/06」「113-6」→ 正規月鍵 "113-06"；解析不出回 null。 */
  monthKey(s) {
    const m = String(s || "").match(/(\d{2,3})\s*[-/年]\s*(\d{1,2})/);
    if (!m) return null;
    return `${+m[1]}-${String(+m[2]).padStart(2, "0")}`;
  },
  /** 月鍵比較（數值序）："99-12" < "115-05"（字串序會反過來——已踩過的真 bug）。 */
  cmpMonthKey(a, b) {
    const [ay, am] = a.split("-").map(Number);
    const [by, bm] = b.split("-").map(Number);
    return ay - by || am - bm;
  },
  /** 8 碼民國日期 "1130621"/"01130621" → "113-06-21"；解析不出回 null。 */
  dateKey(s) {
    const m = String(s || "").replace(/^0+/, "").match(/^(\d{2,3})(\d{2})(\d{2})$/);
    if (!m) return null;
    return `${+m[1]}-${m[2]}-${m[3]}`;
  },
};

/* ── 3. Big5/CP950 解碼（出處：apps/TaiwanTrade/build-taiwantrade.js——Node 無內建 big5，殼 iconv） ── */
function decodeBig5(buf) {
  return execFileSync("iconv", ["-f", "BIG5", "-t", "UTF-8//TRANSLIT"],
    { input: buf, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
}

/* ── 4. 全形→半形（出處：taiwannutrition per100g trim／lvr 半形門牌慣例） ── */
function toHalfWidth(s) {
  return String(s == null ? "" : s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/ /g, " ");
}

/* ── 5. 自然人姓名遮罩（出處：apps/TaiwanLabor/build-taiwanlabor.js maskPerson，legal 審查通過版） ── */
const ORG_SUFFIX = /(公司|商行|企業社|工作室|事務所|工程行|商號|農場|協會|基金會|工廠|商店|補習班|幼兒園|診所|藥局|醫院|大學|學校)/;
function maskPerson(name) {
  if (!name || ORG_SUFFIX.test(name)) return name;
  if (/^[一-鿿]{2,4}$/.test(name)) { // 純中文 2-4 字，疑似自然人姓名
    if (name.length === 2) return name[0] + "○";
    return name[0] + "○".repeat(name.length - 2) + name[name.length - 1];
  }
  return name;
}

/* ── 6. history merge（出處：taiwanfuel 只增不減＋taiwanagri 近期覆寫收斂） ── */
/**
 * mergeHistory(oldRows, newRows, keyFn, {overwriteRecent})
 *  · 只增不減：舊列永不刪除；同 key 預設保留舊值（冪等）。
 *  · overwriteRecent（taiwanagri 模式）：keyFn 相同時以新列覆寫——供「快照含近 N 日
 *    暫定值、後續收斂為終值」的來源；預設 false。
 *  · 回傳 { rows, added, overwritten }；rows 依 key 穩定排序。
 *  · 保險絲：merge 結果列數 < 舊列數即 throw（只增不減鐵則，防意外洗史）。
 */
function mergeHistory(oldRows, newRows, keyFn, opts = {}) {
  const overwriteRecent = !!opts.overwriteRecent;
  const map = new Map();
  const oldCount = (oldRows || []).length;
  for (const r of oldRows || []) map.set(keyFn(r), r);
  if (map.size < oldCount) throw new Error(`mergeHistory：keyFn 使舊列 ${oldCount} 縮成 ${map.size}（鍵碰撞，只增不減違反）`);
  let added = 0, overwritten = 0;
  for (const r of newRows || []) {
    const k = keyFn(r);
    if (!map.has(k)) { map.set(k, r); added++; }
    else if (overwriteRecent) {
      const prev = map.get(k);
      if (JSON.stringify(prev) !== JSON.stringify(r)) { map.set(k, r); overwritten++; }
    }
  }
  if (map.size < oldCount) throw new Error(`mergeHistory：結果 ${map.size} < 舊列 ${oldCount}（只增不減違反）`);
  const rows = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
  return { rows, added, overwritten };
}

/* ── 7. 人口分母標準件（TaiwanFusion P2-1；出處：build-taiwanwelfare/cram/medmap 三站借用模式收編） ── */
/**
 * loadPopDenominator(dir?)
 *  · 讀本地 apps/TaiwanPop/taiwanpop-data.js（TaiwanPop 管線產物，window.POP_DATA），回傳
 *    { national: {pop, year}, counties: {縣市→{pop, aging, year}}, year, source }。
 *  · 縣市鍵已過 normalizeCounty；縣市數 <20 即 throw（分母不完整不准用）。
 *  · 檔案不存在回傳 null（呼叫端自行決定省略比率章——失敗容忍慣例）。
 */
function loadPopDenominator(dir) {
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const file = path.join(dir || __dirname, "apps/TaiwanPop/taiwanpop-data.js");
  if (!fs.existsSync(file)) return null;
  const g = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), g);
  const pop = g.window.POP_DATA;
  if (!pop || !pop.counties) throw new Error("apps/TaiwanPop/taiwanpop-data.js 結構異常：無 counties");
  const counties = {}; let year = 0;
  for (const [county, v] of Object.entries(pop.counties)) {
    const key = normalizeCounty(county);
    const last = v.annual && v.annual[v.annual.length - 1];
    if (!key || !last || !last.pop) continue;
    // aging 為物件 {agingIndex, dependency, ym…}（TaiwanPop 產物實測 07-25）
    counties[key] = { pop: last.pop, aging: v.aging && v.aging.agingIndex != null ? v.aging.agingIndex : null, year: last.y };
    year = Math.max(year, last.y);
  }
  if (Object.keys(counties).length < 20) throw new Error("loadPopDenominator：縣市數不足 " + Object.keys(counties).length);
  const natLast = (pop.national && pop.national.annual || []).slice(-1)[0] || null;
  return {
    national: natLast ? { pop: natLast.pop, year: natLast.y } : null,
    counties, year,
    source: "內政部戶籍登記人口（內政統計月報）",
  };
}

/* ── selftest ── */
function selftest() {
  const assert = require("assert");
  let n = 0;
  const t = (name, fn) => { fn(); n++; console.log("PASS  " + name); };

  t("normalizeCounty：台/臺＋補綴＋雙轄擋下", () => {
    assert.strictEqual(normalizeCounty("台北市"), "臺北市");
    assert.strictEqual(normalizeCounty("臺北市政府警察局"), "臺北市");
    assert.strictEqual(normalizeCounty("台東"), "臺東縣");
    assert.strictEqual(normalizeCounty("新竹"), null); // 縣市雙轄，不猜
    assert.strictEqual(normalizeCounty("嘉義"), null);
    assert.strictEqual(normalizeCounty("東京都"), null);
  });
  t("rocDate：月鍵解析＋數值比較（99-12 < 115-05）", () => {
    assert.strictEqual(rocDate.monthKey("113年 6月"), "113-06");
    assert.strictEqual(rocDate.monthKey("99/12"), "99-12");
    assert.ok(rocDate.cmpMonthKey("99-12", "115-05") < 0); // 字串序是 >，數值序才對
    assert.strictEqual(rocDate.toAD(113), 2024);
    assert.strictEqual(rocDate.dateKey("1130621"), "113-06-21");
  });
  t("decodeBig5：iconv 往返（UTF-8→Big5→UTF-8）", () => {
    const big5 = execFileSync("iconv", ["-f", "UTF-8", "-t", "BIG5"], { input: Buffer.from("台灣傳染病統計") });
    assert.strictEqual(decodeBig5(big5), "台灣傳染病統計");
  });
  t("toHalfWidth：全形數字/括號/空白", () => {
    assert.strictEqual(toHalfWidth("１２３（ＡＢ）　Ｘ"), "123(AB) X");
  });
  t("maskPerson：自然人遮、法人不遮", () => {
    assert.strictEqual(maskPerson("王小明"), "王○明");
    assert.strictEqual(maskPerson("陳大"), "陳○");
    assert.strictEqual(maskPerson("歐陽大明"), "歐○○明");
    assert.strictEqual(maskPerson("王小明企業社"), "王小明企業社");
  });
  t("mergeHistory：只增不減＋冪等＋覆寫收斂＋保險絲", () => {
    const old = [{ d: "01", v: 1 }, { d: "02", v: 2 }];
    const r1 = mergeHistory(old, [{ d: "02", v: 99 }, { d: "03", v: 3 }], (r) => r.d);
    assert.strictEqual(r1.rows.length, 3);
    assert.strictEqual(r1.rows[1].v, 2); // 預設不覆寫（冪等）
    const r2 = mergeHistory(old, [{ d: "02", v: 99 }], (r) => r.d, { overwriteRecent: true });
    assert.strictEqual(r2.rows[1].v, 99); // 收斂模式覆寫
    assert.strictEqual(r2.overwritten, 1);
    assert.throws(() => { // 注錯對抗：偽造 map 縮水必炸
      mergeHistory(old, [], () => "同鍵");
    }, /只增不減/);
  });
  t("loadPopDenominator：縣市≥20＋分母>0＋缺檔回 null＋壞檔必炸", () => {
    const d = loadPopDenominator();
    if (d === null) { console.log("      （本目錄無 apps/TaiwanPop/taiwanpop-data.js，僅驗缺檔路徑）"); }
    else {
      assert.ok(Object.keys(d.counties).length >= 20);
      assert.ok(d.counties["臺北市"].pop > 1000000);
      assert.ok(d.national.pop > 20000000);
      assert.ok(d.counties["臺北市"].aging > 0); // 老化指數存在性（勿寫死浮動值）
    }
    assert.strictEqual(loadPopDenominator("/nonexistent-dir"), null); // 缺檔容忍
    const fs = require("fs"), os = require("os"), path = require("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tlib-"));
    fs.mkdirSync(path.join(tmp, "apps/TaiwanPop"), { recursive: true });  // 2026-09-26 taiwanpop 搬進 apps/
    fs.writeFileSync(path.join(tmp, "apps/TaiwanPop/taiwanpop-data.js"), "window.POP_DATA = {counties:{}};");
    assert.throws(() => loadPopDenominator(tmp), /縣市數不足/); // 注錯對抗：空 counties 必炸
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  console.log(`selftest 全過（${n} 組）`);
}

if (require.main === module && process.argv.includes("--selftest")) selftest();

module.exports = { normalizeCounty, COUNTY_CANON, rocDate, decodeBig5, toHalfWidth, maskPerson, mergeHistory, loadPopDenominator };
