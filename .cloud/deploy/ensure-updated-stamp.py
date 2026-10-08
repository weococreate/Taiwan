#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deploy/ensure-updated-stamp.py — 「資料更新：日期 時間」統一標示（2026-10-07 使用者裁定）

使用者：「做的 app 只要有要定期更新的都要補上日期和時間，才可以知道是否更新了。」
盤點時 108 支定期更新的 app 只有 23 支在畫面上有日期＋時間，37 支只有日期，22 支完全沒有，寫法各頁不同。
比照 deploy/ensure-disclaimer.py：**標示的唯一定義處就是本檔**，不逐頁改樣板。

什麼時候蓋：每次更新成功時由共用流程呼叫——
  · publish-gate.sh 把關通過後（各 app 的 update-*.sh 尾段）
  · update-scheduler.py 跑完一支成功後（涵蓋沒有走 publish-gate 的腳本）
時間＝那次更新成功的時刻（台北時間）。更新失敗或沒網路被擋下時不會蓋，所以頁面上的時間停住＝沒更新。

怎麼蓋：一個不帶任何樣式屬性的段落 `<p data-updated-stamp="weoco" align="right"><small>…</small></p>`。
  · 不用 style 屬性也不加 <style>：有些頁的內容安全政策只放行特定雜湊的樣式（HomeScout、遊戲站），加了會被擋。
  · 位置：預設放在 <body> 開頭（一打開就看得到）。body 本身是 flex／grid 版面的頁，多一個子元素會破版，改放在 </body> 前。
  · 冪等：已有標示就原地換掉時間，永不重複。
  · 沒寫 <body> 標籤的頁接在文件最後；連網頁都不像的檔直接非零退出，不靜默略過。

用法：
  python3 deploy/ensure-updated-stamp.py apps/X/X.html                    # 蓋現在時間
  python3 deploy/ensure-updated-stamp.py --time "2026-10-06 19:37" a.html  # 指定時間（補登用）
  python3 deploy/ensure-updated-stamp.py --check a.html b.html             # 只檢查，缺則 exit 1
  python3 deploy/ensure-updated-stamp.py --read a.html                     # 印出頁面上目前的時間
"""
import datetime as dt
import re
import sys

MARK = 'data-updated-stamp="weoco"'
TPE = dt.timezone(dt.timedelta(hours=8))
BLOCK_RE = re.compile(r'<p data-updated-stamp="weoco"[^>]*>.*?</p>', re.S)   # 只拿掉標示本身，不動前後換行（重蓋才會一字不差）
TIME_RE = re.compile(r'data-updated-stamp="weoco"[^>]*><small>資料更新：(\d{4}-\d{2}-\d{2} \d{2}:\d{2})')
BODY_OPEN = re.compile(r'<body\b[^>]*>', re.I)
# body 自己是 flex／grid 容器：開頭多一個子元素會變成一欄或一格，改放頁尾
BODY_LAYOUT = re.compile(r'(?:^|[\s,}>;])(?:html\s*,\s*)?body\s*(?:,[^{]*)?\{[^}]*display\s*:\s*(?:inline-)?(?:flex|grid)', re.I)


def block(when):
    return f'<p {MARK} align="right"><small>資料更新：{when}（台北時間）</small></p>'


def now_text():
    return dt.datetime.now(TPE).strftime('%Y-%m-%d %H:%M')


def read_stamp(html):
    m = TIME_RE.search(html)
    return m.group(1) if m else None


def apply(html, when):
    """回傳蓋好的 html。"""
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}', when):
        raise ValueError('時間格式要是 YYYY-MM-DD HH:MM：' + when)
    html = BLOCK_RE.sub('', html) if MARK in html else html
    if BODY_LAYOUT.search(html):
        i = html.lower().rfind('</body>')
        if i < 0:
            raise ValueError('找不到 </body>')
        return html[:i] + block(when) + html[i:]
    m = BODY_OPEN.search(html)
    if not m:
        # 沒寫 <body> 標籤的頁（合法的 HTML，BankObserve、Banking 是這樣）：有 </body> 就放它前面，沒有就接在文件最後
        if '<html' not in html.lower() and '<meta' not in html.lower() and '<title' not in html.lower():
            raise ValueError('看起來不是網頁')
        i = html.lower().rfind('</body>')
        if i >= 0:
            return html[:i] + block(when) + html[i:]
        return html + block(when)
    return html[:m.end()] + block(when) + html[m.end():]


def stamp_file(path, when=None):
    with open(path, encoding='utf-8') as f:
        html = f.read()
    out = apply(html, when or now_text())
    if out != html:
        if len(out) < len(html) - 400:
            raise ValueError('蓋完反而變短很多，中止不寫')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(out)
    return read_stamp(out)


def main(argv):
    when, check, read = None, False, False
    files = []
    it = iter(argv)
    for a in it:
        if a == '--time':
            when = next(it)
        elif a == '--check':
            check = True
        elif a == '--read':
            read = True
        else:
            files.append(a)
    if not files:
        print(__doc__.strip().split('\n')[0])
        return 2
    bad = 0
    for p in files:
        try:
            if check or read:
                with open(p, encoding='utf-8') as f:
                    t = read_stamp(f.read())
                print(f'{p}：{t or "沒有更新時間標示"}')
                bad += 0 if t else 1
            else:
                print(f'  ✓ {p} 資料更新 {stamp_file(p, when)}')
        except (OSError, ValueError) as e:
            print(f'  ❌ {p}：{e}', file=sys.stderr)
            bad += 1
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
