#!/usr/bin/env node
/** apps/TaiwanEpidemic/build-taiwanepidemic-deploy.js — 打包 apps/TaiwanEpidemic/TaiwanEpidemic1.html → 單一自足 apps/TaiwanEpidemic/TaiwanEpidemic.html
 *  內嵌所有 vendor/* 與 apps/TaiwanEpidemic/taiwanepidemic-data.js，產物零外部相依，可 file:// 直開/手動上傳。
 *  用共用庫 deploy-lib.js（2026-07-13 起）：錨點雙檢查、</script> 轉義、自足性把關內建。 */
const { R, inlineVendors, markers, writeOut } = require('../../deploy-lib.js');
let html = R('apps/TaiwanEpidemic/TaiwanEpidemic1.html');
html = inlineVendors(html);
html = markers(html, R('apps/TaiwanEpidemic/taiwanepidemic-data.js'));
writeOut('apps/TaiwanEpidemic/TaiwanEpidemic.html', html, { forbid: 'taiwanepidemic-data.js?t=' });
