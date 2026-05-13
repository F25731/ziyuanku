#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云逸蓝奏 资源库 API · 调用示例 / 交互测试脚本
================================================

用法：
  1) pip install requests
  2) 通过环境变量或命令行参数提供 HOST 和 API_KEY
  3) python test_api.py             # 进入交互菜单
     python test_api.py me
     python test_api.py search python
     python test_api.py detail 17
     python test_api.py link 17
     python test_api.py batch 5     # 批量解析前 5 条

配置方式（二选一）：

  A. 环境变量
     Windows PowerShell:
       $env:LRH_HOST = "https://ku.hstudy.xyz"
       $env:LRH_API_KEY = "lhk_xxxxxxxx"
     Linux / macOS:
       export LRH_HOST=https://ku.hstudy.xyz
       export LRH_API_KEY=lhk_xxxxxxxx

  B. 直接改下面 HOST / API_KEY 的默认值
"""

import os
import sys
import json
import time

try:
    import requests
except ImportError:
    print("请先安装 requests 库：")
    print("  pip install requests")
    sys.exit(1)

# ================= 配置 =================
HOST = os.environ.get("LRH_HOST", "https://ku.hstudy.xyz")
API_KEY = os.environ.get("LRH_API_KEY", "lhk_paste_your_key_here")
TIMEOUT = 30
# ========================================


def pretty(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)


def req(method, path, **kwargs):
    url = HOST.rstrip("/") + path
    headers = {"X-Api-Key": API_KEY, "Accept": "application/json"}
    try:
        r = requests.request(method, url, headers=headers, timeout=TIMEOUT, **kwargs)
    except requests.RequestException as e:
        print(f"[网络错误] {e}")
        return None
    try:
        body = r.json()
    except Exception:
        body = r.text
    return {"status": r.status_code, "body": body}


def truncate(s, n):
    s = str(s or "")
    return (s[: n - 1] + "…") if len(s) > n else s


# ---------------- actions ----------------

def action_me():
    print("\n>>> GET /api/v1/me")
    d = req("GET", "/api/v1/me")
    if d:
        print(pretty(d))


def action_search(q=None, page=1, page_size=10):
    if q is None:
        q = input("搜索关键词（回车 = 列出全部）: ").strip()
    print(f"\n>>> GET /api/v1/search?q={q!r}&page={page}&pageSize={page_size}")
    d = req("GET", "/api/v1/search", params={"q": q, "page": page, "pageSize": page_size})
    if not d:
        return
    if d["status"] == 200 and isinstance(d["body"], dict):
        b = d["body"]
        total = b.get("total", 0)
        items = b.get("items", [])
        print(f"共 {total} 条，本次返回 {len(items)} 条：\n")
        print(f"  {'ID':<6} {'文件名':<42} {'大小':<10} {'来源':<16}")
        print(f"  {'-'*6} {'-'*42} {'-'*10} {'-'*16}")
        for it in items:
            print(f"  {it['id']:<6} "
                  f"{truncate(it.get('file_name'), 42):<42} "
                  f"{truncate(it.get('file_size'), 10):<10} "
                  f"{truncate(it.get('source'), 16):<16}")
    else:
        print(pretty(d))


def action_detail(rid=None):
    if rid is None:
        rid = input("资源 ID: ").strip()
    print(f"\n>>> GET /api/v1/resources/{rid}")
    d = req("GET", f"/api/v1/resources/{rid}")
    if d:
        print(pretty(d))


def action_link(rid=None, verify_download=True):
    if rid is None:
        rid = input("资源 ID: ").strip()
    print(f"\n>>> GET /api/v1/resources/{rid}/link")
    t0 = time.time()
    d = req("GET", f"/api/v1/resources/{rid}/link")
    if not d:
        return
    cost = (time.time() - t0) * 1000
    print(pretty(d))
    print(f"\n接口耗时: {cost:.0f}ms")

    b = d.get("body") or {}
    url = b.get("url") if isinstance(b, dict) else None
    if url and verify_download:
        print(f"\n>>> 验证直链是否可下载")
        try:
            rr = requests.get(url, stream=True, allow_redirects=True, timeout=15)
            size = rr.headers.get("content-length", "?")
            ctype = rr.headers.get("content-type", "?")
            print(f"  HTTP {rr.status_code}")
            print(f"  Content-Type: {ctype}")
            print(f"  Content-Length: {size}")
            print(f"  Final URL: {truncate(rr.url, 100)}")
            # 读 1KB 验证流真的可用
            chunk = next(rr.iter_content(1024), None)
            if chunk:
                print(f"  已读取首个 {len(chunk)} 字节，直链可用 ✓")
            rr.close()
        except requests.RequestException as e:
            print(f"  下载验证失败: {e}")


def action_batch(n=None):
    if n is None:
        s = input("批量解析前几条（默认 5）: ").strip()
        n = int(s) if s else 5
    print(f"\n>>> 取前 {n} 条然后逐个解析直链")
    d = req("GET", "/api/v1/search", params={"q": "", "page": 1, "pageSize": n})
    if not d or d["status"] != 200:
        print("取列表失败")
        print(pretty(d) if d else "")
        return
    items = d["body"].get("items", [])
    print(f"共 {len(items)} 条待解析\n")

    success, failed, total_ms = 0, 0, 0
    for it in items:
        t0 = time.time()
        r = req("GET", f"/api/v1/resources/{it['id']}/link")
        cost = (time.time() - t0) * 1000
        total_ms += cost
        if r and r["status"] == 200 and isinstance(r["body"], dict):
            url = r["body"].get("url", "")
            cached = r["body"].get("cached", False)
            tag = "[缓存]" if cached else ""
            print(f"  ✓ #{it['id']:<5} {truncate(it.get('file_name'), 32):<34} "
                  f"{cost:>6.0f}ms {tag} {truncate(url, 55)}")
            success += 1
        else:
            msg = ""
            if r and isinstance(r["body"], dict):
                msg = r["body"].get("message", "") + " " + r["body"].get("detail", "")
            elif r:
                msg = str(r["body"])[:80]
            print(f"  ✗ #{it['id']:<5} {truncate(it.get('file_name'), 32):<34} "
                  f"{cost:>6.0f}ms  {truncate(msg, 60)}")
            failed += 1
        # 客户端节流，避免在服务端限流之外再触发蓝奏侧 IP 限流
        time.sleep(0.5)

    print(f"\n汇总: 成功 {success}  失败 {failed}  总计 {len(items)}  "
          f"平均耗时 {total_ms / max(1, len(items)):.0f}ms")


# ---------------- entry ----------------

def menu():
    while True:
        print("\n========== 云逸蓝奏 API 测试 ==========")
        print(f"HOST: {HOST}")
        print(f"KEY:  {API_KEY[:12] + '…' if len(API_KEY) > 12 else API_KEY}")
        print("--------------------------------------")
        print(" 1) 查看自己 Key 配额     GET /api/v1/me")
        print(" 2) 搜索资源            GET /api/v1/search?q=")
        print(" 3) 查看资源详情         GET /api/v1/resources/:id")
        print(" 4) 获取直链+验证下载    GET /api/v1/resources/:id/link")
        print(" 5) 批量解析前 N 条")
        print(" 0) 退出")
        try:
            choice = input("请选择: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if choice == "1":   action_me()
        elif choice == "2": action_search()
        elif choice == "3": action_detail()
        elif choice == "4": action_link()
        elif choice == "5": action_batch()
        elif choice == "0": break
        else: print("无效选择")


def main():
    if API_KEY == "lhk_paste_your_key_here" and "LRH_API_KEY" not in os.environ:
        print("=" * 60)
        print("  请先配置 API_KEY！")
        print()
        print("  方式 A: 编辑本文件顶部的 HOST / API_KEY")
        print()
        print("  方式 B: 环境变量")
        print("    Windows PowerShell:")
        print('      $env:LRH_HOST = "https://ku.hstudy.xyz"')
        print('      $env:LRH_API_KEY = "lhk_xxxxxxxx"')
        print("    Linux / macOS:")
        print('      export LRH_HOST=https://ku.hstudy.xyz')
        print('      export LRH_API_KEY=lhk_xxxxxxxx')
        print("=" * 60)
        sys.exit(1)

    if len(sys.argv) < 2:
        menu()
        return

    cmd = sys.argv[1]
    args = sys.argv[2:]
    if   cmd == "me":     action_me()
    elif cmd == "search": action_search(q=(args[0] if args else ""))
    elif cmd == "detail": action_detail(rid=args[0] if args else None)
    elif cmd == "link":   action_link(rid=args[0] if args else None)
    elif cmd == "batch":  action_batch(n=int(args[0]) if args else 5)
    else:
        print(f"未知命令: {cmd}")
        print("支持: me, search <kw>, detail <id>, link <id>, batch <n>")


if __name__ == "__main__":
    main()
