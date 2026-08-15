/**
 * 前端 API 封装
 * 统一的 axios 实例，自动携带 JWT 令牌。
 */
import axios from 'axios';

// 创建 axios 实例，基础路径为 /api(开发环境由 Vite 代理到后端)
const http = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

// 请求拦截：自动携带 JWT
http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截：401 时跳转登录
http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  },
);

/// 认证接口
export const authApi = {
  register: (data) => http.post('/auth/register', data),
  login: (data) => http.post('/auth/login', data),
};

/// 用户接口
export const userApi = {
  me: () => http.get('/users/me'),
  bindQQ: (qqNumber) => http.post('/users/bind-qq', { qqNumber }),
};

/// 聊天接口
export const chatApi = {
  getMessages: (channelId = 1, limit = 50) =>
    http.get('/chat/messages', { params: { channelId, limit } }),
  getChannel: () => http.get('/chat/channel'),
};

/// 指令接口
export const commandApi = {
  execute: (command, channelId = 1) =>
    http.post('/commands/execute', { command, channelId }),
  list: () => http.get('/commands/list'),
};

/// 游戏接口
export const gameApi = {
  // 获取玩家信息（等级、HP、位置等）
  playerInfo: () => http.get('/game/player/info'),
  // 获取地图连接
  mapConnections: () => http.get('/game/map/connections'),
  // 获取地图总览（当前区域+全部地图）
  mapOverview: () => http.get('/game/map/overview'),
  // 执行游戏内快捷操作
  quickAction: (action) => http.post('/game/player/action', { action }),
  // 获取服务器在线统计（总玩家数、在线人数）
  stats: () => http.get('/game/stats'),
};

/// 管理员接口(需ADMIN权限)
export const adminApi = {
  // 用户管理
  listUsers: (params) => http.get('/admin/users', { params }),
  updateUser: (data) => http.post('/admin/users/update', data),
  // 系统配置
  listConfig: () => http.get('/admin/config'),
  getConfig: (key) => http.get(`/admin/config/${key}`),
  updateConfig: (key, value) => http.post('/admin/config/update', { key, value }),
  // 服务器仪表盘
  dashboard: () => http.get('/admin/dashboard'),
  // GM 工具：发放物品
  giveItem: (data) => http.post('/admin/gm/give-item', data),
  // GM 工具：设置世界等级
  setWorldLevel: (level) => http.post('/admin/gm/world-level', { level }),
  // GM 工具：发送全服公告
  sendAnnouncement: (message) => http.post('/admin/gm/announcement', { message }),
  // GM 工具：获取世界等级
  worldLevel: () => http.get('/admin/gm/world-level'),
};

export default http;
