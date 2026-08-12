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
