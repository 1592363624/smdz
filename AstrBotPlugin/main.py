"""
使魔大战3 游戏机器人桥接插件（AstrBot）
======================================

功能：把 QQ 群/私聊中收到的游戏指令，通过游戏后端唯一接口
`POST /api/bot/command` 转发过去，并把后端返回的指令结果文本回复给玩家。

设计说明：
- 插件不需要为每个游戏指令单独实现逻辑，只需桥接「消息进 → 结果出」。
- 玩家身份：请求体 `botIdentity` 填 QQ 号，后端会根据 `User.qqNumber`
  自动绑定到对应网页账号执行指令；未绑定的 QQ 以匿名身份执行。
- 触发方式：
  1. 默认模式：输入 `/smdz <游戏指令>`（前缀指令名可在配置中修改）。
  2. 转发所有模式：开启 `forward_all` 后，群里收到的语句都会尝试转发。
"""

import asyncio

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star
from astrbot.api import AstrBotConfig, logger

import aiohttp


class SmdzBridgePlugin(Star):
    """使魔大战3 游戏桥接插件主类。"""

    def __init__(self, context: Context, config: AstrBotConfig):
        """插件初始化：读取配置项，准备桥接所需参数。

        Args:
            context: AstrBot 插件上下文。
            config: 插件配置对象（来自 _conf_schema.json）。
        """
        super().__init__(context)
        self.config = config

        # 读取配置：服务地址、访问令牌、超时、触发指令名、是否全量转发
        self.server_url = config.get("server_url", "http://localhost:3333").rstrip("/")
        self.bot_access_token = config.get("bot_access_token", "")
        self.timeout = config.get("timeout", 30)
        self.command_name = config.get("command_name", "smdz")
        self.forward_all = config.get("forward_all", False)

        # 触发词集合（指令名 + 常用别名），用于在原文中剥离指令前缀
        self._trigger_names = {self.command_name, "smdz", "使魔", "游戏"}

        logger.info(
            f"[使魔大战3桥接] 插件初始化完成，服务地址={self.server_url}，"
            f"触发指令=/{self.command_name}"
        )

    # ------------------------------------------------------------------
    # 私有工具方法
    # ------------------------------------------------------------------
    async def _forward_to_game(self, qq_id: str, game_command: str) -> str:
        """调用游戏后端统一接口执行指令，返回结果文本。

        Args:
            qq_id: 发送者 QQ 号（作为 botIdentity 传给后端，用于玩家绑定）。
            game_command: 要执行的游戏指令文本。

        Returns:
            游戏返回的结果文本；出错时返回可读的错误提示。
        """
        url = f"{self.server_url}/api/bot/command"
        headers = {
            "x-bot-token": self.bot_access_token,
            "Content-Type": "application/json",
        }
        payload = {"botIdentity": qq_id, "message": game_command}

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url, json=payload, headers=headers, timeout=self.timeout
                ) as resp:
                    # 后端返回非 200，说明令牌/服务异常
                    if resp.status != 200:
                        body = await resp.text()
                        logger.error(
                            f"[使魔大战3桥接] 游戏服务返回状态 {resp.status}: {body}"
                        )
                        return f"游戏服务异常（HTTP {resp.status}），请检查令牌或服务地址。"

                    data = await resp.json()
        except aiohttp.ClientConnectorError as exc:
            logger.error(f"[使魔大战3桥接] 无法连接游戏服务: {exc}")
            return "无法连接游戏服务，请确认后端已启动且服务地址配置正确。"
        except asyncio.TimeoutError:
            logger.error("[使魔大战3桥接] 请求游戏服务超时")
            return "游戏服务响应超时，请稍后再试。"

        # 解析统一返回结构 { success, data: { content, broadcast, ... } }
        if data.get("success"):
            result = data.get("data") or {}
            content = result.get("content")
            return content if content else "（游戏无返回内容）"

        return "游戏指令执行失败，请检查指令是否正确。"

    def _extract_game_command(self, text: str) -> str:
        """从原始消息中剥离触发指令前缀，返回真正要转发的游戏指令。

        例如输入 `/smdz 背包` 或 `smdz 攻击 1`，返回 `背包` / `攻击 1`；
        若首 token 不是触发词，则原样返回整句（用于 forward_all 模式）。
        """
        text = text.strip()
        if not text:
            return ""
        # 按首个空白切分，分离触发词与剩余部分
        first, _, rest = text.partition(" ")
        # 去除可能的指令前缀符号（/ ！ ！ . 等）
        cleaned = first.lstrip("/.！! ")
        if cleaned in self._trigger_names:
            return rest.strip()
        return text

    def _is_bot_self(self, event: AstrMessageEvent) -> bool:
        """判断消息是否由机器人自身发出，避免转发时造成死循环。"""
        try:
            return event.get_sender_id() == event.message_obj.self_id
        except Exception:
            return False

    # ------------------------------------------------------------------
    # 指令入口：/smdz <游戏指令>
    # ------------------------------------------------------------------
    @filter.command("smdz", alias={"使魔", "游戏"})
    async def smdz(self, event: AstrMessageEvent):
        """转发游戏指令（使用方式：/smdz <游戏指令>，如 /smdz 背包）。

        Args:
            event: AstrBot 消息事件。
        """
        # 提取触发指令前缀之后的具体游戏指令
        game_command = self._extract_game_command(event.message_str)
        if not game_command:
            yield event.plain_result(
                f"用法：/{self.command_name} <游戏指令>\n"
                "例如：\n"
                f"/{self.command_name} 背包\n"
                f"/{self.command_name} 信息\n"
                f"/{self.command_name} 帮助"
            )
            return

        qq_id = event.get_sender_id()
        content = await self._forward_to_game(qq_id, game_command)
        yield event.plain_result(content)

    # ------------------------------------------------------------------
    # 转发所有模式入口（可选）
    # ------------------------------------------------------------------
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_all_message(self, event: AstrMessageEvent):
        """转发所有消息到游戏（需开启 forward_all 配置）。

        注意：开启后群里收到的所有消息都会尝试作为游戏指令转发，
        为避免自循环，机器人自身发出的消息会被跳过。
        """
        if not self.forward_all:
            return
        if self._is_bot_self(event):
            return

        # 若消息是以触发指令开头（如 /smdz 背包），交给 smdz 指令处理，避免重复转发
        first = event.message_str.strip().partition(" ")[0].lstrip("/.！! ")
        if first in self._trigger_names:
            return

        game_command = self._extract_game_command(event.message_str)
        if not game_command:
            return

        qq_id = event.get_sender_id()
        content = await self._forward_to_game(qq_id, game_command)
        yield event.plain_result(content)