/**
 * 前端 API 封装
 * 统一的 axios 实例，自动携带 JWT 令牌。
 */
import axios from 'axios';
import { showMaintenanceOverlay, reportNetworkFailure } from '../utils/maintenanceGuard';

// 基础路径 /api（开发环境由 Vite 代理到后端）
const http = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截：401 时跳转登录；503 维护/断线时原地显示遮罩（绝不整页跳转）
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
    // 503 + code=MAINTENANCE：原地盖维护遮罩（见 utils/maintenanceGuard），不整页跳转——
    // 生产环境页面由 nginx 静态托管，跳 '/' 拿到的仍是 SPA，路由弹回 /chat 形成无限刷新乒乓。
    if (err.response?.status === 503 && err.response?.data?.code === 'MAINTENANCE') {
      showMaintenanceOverlay();
    } else if (!err.response) {
      // 网络层失败（cutover 窗口 ECONNREFUSED 等）：连续达阈值后显示断线遮罩并轮询
      reportNetworkFailure();
    }
    return Promise.reject(err);
  },
);

/// 认证接口：登录只走 QQ 互联，无用户名+密码接口
export const authApi = {};

/// 用户接口
export const userApi = {
  me: () => http.get('/users/me'),
  updateNickname: (nickname) => http.post('/users/nickname', { nickname }),
  getFavorites: () => http.get('/users/favorite-commands'),
  // 全量覆盖我的常用指令列表
  setFavorites: (commands) => http.post('/users/favorite-commands', { commands }),
};

/// 聊天接口（世界频道公屏 + 世界红包）
export const chatApi = {
  getMessages: (channelId = 1, limit = 50) =>
    http.get('/chat/messages', { params: { channelId, limit } }),
  getChannel: () => http.get('/chat/channel'),
  // 获取可@提及的玩家列表（含在线状态，在线优先排序）
  getPlayers: () => http.get('/chat/players'),
  // 发红包可选道具清单（读当前玩家背包，已排除装备/硬通货）
  getRedPacketItems: () => http.get('/chat/redpacket/items'),
  // 查询红包状态列表（不传 ids 返回时间窗内最近红包；传 ids 按ID批量查询）
  getRedPackets: (ids) =>
    http.get('/chat/redpackets', { params: ids?.length ? { ids: ids.join(',') } : {} }),
  // 发送世界红包（发送即扣除背包道具）
  createRedPacket: (payload) => http.post('/chat/redpacket', payload),
  // 领取世界红包（先到先得，每人限领1份；口令红包需带 passcode）
  claimRedPacket: (id, passcode) =>
    http.post(`/chat/redpacket/${id}/claim`, passcode ? { passcode } : {}),
  // 我的红包：发出的 / 领到的 / 过期退回明细
  getMyRedPackets: () => http.get('/chat/redpacket/mine'),
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
  create: (data) => http.post('/feedback', data),
  mine: () => http.get('/feedback/mine'),
  // 工单详情（含完整消息）
  detail: (id) => http.get(`/feedback/${id}`),
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
  playerInfo: () => http.get('/game/player/info'),
  // 增益定义清单（状态面板悬浮提示用：名称/描述/时长/属性加成）
  buffDefinitions: () => http.get('/game/buff-definitions'),
  mapConnections: () => http.get('/game/map/connections'),
  // 地图总览（当前区域 + 全部地图）
  mapOverview: () => http.get('/game/map/overview'),
  // 当前区域附近玩家列表（同一地图，含在线状态）
  nearbyPlayers: () => http.get('/game/map/nearby-players'),
  quickAction: (action) => http.post('/game/player/action', { action }),
  // 玩家自助清除自己的游戏数据(等同管理员GM清除，保留账号，重置为未开始游玩)
  resetMyData: () => http.post('/game/player/reset-data'),
  // 超管特权：立即完成自己的延时读条（静默通道，不进聊天流；服务端校验 ADMIN/SUPER_ADMIN）
  finishNow: () => http.post('/game/admin/finish-now'),
  // 获取服务器在线统计（总玩家数、在线人数）
  stats: () => http.get('/game/stats'),
  // 每日抽奖状态（剩余次数/凭证持有/奖池预览）
  lotteryStatus: () => http.get('/game/lottery/status'),
  // 执行一次抽奖（消耗凭证，中奖自动入包；每天 0 点重置次数）
  lotteryDraw: () => http.post('/game/lottery/draw'),
};

/// 使魔契约（新手引导）
export const familiarApi = {
  // 引导页数据：可选使魔全量清单（角色/专精/难度/优点/特性/技能）+ 是否需要选择
  gate: () => http.get('/game/familiar/gate'),
  // 建立契约（首次选择使魔）：等价于文本渠道「选择使魔确认<名称>」
  choose: (name) => http.post('/game/familiar/choose', { name }),
};

/// 家园接口
export const homeApi = {
  // 家园总览（只读预览 DTO：不推进观测时间、不领取产出，随便看不影响 QQ 端结算）
  overview: () => http.get('/game/home/overview'),
  // 家园院子格子视图（地块/仓库/障碍/存放地，只读不结算；写操作统一走 commandApi.execute）
  yard: () => http.get('/game/home/yard'),
  // 家园清障排队（挖土/割草连点）：写入服务端 markers 队列，刷新/重启不丢
  enqueueClear: (cmd, count = 1) => http.post('/game/home/enqueue-clear', { cmd, count }),
  // 超管：跳过整条清障队列（进行中+已排队全部立即结算，静默）
  finishClear: () => http.post('/game/home/finish-clear'),
  // 队列有货且无读条时主动接龙（刷新后空转救援）
  drainClear: () => http.post('/game/home/drain-clear'),
  // 家园前线面板视图（防御/火力/敌人/库存，只读不结算）
  frontline: () => http.get('/game/home/frontline'),
};

/// 使魔竞技场（镜像天梯）只读接口。
/// 约定：这里一个写接口都没有——提交镜像 / 挑战 / 佩戴头像框全部走 commandApi.execute，
/// 与 QQ 端逐字相同的指令文本，保证「机器人 / 网页 / API」共用同一条写路径与同一套门槛。
export const arenaApi = {
  // 赛季概况 + 我的天梯状态 + 竞技场门槛配置（面板首屏，只读）
  overview: () => http.get('/game/arena/overview'),
  // 天梯榜分页（镜像为冻结快照，含快照等级/战斗力/版本与提交时刻）；q 为按主人名的模糊过滤
  ladder: (page = 1, q = '') => http.get('/game/arena/ladder', { params: q ? { page, q } : { page } }),
  // 侦察榜单某名次的镜像：与指令「竞技场 序号」同一份情报，只是换成结构化方便排版
  scout: (rank) => http.get(`/game/arena/mirror/${encodeURIComponent(rank)}`),
  // 我的战绩分页（结构化行，前端不再解析指令文本）
  matches: (page = 1) => http.get('/game/arena/matches', { params: { page } }),
  // 单份完整战报（lines 正文 + actionLog 逐回合明细，仅参战双方可读）
  report: (id) => http.get(`/game/arena/report/${id}`),
  // 我的头像框（拥有列表 + 佩戴中键）与当前生效特权
  frames: () => http.get('/game/arena/frames'),
  // 当前赛季奖励配置（名次档 → 称号/头像框/特权/资源，对玩家公示「后台可改」这件事）
  seasonRewards: () => http.get('/game/arena/season-rewards'),
};

/// 系统/版本接口
export const systemApi = {
  // 获取部署版本信息与更新检测配置（用于检测部署完成、弹窗提示更新日志）
  getVersion: () => http.get('/system/version'),
  // 获取服务器当前时间(毫秒时间戳)，用于测算本机与服务器的时钟偏移
  getServerTime: () => http.get('/system/server-time'),
  // 获取网页前端可调配置（公开接口；如背包图鉴悬浮延迟 web.handbookTooltipDelayMs）
  getWebConfig: () => http.get('/system/web-config'),
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
  // 用户管理：重置家园(进度/家园名/动态图归零，等级背包不动)
  resetUserHome: (id) => http.post('/admin/users/reset-home', { id }),
  batchResetUserHome: (ids) => http.post('/admin/users/batch-reset-home', { ids }),
  resetAllUserHomes: () => http.post('/admin/users/reset-all-homes'),
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
  // 系统配置：导出全部配置（含 type/group/label 元数据）
  exportConfig: () => http.get('/admin/config/export'),
  // 系统配置：导入配置包（mode=merge|replace；dryRun=true 只预览不落库）
  importConfig: (payload, mode = 'merge', dryRun = false) =>
    http.post('/admin/config/import', { payload, mode, dryRun }),
  // 服务器仪表盘
  dashboard: () => http.get('/admin/dashboard'),
  // GM 工具：可发放物品目录(物品+装备名称列表，供背包管理选择器)
  gmCatalog: () => http.get('/admin/gm/catalog'),
  // GM 工具：读取玩家背包(解析全部物品)
  getBackpack: (userId) => http.get('/admin/gm/backpack', { params: { userId } }),
  // GM 工具：保存玩家背包(编辑数量/增删)
  saveBackpack: (data) => http.post('/admin/gm/backpack/save', data),
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
  // 数据管理：静态游戏数据分类列表(含条目数/展示列/新增模板)
  gameDataCategories: () => http.get('/admin/gamedata'),
  // 数据管理：某分类全部条目(整包返回，前端本地过滤)
  gameDataEntries: (key) => http.get(`/admin/gamedata/${key}`),
  // 数据管理：新增条目
  createGameData: (key, data) => http.post(`/admin/gamedata/${key}`, { data }),
  // 数据管理：更新条目(按下标，expectName 乐观校验)
  updateGameData: (key, index, data, expectName) =>
    http.put(`/admin/gamedata/${key}/${index}`, { data, expectName }),
  // 数据管理：删除条目(按下标，expectName 乐观校验)
  deleteGameData: (key, index, expectName) =>
    http.delete(`/admin/gamedata/${key}/${index}`, { params: { expectName } }),
  // 后台日志：列出可读日志文件(名称/大小/修改时间)
  logFiles: () => http.get('/admin/logs/files'),
  // 后台日志：读取尾部/增量(file/lines/keyword/level/since，只读)
  logTail: (params) => http.get('/admin/logs/tail', { params }),
};

/// 竞技场管理接口（ADMIN/SUPER_ADMIN；权限由服务端守卫把关，前端只控制入口显隐）
export const adminArenaApi = {
  // 竞技场概况（赛季 / 镜像数 / 参战人数 / 场次数，不传我的天梯状态）
  overview: () => http.get('/admin/arena/overview'),
  // 天梯榜（后台审计用，可放大页容量 size）
  ladder: (params) => http.get('/admin/arena/ladder', { params }),
  // 当前赛季奖励配置（已归一化，与玩家侧公示同源）
  seasonRewards: () => http.get('/admin/arena/season-rewards'),
  // 某特权的在册持有者（默认 batchGather；回包 defs 供授予下拉用）
  privileges: (key) => http.get('/admin/arena/privileges', { params: key ? { key } : {} }),
  // 立即结算到期赛季（幂等：未到期的赛季不会被发奖）
  settle: () => http.post('/admin/arena/settle'),
  // 改期：把本赛季截止时刻设为「从现在起 days 天后」（days=0 即立刻到期）
  extendSeason: (days) => http.post('/admin/arena/season/extend', { days }),
  // 授予特权（days=0 表示永久，慎用）
  grantPrivilege: (payload) => http.post('/admin/arena/privilege/grant', payload),
  // 撤销特权（立即失效，不等到期）
  revokePrivilege: (payload) => http.post('/admin/arena/privilege/revoke', payload),
};

/// 全服世界事件接口（只读）。领取/管理走统一发指令通道（与 QQ 端逐字相同），不新增写 API。
export const worldApi = {
  getCurrent: () => http.get('/game/world-event/current'),
};

export default http;
