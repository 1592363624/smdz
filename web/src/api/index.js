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
/// 注：登录仅通过 QQ 互联完成，前端不再调用用户名+密码的自注册/自登录接口。
export const authApi = {};

/// 用户接口
export const userApi = {
  me: () => http.get('/users/me'),
  updateNickname: (nickname) => http.post('/users/nickname', { nickname }),
  // 获取我的常用指令列表
  getFavorites: () => http.get('/users/favorite-commands'),
  // 设置（全量覆盖）我的常用指令列表
  setFavorites: (commands) => http.post('/users/favorite-commands', { commands }),
};

/// 聊天接口
export const chatApi = {
  getMessages: (channelId = 1, limit = 50) =>
    http.get('/chat/messages', { params: { channelId, limit } }),
  getChannel: () => http.get('/chat/channel'),
  // 获取可@提及的玩家列表（含在线状态，在线优先排序）
  getPlayers: () => http.get('/chat/players'),
  // 私聊会话列表（含未读数与最后一条消息）
  getPrivateConversations: () => http.get('/chat/private/conversations'),
  // 与指定用户的私聊历史
  getPrivateMessages: (withUserId, limit = 50) =>
    http.get('/chat/private/messages', { params: { withUserId, limit } }),
  // 标记与指定用户的私聊为已读
  markPrivateRead: (withUserId) => http.post('/chat/private/read', { withUserId }),
  // 通过 HTTP 发送私聊（指令通道等场景）
  sendPrivateMessage: (to, content) => http.post('/chat/private/send', { to, content }),
};

/// 反馈接口
export const feedbackApi = {
  // 上传附件（multipart/form-data），返回可访问 URL 列表
  upload: (files) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    return http.post('/feedback/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  // 提交反馈工单
  create: (data) => http.post('/feedback', data),
  // 我的反馈工单列表
  mine: () => http.get('/feedback/mine'),
  // 反馈工单详情（含完整消息）
  detail: (id) => http.get(`/feedback/${id}`),
  // 回复反馈工单
  reply: (id, data) => http.post(`/feedback/${id}/messages`, data),
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
  // 获取当前区域附近玩家列表（同一地图，含在线状态）
  nearbyPlayers: () => http.get('/game/map/nearby-players'),
  // 执行游戏内快捷操作
  quickAction: (action) => http.post('/game/player/action', { action }),
  // 玩家自助清除自己的游戏数据(等同管理员GM清除，保留账号，重置为未开始游玩)
  resetMyData: () => http.post('/game/player/reset-data'),
  // 获取服务器在线统计（总玩家数、在线人数）
  stats: () => http.get('/game/stats'),
};

/// 系统/版本接口
export const systemApi = {
  // 获取部署版本信息与更新检测配置（用于检测部署完成、弹窗提示更新日志）
  getVersion: () => http.get('/system/version'),
};

/// 管理员接口(需ADMIN权限)
export const adminApi = {
  // 用户管理（支持分页、关键词搜索、排序字段/方向）
  listUsers: (params) => http.get('/admin/users', { params }),
  updateUser: (data) => http.post('/admin/users/update', data),
  deleteUser: (id) => http.post('/admin/users/delete', { id }),
  // 用户管理：用户详情(含玩家档案、在线状态、在线时长等)
  userDetail: (id) => http.post('/admin/users/detail', { id }),
  // 用户管理：批量编辑玩家游戏数据(字段白名单)
  editPlayerData: (id, data) => http.post('/admin/players/edit', { id, data }),
  // 用户管理：清空游戏数据(保留账号，重置为未开始游玩)
  resetUserData: (id) => http.post('/admin/users/reset-data', { id }),
  // 用户管理：批量删除账号(级联删除其玩家档案；自动跳过自己/超级管理员)
  batchDeleteUsers: (ids) => http.post('/admin/users/batch-delete', { ids }),
  // 用户管理：批量清空游戏数据(保留账号，多选操作)
  batchResetUserData: (ids) => http.post('/admin/users/batch-reset-data', { ids }),
  // 用户管理：一键清空全部玩家游戏数据(保留所有账号)
  resetAllPlayerData: () => http.post('/admin/users/reset-all-data'),
  // 系统配置
  listConfig: () => http.get('/admin/config'),
  getConfig: (key) => http.get(`/admin/config/${key}`),
  updateConfig: (key, value) => http.post('/admin/config/update', { key, value }),
  // 服务器仪表盘
  dashboard: () => http.get('/admin/dashboard'),
  // GM 工具：发放物品(target 支持用户名/昵称/QQ号/ID)
  giveItem: (data) => http.post('/admin/gm/give-item', data),
  // GM 工具：修改玩家属性(白名单字段)
  modifyPlayer: (data) => http.post('/admin/gm/modify-player', data),
  // GM 工具：设置世界等级
  setWorldLevel: (level) => http.post('/admin/gm/world-level', { level }),
  // GM 工具：发送全服公告
  sendAnnouncement: (message) => http.post('/admin/gm/announcement', { message }),
  // GM 工具：上传公告配图（仅图片），返回可访问 URL 列表
  uploadAnnouncementImage: (files) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    return http.post('/admin/announcement/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  // GM 工具：获取世界等级
  worldLevel: () => http.get('/admin/gm/world-level'),
};

export default http;
