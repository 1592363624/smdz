# -*- coding: utf-8 -*-
"""验证图鉴查询链路：显示名(带品质码) vs 基础名。"""
import json
import urllib.request

BASE = "http://localhost:3333"


def req(path, payload=None, token=None):
    url = BASE + path
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(r, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


login = req("/api/auth/dev/login", {"username": "路人甲"})
token = login["data"]["access_token"]


def handbook(name):
    res = req("/api/commands/execute", {"command": f"图鉴 {name}", "channelId": 1}, token)
    return (res.get("data", {}).get("content") or "").strip()


for q in ["纵横C"]:
    out = handbook(q)
    print(f"===== [{q}] 完整返回 =====")
    print(out)
