"""沉浸模式（使魔大战开/关）插件逻辑单元测试。

以脚本方式独立运行（无需安装 astrbot）：
    python testscript/test_plugin_immersive.py

通过在 sys.modules 中注入最小桩导入 AstrBotPlugin/main.py，覆盖：
- 开关口令的整句精确匹配（含前缀符号容错）；
- 三种触发配置下（前缀/全量/无前缀）的消息分发判定；
- 沉浸模式的开启、关闭、幂等、同群用户隔离；
- 状态经 KV 存储跨「重启」（新插件实例）持久化。
"""

import asyncio
import sys
import types
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "AstrBotPlugin"
sys.path.insert(0, str(PLUGIN_DIR))

# ---------------------------------------------------------------------------
# astrbot 导入链最小桩：仅提供 main.py 用到的名字
# ---------------------------------------------------------------------------
_KV_STORE: dict = {}  # 模拟 KV 持久层，跨插件实例共享，用于验证重启后状态不丢


class _StubLogger:
    def info(self, *args, **kwargs): ...
    def warning(self, *args, **kwargs): ...
    def error(self, *args, **kwargs): ...


def _passthrough_decorator(*args, **kwargs):
    def wrapper(func):
        return func

    return wrapper


class _StubStar:
    """模拟 astrbot.api.star.Star：提供构造函数与 KV 存储方法。"""

    def __init__(self, context):
        self.context = context

    async def get_kv_data(self, key, default=None):
        return _KV_STORE.get(key, default)

    async def put_kv_data(self, key, value):
        _KV_STORE[key] = value


def _install_stub_modules():
    filter_stub = types.SimpleNamespace(
        EventMessageType=types.SimpleNamespace(
            ALL="all", GROUP_MESSAGE="group", PRIVATE_MESSAGE="private"
        ),
        event_message_type=_passthrough_decorator,
        command=_passthrough_decorator,
        command_group=_passthrough_decorator,
        permission_type=_passthrough_decorator,
        platform_adapter_type=_passthrough_decorator,
    )
    event_mod = types.ModuleType("astrbot.api.event")
    event_mod.filter = filter_stub
    event_mod.AstrMessageEvent = type("AstrMessageEvent", (), {})

    star_mod = types.ModuleType("astrbot.api.star")
    star_mod.Context = type("Context", (), {})
    star_mod.Star = _StubStar

    api_mod = types.ModuleType("astrbot.api")
    api_mod.AstrBotConfig = dict
    api_mod.logger = _StubLogger()

    astrbot_mod = types.ModuleType("astrbot")
    sys.modules["astrbot"] = astrbot_mod
    sys.modules["astrbot.api"] = api_mod
    sys.modules["astrbot.api.event"] = event_mod
    sys.modules["astrbot.api.star"] = star_mod
    sys.modules["aiohttp"] = types.ModuleType("aiohttp")


_install_stub_modules()

import main  # noqa: E402  依赖上面的桩，需在桩安装后导入


# ---------------------------------------------------------------------------
# 测试用例与工具
# ---------------------------------------------------------------------------
BASE_CONFIG = {
    "server_url": "http://localhost:3333",
    "bot_access_token": "test-token",
    "timeout": 5,
    "command_name": "smdz",
    "forward_all": False,
    "enabled": True,
    "enable_private": True,
    "allowed_groups": [],
    "allowed_users": [],
}


def make_plugin(**overrides):
    config = dict(BASE_CONFIG)
    config.update(overrides)
    return main.SmdzBridgePlugin(context=None, config=config)


def stub_forward(plugin):
    """把转发替换为可断言的桩，避免测试真实发起 HTTP 请求。"""

    async def fake_forward(qq_id, cmd):
        return f"OK:{cmd}"

    plugin._forward_to_game = fake_forward


class FakeEvent:
    """最小消息事件桩：提供 main.py 用到的属性与方法。"""

    def __init__(self, umo, sender_id, text, group_id=""):
        self.unified_msg_origin = umo
        self.message_str = text
        self.message_obj = types.SimpleNamespace(self_id="bot_self")
        self._sender_id = sender_id
        self._group_id = group_id
        self.stopped = False
        self.replies = []

    def get_sender_id(self):
        return self._sender_id

    def get_group_id(self):
        return self._group_id

    def plain_result(self, content):
        self.replies.append(content)
        return content

    def stop_event(self):
        self.stopped = True


def run_handler(plugin, event):
    async def collect():
        async for _ in plugin.on_all_message(event):
            pass

    asyncio.run(collect())
    return event


def reset_kv():
    _KV_STORE.clear()


def test_toggle_phrase_matching():
    plugin = make_plugin()
    assert plugin._match_immersive_toggle("使魔大战开") == "on"
    assert plugin._match_immersive_toggle("  使魔大战关  ") == "off"
    assert plugin._match_immersive_toggle("/使魔大战开") == "on"
    assert plugin._match_immersive_toggle("！使魔大战关") == "off"
    # 非整句匹配不应误触发，避免把聊天内容当成开关
    assert plugin._match_immersive_toggle("使魔大战开 背包") == ""
    assert plugin._match_immersive_toggle("今天使魔大战开了吗") == ""
    assert plugin._match_immersive_toggle("使魔大战关闭") == ""
    assert plugin._match_immersive_toggle("") == ""


def test_resolve_trigger_matrix():
    plugin = make_plugin()  # 前缀模式：smdz
    # 沉浸模式生效中：免前缀直接转发，且仍兼容习惯性前缀
    assert plugin._resolve_trigger("背包", True) == ("forward", "背包")
    assert plugin._resolve_trigger("/smdz 背包", True) == ("forward", "背包")
    # 非沉浸：前缀模式仅匹配触发词
    assert plugin._resolve_trigger("背包", False) == ("skip", "")
    assert plugin._resolve_trigger("/smdz 背包", False) == ("forward", "背包")
    assert plugin._resolve_trigger("smdz 信息", False) == ("forward", "信息")
    assert plugin._resolve_trigger("/smdz", False) == ("usage", "")
    # 全量转发 / 无前缀配置：所有消息都转发
    assert make_plugin(forward_all=True)._resolve_trigger("背包", False) == ("forward", "背包")
    assert make_plugin(command_name="")._resolve_trigger("背包", False) == ("forward", "背包")


def test_immersive_toggle_flow():
    reset_kv()
    plugin = make_plugin()
    stub_forward(plugin)
    umo = "aiocqhttp:FriendMessage:10001"

    # 开启：回复确认并阻断事件
    ev = run_handler(plugin, FakeEvent(umo, "10001", "使魔大战开"))
    assert ev.stopped, "开启口令应 stop_event 防止其它插件重复响应"
    assert "沉浸模式已开启" in ev.replies[0]

    # 开启后免前缀直接转发
    ev = run_handler(plugin, FakeEvent(umo, "10001", "背包"))
    assert ev.replies == ["OK:背包"] and ev.stopped

    # 重复开启：幂等确认
    ev = run_handler(plugin, FakeEvent(umo, "10001", "使魔大战开"))
    assert "沉浸模式已开启" in ev.replies[0]

    # 关闭：确认退出并恢复前缀触发
    ev = run_handler(plugin, FakeEvent(umo, "10001", "使魔大战关"))
    assert ev.stopped and "已退出沉浸模式" in ev.replies[0]
    ev = run_handler(plugin, FakeEvent(umo, "10001", "背包"))
    assert ev.replies == [] and not ev.stopped, "退出后非前缀消息应放行"

    # 未开启时关闭：给出提示而非静默
    ev = run_handler(plugin, FakeEvent(umo, "10001", "使魔大战关"))
    assert ev.stopped and "未开启沉浸模式" in ev.replies[0]


def test_group_isolation():
    reset_kv()
    plugin = make_plugin()
    stub_forward(plugin)
    umo = "aiocqhttp:GroupMessage:888"

    # 玩家A在群里开启沉浸模式
    run_handler(plugin, FakeEvent(umo, "10001", "使魔大战开"))

    # A 的消息被免前缀转发
    ev_a = run_handler(plugin, FakeEvent(umo, "10001", "攻击 1"))
    assert ev_a.replies == ["OK:攻击 1"]

    # 同群玩家 B 的日常聊天不受影响
    ev_b = run_handler(plugin, FakeEvent(umo, "20002", "吃饭啦"))
    assert ev_b.replies == [] and not ev_b.stopped

    # B 自己的「关闭」口令只对自己生效
    ev_b2 = run_handler(plugin, FakeEvent(umo, "20002", "使魔大战关"))
    assert "未开启沉浸模式" in ev_b2.replies[0]
    ev_a2 = run_handler(plugin, FakeEvent(umo, "10001", "背包"))
    assert ev_a2.replies == ["OK:背包"], "B 的关闭不应影响 A 的沉浸状态"


def test_persist_across_restart():
    reset_kv()
    plugin = make_plugin()
    stub_forward(plugin)
    umo = "aiocqhttp:FriendMessage:10001"

    run_handler(plugin, FakeEvent(umo, "10001", "使魔大战开"))

    # 模拟机器人重启：新建插件实例（KV 桩跨实例共享）
    plugin2 = make_plugin()
    stub_forward(plugin2)
    ev = run_handler(plugin2, FakeEvent(umo, "10001", "背包"))
    assert ev.replies == ["OK:背包"], "重启后沉浸状态应从 KV 恢复"

    # 关闭后同样持久化
    run_handler(plugin2, FakeEvent(umo, "10001", "使魔大战关"))
    plugin3 = make_plugin()
    stub_forward(plugin3)
    ev = run_handler(plugin3, FakeEvent(umo, "10001", "背包"))
    assert ev.replies == [] and not ev.stopped, "关闭状态也应跨重启持久化"


def run_all():
    tests = [
        test_toggle_phrase_matching,
        test_resolve_trigger_matrix,
        test_immersive_toggle_flow,
        test_group_isolation,
        test_persist_across_restart,
    ]
    failed = []
    for test in tests:
        try:
            test()
            print(f"✅ {test.__name__}")
        except AssertionError as exc:
            failed.append(test.__name__)
            print(f"❌ {test.__name__}: {exc}")
    print(f"\n{len(tests) - len(failed)}/{len(tests)} 通过")
    return len(failed)


if __name__ == "__main__":
    sys.exit(1 if run_all() else 0)
