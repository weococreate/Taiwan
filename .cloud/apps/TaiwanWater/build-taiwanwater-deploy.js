#!/usr/bin/env node
/** apps/TaiwanWater/build-taiwanwater-deploy.js — 打包 apps/TaiwanWater/TaiwanWater1.html → 單一自足 apps/TaiwanWater/TaiwanWater.html
 *  內嵌所有 vendor/* 與 apps/TaiwanWater/taiwanwater-data.js，產物零外部相依，可 file:// 直開/手動上傳。
 *  用共用庫 deploy-lib.js（2026-07-13 起）：錨點雙檢查、</script> 轉義、自足性把關內建。 */
const { R, inlineVendors, markers, writeOut } = require('../../deploy-lib.js');
let html = R('apps/TaiwanWater/TaiwanWater1.html');
html = inlineVendors(html);
html = markers(html, R('apps/TaiwanWater/taiwanwater-data.js'));
writeOut('apps/TaiwanWater/TaiwanWater.html', html, { forbid: 'taiwanwater-data.js?t=' });
