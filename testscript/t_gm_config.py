# -*- coding: utf-8 -*-
"""验证 GM 配置链路：admin config/update(upsert 建行) -> 公开 web-config 读取 -> 恢复默认。"""
import json
import urllib.request

BASE = "http://localhost:3333"


def req(path, payload=None, token=None, method="POST"):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


# 1. admin dev login（已提升为 SUPER_ADMIN）
login = req("/api/auth/dev/login", {"username": "admin"})
token = login["data"]["access_token"]
print("[login] role =", login["data"]["user"]["role"])

# 2. 查看当前公开配置
print("[before]", req("/api/system/web-config", method="GET"))

# 3. GM 后台保存（行不存在 → upsert 自动建行；DB 中原本没有该行）
res = req("/api/admin/config/update", {"key": "web.handbookTooltipDelayMs", "value": "500"}, token)
print("[update 500]", res.get("success"))

# 4. 公开端点应读到新值
print("[after 500]", req("/api/system/web-config", method="GET"))

# 5. 恢复默认 1000
req("/api/admin/config/update", {"key": "web.handbookTooltipDelayMs", "value": "1000"}, token)
print("[restore 1000]", req("/api/system/web-config", method="GET"))

# 6. 确认 DB 行类型（admin config 列表里应有 type=number 的正式行）
rows = req("/api/admin/config", None, token, method="GET")
row = next((r for r in rows["data"] if r["key"] == "web.handbookTooltipDelayMs"), None)
print("[db row]", json.dumps(row, ensure_ascii=False))
