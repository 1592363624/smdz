# -*- coding: utf-8 -*-
"""临时调试脚本：验证「图鉴 X」指令的 REST 返回结构。

用于定位前端悬浮图鉴弹层显示不出内容的问题：
- 后端 POST /api/commands/execute 返回 { success, data: CommandResult }
- axios 响应拦截器已 return res.data（剥掉外层），前端拿到的 res 就是 CommandResult 本体
- 前端代码取 res?.data?.content（会 undefined）→ 回退 res?.content
本脚本打印真实返回的完整结构，确认到底该取哪一层。
"""
import json
import sys

import urllib.request

BASE = "http://localhost:3333"


def req(path, payload=None, token=None, method="POST"):
    url = BASE + path
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    # 1. dev 登录拿 token
    login = req("/api/auth/dev/login", {"username": "路人甲"})
    d1 = login.get("data") if isinstance(login.get("data"), dict) else login
    token = d1.get("access_token") or d1.get("token")
    print("[login] success=%s  token_len=%s" % (login.get("success"), len(token or "")))
    if not token:
        print("[login] full resp:", json.dumps(login, ensure_ascii=False)[:800])
        return

    # 2. 执行「图鉴 隐形披风B」
    res = req("/api/commands/execute", {"command": "图鉴 隐形披风B", "channelId": 1}, token)
    print("\n[execute] top-level keys:", list(res.keys()))
    print("[execute] success =", res.get("success"))

    data = res.get("data")
    print("[execute] data type =", type(data).__name__)
    if isinstance(data, dict):
        print("[execute] data keys =", list(data.keys()))
        print("[execute] data.content =", repr(data.get("content"))[:500])
        if isinstance(data.get("data"), dict):
            print("[execute] data.data keys =", list(data["data"].keys()))
            print("[execute] data.data.content =", repr(data["data"].get("content"))[:500])
    print("\n[execute] res.content =", repr(res.get("content"))[:500])
    print("[execute] res.data.content =", repr((data or {}).get("content"))[:500] if isinstance(data, dict) else "N/A")

    print("\n=== 原始 JSON 前 1200 字符 ===")
    print(json.dumps(res, ensure_ascii=False, indent=2)[:1200])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR:", type(e).__name__, e, file=sys.stderr)
        raise
