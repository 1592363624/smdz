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
export const APP_VERSION = '0.4.0';

// GitHub Issue 反馈页地址
// 头部「BUG 反馈」按钮的跳转目标；可通过环境变量 VITE_GITHUB_ISSUES_URL 覆盖，
// 仓库迁移或改名时只需在此（或 .env）调整，无需改动视图代码。
export const GITHUB_ISSUES_URL =
  import.meta.env.VITE_GITHUB_ISSUES_URL || 'https://github.com/1592363624/smdz/issues';

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
