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
  1. 前缀模式：配置 `command_name`（如 smdz）后，仅输入 `/smdz <游戏指令>` 会转发；
  2. 无前缀模式：`command_name` 留空时，收到的所有消息直接转发（等效于开启 forward_all）；
  3. 全量模式：开启 `forward_all` 后，无论前缀如何，所有消息都会尝试转发；
  4. 沉浸模式：玩家发送「使魔大战开」后，其在本会话内发送的所有消息免前缀
     直接转发；发送「使魔大战关」恢复按上面 1-3 的配置触发。状态按
     「会话+用户」记录并持久化，只对开启者本人生效，既能沉浸游玩，又不会
     把同群其他用户的聊天误转成游戏指令。
"""

import asyncio

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star
from astrbot.api import AstrBotConfig, logger

import aiohttp


class SmdzBridgePlugin(Star):
    """使魔大战3 游戏桥接插件主类。"""

    # 单条消息最多拆分转发的行数：防止误粘贴超长文本导致连续刷屏或冲击后端接口
    _MAX_FORWARD_LINES = 5

    # 沉浸模式开关口令：玩家发送口令后，其在本会话内的消息免前缀直接转发；
    # 发送关闭口令后恢复按插件配置的前缀方式触发。口令免前缀、整句精确匹配。
    _IMMERSIVE_ON_PHRASE = "使魔大战开"
    _IMMERSIVE_OFF_PHRASE = "使魔大战关"
    # 沉浸模式状态在 KV 存储中的键名（跨重启持久化）
    _IMMERSIVE_KV_KEY = "immersive_users"

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

        # 权限控制配置：总开关、是否允许私聊、允许的群ID、允许的用户QQ号
        self.enabled = config.get("enabled", True)
        self.enable_private = config.get("enable_private", False)
        # 统一转为字符串列表，便于与 event 返回的 ID 字符串比较
        self.allowed_groups = [str(g) for g in config.get("allowed_groups", [])]
        self.allowed_users = [str(u) for u in config.get("allowed_users", [])]

        # 触发词集合（配置指令名 + 常用别名），用于在原文中剥离指令前缀；空配置会被过滤
        self._trigger_names = {n for n in (self.command_name, "smdz", "使魔", "游戏") if n}

        # 沉浸模式状态：{会话来源(unified_msg_origin): {开启者QQ}}。
        # 只对显式发送「使魔大战开」的用户免前缀转发，避免把同群其他用户的
        # 聊天误转成游戏指令；首次使用时从 KV 存储懒加载，机器人重启后不丢。
        self._immersive_users: dict[str, set[str]] = {}
        self._immersive_loaded = False

        # 触发模式描述（用于初始化日志展示）
        if self.forward_all:
            trigger_desc = "全量转发所有消息"
        elif not self.command_name:
            trigger_desc = "无前缀，直接转发所有消息"
        else:
            trigger_desc = f"前缀 /{self.command_name}"

        logger.info(
            f"[使魔大战3桥接] 插件初始化完成，服务地址={self.server_url}，"
            f"触发模式={trigger_desc}，"
            f"沉浸口令=「{self._IMMERSIVE_ON_PHRASE}/{self._IMMERSIVE_OFF_PHRASE}」，"
            f"允许群={self.allowed_groups or '不限'}，允许用户={self.allowed_users or '不限'}"
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
                    # 后端返回非 2xx（如 401 令牌错误、500 服务异常），说明请求失败
                    if resp.status < 200 or resp.status >= 300:
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
            if not content:
                return "（游戏无返回内容）"
            # 兜底：旧版后端可能仍返回 "#换行" 标记（原版 #换行符），转为真实换行
            return str(content).replace("#换行", "\n")

        return "游戏指令执行失败，请检查指令是否正确。"

    def _extract_bind_openid(self, text: str) -> str:
        """检测是否为 QQ 绑定指令，并提取 OpenID。

        支持的格式：
        - 使魔大战绑定QQ <openid>
        - smdz绑定QQ <openid>
        - 绑定QQ <openid>

        Args:
            text: 用户发送的原始消息。

        Returns:
            提取到的 openid；若不是绑定指令或格式错误则返回空字符串。
        """
        text = text.strip()
        prefixes = ("使魔大战绑定QQ", "smdz绑定QQ", "绑定QQ")
        for prefix in prefixes:
            # 支持有无空格分隔
            if text.startswith(prefix):
                rest = text[len(prefix):].strip()
                return rest
        return ""

    async def _bind_qq(self, qq_id: str, openid: str) -> str:
        """调用游戏后端绑定接口，将发送者 QQ 号与网页账号（openid）绑定。

        Args:
            qq_id: 消息来源 QQ 号（ AstrBot 从事件中自动获取）。
            openid: 用户在网页端复制的 OpenID。

        Returns:
            绑定结果提示文本。
        """
        url = f"{self.server_url}/api/bot/bind-qq"
        headers = {
            "x-bot-token": self.bot_access_token,
            "Content-Type": "application/json",
        }
        payload = {"externalId": openid, "qqNumber": qq_id}

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url, json=payload, headers=headers, timeout=self.timeout
                ) as resp:
                    if resp.status < 200 or resp.status >= 300:
                        body = await resp.text()
                        logger.error(
                            f"[使魔大战3桥接] 绑定QQ返回状态 {resp.status}: {body}"
                        )
                        return f"绑定失败（HTTP {resp.status}），请稍后再试。"
                    data = await resp.json()
        except aiohttp.ClientConnectorError as exc:
            logger.error(f"[使魔大战3桥接] 无法连接游戏服务: {exc}")
            return "无法连接游戏服务，请确认后端已启动且服务地址配置正确。"
        except asyncio.TimeoutError:
            logger.error("[使魔大战3桥接] 请求游戏服务超时")
            return "游戏服务响应超时，请稍后再试。"

        if data.get("success"):
            user = data.get("data") or {}
            nickname = user.get("nickname") or user.get("username") or "玩家"
            return (
                f"✅ 绑定成功！\n"
                f"网页账号：{nickname}\n"
                f"绑定QQ：{qq_id}\n"
                f"现在可以在本群使用游戏指令了。"
            )

        return f"绑定失败：{data.get('message', '未知错误')}"

    def _extract_game_command(self, text: str) -> str:
        """从原始消息中剥离触发指令前缀，返回真正要转发的游戏指令。

        例如输入 `/smdz 背包` 或 `smdz 攻击 1`，返回 `背包` / `攻击 1`；
        若首 token 不是触发词，则原样返回整句（用于 forward_all 模式）。
        """
        text = text.strip()
        if not text:
            return ""
        # 按任意空白（含换行）切首个 token：兼容 "/smdz" 与指令内容分行发送的输入习惯
        parts = text.split(None, 1)
        first = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        cleaned = first.lstrip("/.！! ")
        if cleaned in self._trigger_names:
            return rest.strip()
        return text

    def _resolve_trigger(self, text: str, immersive: bool) -> tuple[str, str]:
        """按触发配置判定消息的处理方式。

        Args:
            text: 用户发送的原始消息（已 strip，非空）。
            immersive: 发送者在本会话是否处于沉浸模式（免前缀直接转发）。

        Returns:
            (动作, 游戏指令) 二元组：
            - ("skip", "")：不满足任何触发条件，静默放行给后续插件处理；
            - ("usage", "")：前缀模式下只发了前缀没带指令内容，需回复用法提示；
            - ("forward", cmd)：转发游戏指令 cmd。
        """
        # 0) 沉浸模式生效中：开启者本人的消息免前缀直接转发（仍会剥离习惯性前缀）
        if immersive:
            cmd = self._extract_game_command(text)
            return ("forward", cmd) if cmd else ("skip", "")
        # 1) 全量转发：forward_all 开启，或 command_name 留空（无前缀直接触发）
        if self.forward_all or not self.command_name:
            cmd = self._extract_game_command(text)
            return ("forward", cmd) if cmd else ("skip", "")
        # 2) 前缀模式：仅匹配配置前缀（含内置别名）的消息才转发。
        #    用任意空白（含换行）切首个 token：兼容 "/smdz" 单独占一行、
        #    游戏指令从第二行开始的输入习惯。
        first = text.split(None, 1)[0].lstrip("/.！! ")
        if first not in self._trigger_names:
            return ("skip", "")
        cmd = self._extract_game_command(text)
        return ("usage", "") if not cmd else ("forward", cmd)

    # ------------------------------------------------------------------
    # 沉浸模式：口令开关 + 会话级免前缀转发状态（KV 持久化）
    # ------------------------------------------------------------------
    def _match_immersive_toggle(self, text: str) -> str:
        """精确匹配沉浸模式开关口令。

        口令设计为免前缀生效：去掉开头的常见指令符号后整句精确比较，
        聊天中包含口令字样的其它句子不会被误判为开关。

        Args:
            text: 用户发送的原始消息（已 strip，非空）。

        Returns:
            "on" / "off"；不是口令时返回空字符串。
        """
        normalized = text.strip().lstrip("/.！! ").strip()
        if normalized == self._IMMERSIVE_ON_PHRASE:
            return "on"
        if normalized == self._IMMERSIVE_OFF_PHRASE:
            return "off"
        return ""

    async def _load_immersive_users(self) -> dict[str, set[str]]:
        """加载沉浸模式状态：首次访问从 KV 存储读取，之后走内存缓存。

        Returns:
            {会话来源(unified_msg_origin): {开启沉浸模式的用户QQ}}。
        """
        if self._immersive_loaded:
            return self._immersive_users
        self._immersive_loaded = True
        try:
            data = await self.get_kv_data(self._IMMERSIVE_KV_KEY, None)
        except Exception as exc:
            logger.warning(
                f"[使魔大战3桥接] 读取沉浸模式状态失败，本次运行内状态仅存于内存: {exc}"
            )
            return self._immersive_users
        if not isinstance(data, dict):
            return self._immersive_users
        # KV 中以 {会话来源: [用户QQ, ...]} 存储，还原为集合便于判断
        self._immersive_users = {
            umo: set(qq_list)
            for umo, qq_list in data.items()
            if isinstance(qq_list, (list, tuple, set))
        }
        return self._immersive_users

    async def _save_immersive_users(self) -> None:
        """把沉浸模式状态写入 KV 存储，机器人重启后状态不丢失。"""
        try:
            await self.put_kv_data(
                self._IMMERSIVE_KV_KEY,
                {umo: sorted(qq_list) for umo, qq_list in self._immersive_users.items()},
            )
        except Exception as exc:
            logger.warning(f"[使魔大战3桥接] 保存沉浸模式状态失败: {exc}")

    async def _is_immersive(self, event: AstrMessageEvent) -> bool:
        """判断发送者在本会话是否开启了沉浸模式。"""
        users = await self._load_immersive_users()
        return event.get_sender_id() in users.get(event.unified_msg_origin, ())

    async def _apply_immersive_toggle(self, event: AstrMessageEvent, toggle: str) -> str:
        """处理沉浸模式开关口令：更新状态（含持久化）并返回提示文本。

        Args:
            event: 触发口令的消息事件。
            toggle: "on" 或 "off"。

        Returns:
            回复给用户的提示文本。
        """
        umo = event.unified_msg_origin
        qq_id = event.get_sender_id()
        users = await self._load_immersive_users()

        if toggle == "on":
            # 重复发送口令时状态幂等，直接再次确认，方便玩家核对
            users.setdefault(umo, set()).add(qq_id)
            await self._save_immersive_users()
            return (
                "🎮 沉浸模式已开启！\n"
                "现在直接发送游戏指令即可，无需任何前缀。\n"
                f"发送「{self._IMMERSIVE_OFF_PHRASE}」可退出沉浸模式。"
            )

        session_users = users.get(umo)
        if not session_users or qq_id not in session_users:
            return f"当前未开启沉浸模式，发送「{self._IMMERSIVE_ON_PHRASE}」可开启。"

        session_users.discard(qq_id)
        if not session_users:
            del users[umo]
        await self._save_immersive_users()
        if self.forward_all or not self.command_name:
            # 全量转发模式下退出沉浸模式后行为不变，主动说明避免玩家误解
            return "✅ 已退出沉浸模式。（当前插件为全量转发模式，消息仍会直接转发到游戏）"
        return f"✅ 已退出沉浸模式，恢复原有触发方式：/{self.command_name} <游戏指令>"

    # ------------------------------------------------------------------
    # 私有工具方法
    # ------------------------------------------------------------------
    def _is_bot_self(self, event: AstrMessageEvent) -> bool:
        """判断消息是否由机器人自身发出，避免转发时造成死循环。"""
        try:
            return event.get_sender_id() == event.message_obj.self_id
        except Exception:
            return False

    def _check_permission(self, event: AstrMessageEvent) -> bool:
        """校验消息来源是否允许使用本插件。

        规则（任一不满足即拒绝）：
        - 群消息：若配置了 allowed_groups，群ID必须在其中；
        - 私聊消息：必须开启 enable_private；
        - 用户：若配置了 allowed_users，发送者QQ号必须在其中。

        Args:
            event: AstrBot 消息事件。

        Returns:
            是否允许使用。
        """
        group_id = event.get_group_id()
        if group_id:
            # 群消息：配置了白名单且当前群不在其中 → 拒绝
            if self.allowed_groups and group_id not in self.allowed_groups:
                return False
        else:
            # 私聊消息：未开启私聊 → 拒绝
            if not self.enable_private:
                return False

        # 用户白名单：非空时校验发送者QQ号
        if self.allowed_users and event.get_sender_id() not in self.allowed_users:
            return False

        return True

    # ------------------------------------------------------------------
    # 统一消息入口：按配置动态决定触发方式
    # ------------------------------------------------------------------
    # priority=1 让本插件优先处理，转发后调用 event.stop_event() 阻断，
    # 避免后续插件（签到、游戏引导等）对同一条游戏指令重复响应。
    @filter.event_message_type(filter.EventMessageType.ALL, priority=1)
    async def on_all_message(self, event: AstrMessageEvent):
        """统一消息入口，按配置动态决定是否转发到游戏。

        触发规则（按优先级）：
        - 沉浸模式口令：消息精确为「使魔大战开/使魔大战关」时免前缀生效，
          开启/关闭发送者在本会话的沉浸模式；
        - 沉浸模式生效中：开启者本人发送的所有消息免前缀直接转发；
        - forward_all 开启：收到的所有消息都尝试转发，不限制前缀；
        - command_name 留空：同样转发所有消息（无前缀直接触发，等效 forward_all）；
        - command_name 非空：仅当消息以该前缀（或内置别名 smdz/使魔/游戏）
          开头时才转发，并剥离前缀后作为游戏指令；
        - 机器人自身消息、未授权群/用户的消息一律跳过，避免死循环与越权。

        只要本插件认领了某条消息（转发成功或给出用法提示），都会调用
        event.stop_event() 阻断该消息继续广播，防止其它插件重复响应。
        """
        # 总开关
        if not self.enabled:
            return
        # 跳过机器人自身消息，避免转发造成死循环
        if self._is_bot_self(event):
            return
        # 权限校验：未授权的群/用户静默跳过，不打扰
        if not self._check_permission(event):
            return

        text = event.message_str.strip()
        if not text:
            return

        # 0) 沉浸模式口令：任何触发模式下都免前缀生效，先于普通触发判断处理
        toggle = self._match_immersive_toggle(text)
        if toggle:
            reply = await self._apply_immersive_toggle(event, toggle)
            yield event.plain_result(reply)
            event.stop_event()
            return

        # 按触发配置判定处理方式（沉浸模式生效中的用户免前缀直接转发）
        immersive = await self._is_immersive(event)
        action, game_command = self._resolve_trigger(text, immersive)
        if action == "skip":
            return
        if action == "usage":
            # 只给了前缀没给指令内容时，提示用法并阻断后续插件
            yield event.plain_result(
                f"用法：/{self.command_name} <游戏指令>\n"
                "例如：\n"
                f"/{self.command_name} 背包\n"
                f"/{self.command_name} 信息\n"
                f"/{self.command_name} 帮助\n\n"
                f"提示：发送「{self._IMMERSIVE_ON_PHRASE}」可开启沉浸模式，"
                "之后无需前缀直接发送游戏指令。"
            )
            event.stop_event()
            return

        # 优先处理 QQ 号绑定指令：用户在网页端复制 OpenID，在群里发送绑定指令，
        # 插件从消息事件中自动获取发送者 QQ 号，调用后端完成绑定。
        # 放在触发词剥离之后，因此支持 "绑定QQ <openid>" 或 "/smdz 绑定QQ <openid>" 两种形式。
        openid = self._extract_bind_openid(game_command)
        if openid:
            qq_id = event.get_sender_id()
            if not openid.isalnum() or len(openid) < 16:
                yield event.plain_result("OpenID 格式不正确，请从网页端复制完整的 OpenID 后重试。")
                event.stop_event()
                return
            content = await self._bind_qq(qq_id, openid)
            yield event.plain_result(content)
            event.stop_event()
            return

        qq_id = event.get_sender_id()

        # 多行指令拆分：按行逐条转发、分次回复。
        # 典型场景：QQ 输入框换行发送多个编号数字（如 1/2/3 各占一行），
        # 后端数字快捷键要求整条消息精确等于编号，多行合发会全部失效；
        # 拆成单行逐条调用后，每行都能正常触发对应动作，回复也按次分开更清晰。
        lines = [line.strip() for line in game_command.splitlines() if line.strip()]
        if len(lines) > 1:
            if len(lines) > self._MAX_FORWARD_LINES:
                yield event.plain_result(
                    f"一次最多执行 {self._MAX_FORWARD_LINES} 条指令（当前 {len(lines)} 条），已截断处理前 {self._MAX_FORWARD_LINES} 条。"
                )
                lines = lines[: self._MAX_FORWARD_LINES]
            for line in lines:
                content = await self._forward_to_game(qq_id, line)
                yield event.plain_result(content)
            # 阻断消息继续广播，防止其它插件对同一条指令再次响应
            event.stop_event()
            return

        content = await self._forward_to_game(qq_id, game_command)
        yield event.plain_result(content)
        # 阻断消息继续广播，防止其它插件对同一条指令再次响应
        event.stop_event()