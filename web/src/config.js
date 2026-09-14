/**
 * 前端全局配置
 * 可在此调整前端连接后端的方式与指令前缀等。
 *
 * 说明：
 * - VITE_API_BASE：后端 HTTP 接口基础地址。开发时可用 Vite 代理(/api)，生产时同源或配反向代理。
 * - 通过 import.meta.env 读取 .env 变量，未设置则用默认值。
 */

// 后端 HTTP API 地址（Vite 代理或同源，通常用相对路径 /api）
export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// 后端 WebSocket 地址（Socket.IO namespace /ws）
// 开发环境后端运行在 3333，直接用完整地址最可靠（后端已配 CORS）；
// 生产环境通常与前端同源，用相对路径 /ws 由反向代理转发。
export const WS_URL =
  import.meta.env.VITE_WS_URL || (import.meta.env.DEV ? 'http://localhost:3333/ws' : '/ws');

// 指令前缀配置
// 前端发送的文本以这些前缀开头时，会被当作指令交给指令引擎处理。
// 支持多个前缀(数组)。设为空数组则所有输入都尝试作为指令处理(需先注册指令)。
export const COMMAND_PREFIXES = ['/', '！', '!'];

// 版本号配置
// 显示在界面右上角，用于标识当前前端版本，发布新版本时在此调整即可，无需改动视图代码。
export const APP_VERSION = '0.7.5';

// GitHub Issue 反馈页地址
// 头部「BUG 反馈」按钮的跳转目标；可通过环境变量 VITE_GITHUB_ISSUES_URL 覆盖，
// 仓库迁移或改名时只需在此（或 .env）调整，无需改动视图代码。
export const GITHUB_ISSUES_URL =
  import.meta.env.VITE_GITHUB_ISSUES_URL || 'https://github.com/1592363624/smdz/issues';

/**
 * 世界聊天 @提及（mention）配置
 *
 * 重要：名字字符集与长度上限必须与后端 ChatService.parseMentions /
 * ChatGateway.resolveTargetUser 保持一致，否则前端插入的 "@名字" 后端解析不到人、推送不到提醒。
 * - parseMaxLen 需 ≥ 35：QQ 互联用户名形如 qq_<32位openid>（共 35 字符），否则用户名被截断
 * - nameMaxLen 为「可安全写入 @ 的名字」上限，昵称超长或含空格/表情时前端退回用户名
 */
export const MENTION_CONFIG = {
  /** 名字允许的字符集（中文/英文/数字/下划线） */
  nameChars: '[\\u4e00-\\u9fa5A-Za-z0-9_]',
  /** 可安全用于 @ 的名字长度上限（昵称优先按此校验） */
  nameMaxLen: 32,
  /** 后端解析 @提及 的名字长度上限（放宽以兼容长用户名） */
  parseMaxLen: 64,
  /** @ 下拉最多展示的候选人数 */
  autocompleteLimit: 20,
  /** 可@玩家列表的轮询刷新间隔（毫秒） */
  playersRefreshMs: 60000,
  /** @ 下拉失焦后延迟关闭时间（毫秒）：留出时间让 mousedown 选中生效 */
  blurCloseDelayMs: 150,
};

/** 生成 @提及 解析正则（每次返回新实例，避免 g 标志 lastIndex 串扰） */
export function mentionParseRegex() {
  return new RegExp(`@(${MENTION_CONFIG.nameChars}{1,${MENTION_CONFIG.parseMaxLen}})`, 'g');
}

/** 名字是否可安全用于 @提及（能被后端解析且不会被截断） */
export function isSafeMentionName(name) {
  return new RegExp(`^${MENTION_CONFIG.nameChars}{1,${MENTION_CONFIG.nameMaxLen}}$`).test(String(name || ''));
}

/**
 * 在线玩家展示配置（左下角状态栏：悬停「在线」看名单 + 上下线提示）
 *
 * 说明：
 * - 名单条数上限由后端配置（PRESENCE_ONLINE_LIST_LIMIT，默认 10）控制，
 *   前端不再二次截断，只按后端返回的列表展示，剩余人数用「还有 X 人」补足。
 * - 上下线提示的保留时长/条数属于纯前端展示行为，在此配置即可调整。
 */
export const PRESENCE_CONFIG = {
  /** 上下线提示在状态栏中的保留时长（毫秒），默认 1 分钟 */
  noticeTtlMs: 60000,
  /** 同时最多展示的上下线提示条数（超出丢弃最旧的，避免撑爆状态栏） */
  noticeMaxStacks: 3,
  /** 鼠标从「在线」数字移到悬浮面板时的关闭延迟（毫秒），避免面板闪断 */
  hoverCloseDelayMs: 180,
};

/**
 * 右下角悬浮世界聊天窗配置
 * 调整窗口行为/输入限制时改这里，无需改动组件代码。
 */
export const FLOATING_CHAT_CONFIG = {
  /** 本地最多保留的聊天条数（防止长时间挂机内存膨胀） */
  maxMessages: 200,
  /** 单条消息最大字符数（输入框限制，与后端保存无关） */
  draftMaxLen: 200,
  /** @ 下拉候选列表的最大高度（px） */
  atListMaxHeight: 168,
};

/**
 * 世界红包前端配置（仅用于输入限制与文案提示）
 *
 * 注意：真正的业务校验以后端「系统配置中心 → 世界红包」(chat.redPacket) 为准，
 * 这里的数值只作为前端交互上限，避免用户提交后才被后端拒绝。
 */
export const RED_PACKET_CLIENT_CONFIG = {
  /** 祝福语最大字符数 */
  maxGreetingLength: 60,
  /** 单个红包最多可放入的道具种类数 */
  maxItemKinds: 10,
  /** 单个红包最大总份数（1 份 = 1 个道具） */
  maxTotalCount: 100,
};

// 部署更新检测配置(默认值)
// 实际生效值由后端 /api/system/version 接口返回(来源 SystemConfig 表，管理员可在线调整)，
// 此处仅作为后端配置缺失或接口不可用时的兜底。
export const UPDATE_SETTINGS = {
  // 是否开启部署完成检测
  enabled: true,
  // 轮询间隔(秒)
  interval: 30,
  // 弹窗后自动刷新倒计时(秒)，0=不自动刷新
  autoReloadSeconds: 15,
  // 点击「稍后」后的重复提醒冷却(秒)
  promptCooldown: 300,
};
