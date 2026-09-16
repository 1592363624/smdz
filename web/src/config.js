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
export const APP_VERSION = '0.7.9';

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
 * 指令检索配置（输入框自动补全 / 左侧栏指令搜索 / Ctrl+K 命令面板 / 常用指令候选）
 *
 * 检索范围：指令名、中文别名、拼音全拼（beibao）、拼音首字母（bb）、描述。
 * 所有阈值/权重/条数上限集中在此，调整检索行为无需改动视图代码。
 */
export const COMMAND_SEARCH_CONFIG = {
  /** 是否启用拼音检索（关闭后退化为仅按中文名/别名/描述检索） */
  enablePinyin: true,
  /** 启用「拼音首字母」检索所需的最小输入长度（设为 1 时单字母会命中大量候选，建议 ≥2） */
  minInitialsLen: 2,
  /** 启用「拼音全拼」检索所需的最小输入长度（2 时输入 "da" 即可命中"打坐"） */
  minFullPinyinLen: 2,
  /** 描述参与检索所需的最小输入长度（描述命中最靠后，仅作兜底） */
  minDescriptionLen: 2,
  /**
   * 别名检索模式（别名是给后端指令引擎用的，如 "attack,打,揍"）：
   * - 'chinese'（默认）：只检索含中文的别名（「查看背包」「打」），忽略 attack/lock/pickup 这类英文别名，
   *   否则输入 "ck" 会因为 lock/unlock/pickup/attack 都包含 ck 而命中一堆无关指令；
   * - 'all'：英文别名也参与检索（输入 attack 可命中「攻击」）；
   * - 'none'：完全不检索别名。
   */
  aliasMatch: 'chinese',
  /** 各入口最多展示条数（0 = 不限制） */
  limits: {
    /** 输入框自动补全下拉 */
    autocomplete: 10,
    /** 左侧栏「指令」搜索 */
    sidebar: 0,
    /** Ctrl+K 命令面板 */
    palette: 50,
    /** 「添加常用指令」候选 */
    favoriteCandidate: 30,
  },
  /**
   * 匹配权重（分数越大越靠前）
   * 排序原则：指令名直接命中 > 别名直接命中 > 拼音命中 > 描述兜底；
   * 同分时保持后端返回的 sortOrder 顺序，保证结果稳定不跳动。
   */
  score: {
    /** 指令名：完全相等 / 以输入开头 / 包含输入 */
    nameExact: 1000,
    namePrefix: 900,
    nameContains: 800,
    /** 别名（逗号分隔的每条）：完全相等 / 开头 / 包含 */
    aliasExact: 700,
    aliasPrefix: 660,
    aliasContains: 620,
    /** 指令名拼音全拼：开头 / 包含 */
    namePinyinPrefix: 580,
    namePinyinContains: 540,
    /** 指令名拼音首字母：完全相等 / 开头 / 包含（如 bb 命中"资源背包" zybb） */
    nameInitialsExact: 500,
    nameInitialsPrefix: 460,
    nameInitialsContains: 430,
    /** 中文别名拼音：全拼开头 / 全拼包含 / 首字母相等 / 开头 / 包含 */
    aliasPinyinPrefix: 420,
    aliasPinyinContains: 400,
    aliasInitialsExact: 380,
    aliasInitialsPrefix: 360,
    aliasInitialsContains: 340,
    /** 描述：包含关键词 / 拼音包含（兜底，分数最低） */
    descContains: 200,
    descPinyin: 160,
  },
};

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
  /** 口令最大字符数（与后端 maxPasscodeLength 保持一致） */
  maxPasscodeLength: 16,
  /**
   * 红包玩法选项：value 与后端 packetType 一一对应
   * - NORMAL：谁都能领
   * - TARGET：专属红包，只有指定玩家能领
   * - PASSCODE：口令红包，输入正确口令才能领
   */
  packetTypes: [
    { value: 'NORMAL', label: '普通', icon: '🧧', desc: '谁都能领' },
    { value: 'TARGET', label: '专属', icon: '🎯', desc: '指定人领取' },
    { value: 'PASSCODE', label: '口令', icon: '🔑', desc: '输口令领取' },
  ],
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

/**
 * 家园院子（QQ 农场式格子）前端配置
 *
 * 所有展示口径与指令模板集中在此：改图标、改格子尺寸、改指令写法都不需要动视图代码。
 *
 * 重要约定：本页面的种植/收获/安装/拆除/领取**不新增写接口**，一律通过
 * commandApi.execute 发送与 QQ 端完全相同的文本指令（见 commands 模板），
 * 保证只有一条写路径、结算口径永不双轨。
 */
export const HOME_YARD_CONFIG = {
  /** 地块网格：格子边长区间与间距（px），列数按容器宽度自适应 */
  plot: { minSize: 96, maxSize: 132, gap: 10, maxVisible: 150 },
  /** 院子数据自动刷新间隔（毫秒）；操作后会立即再拉一次 */
  refreshMs: 45000,
  /** 执行指令后重新拉取数据的延迟（毫秒），等后端写完再读 */
  refetchDelayMs: 400,
  /**
   * 地块图标：按名称包含关键词自上而下匹配，首个命中生效；均未命中用 fallbackIcon。
   * 新增作物/建筑时只要往这里补一条规则即可。
   */
  icons: {
    crop: [
      { kw: '椰树', icon: '🌴' },
      { kw: '圣诞树', icon: '🎄' },
      { kw: '苹果', icon: '🍎' },
      { kw: '可可', icon: '🍫' },
      { kw: '钻石树', icon: '💎' },
      { kw: '藤蔓', icon: '🌿' },
      { kw: '云杉', icon: '🌲' },
      { kw: '苍兰', icon: '🌸' },
      { kw: '油瓜', icon: '🍈' },
      { kw: '金龙果', icon: '🍑' },
      { kw: '豆蔻', icon: '🫘' },
      { kw: '水晶', icon: '💠' },
      { kw: '心脏', icon: '🫀' },
      { kw: '猪崽', icon: '🐖' },
      { kw: '收集器', icon: '📡' },
      { kw: '板', icon: '🪧' },
      { kw: '草', icon: '🌾' },
      { kw: '树', icon: '🌳' },
      { kw: '花', icon: '🌷' },
      { kw: '果', icon: '🍒' },
    ],
    building: [
      { kw: '发电', icon: '⚡' },
      { kw: '电站', icon: '⚡' },
      { kw: '星链', icon: '✨' },
      { kw: '星路', icon: '✨' },
      { kw: '裂变', icon: '☢️' },
      { kw: '聚变', icon: '☢️' },
      { kw: '射线', icon: '📶' },
      { kw: '广播塔', icon: '📡' },
      { kw: '钻机', icon: '⛏️' },
      { kw: '采掘', icon: '⛏️' },
      { kw: '熔炉', icon: '🔥' },
      { kw: '锻炉', icon: '🔥' },
      { kw: '油井', icon: '🛢️' },
      { kw: '炼油', icon: '🛢️' },
      { kw: '灌溉', icon: '🚿' },
      { kw: '化肥', icon: '🧪' },
      { kw: '堆肥', icon: '🧪' },
      { kw: '离心', icon: '🧪' },
      { kw: '净水', icon: '💧' },
      { kw: '模拟', icon: '🔮' },
      { kw: '聚焦', icon: '🔆' },
      { kw: '具现', icon: '🌀' },
      { kw: '合成', icon: '🏭' },
      { kw: '组装', icon: '🏭' },
      { kw: '工厂', icon: '🏭' },
      { kw: '打包', icon: '📦' },
      { kw: '回收', icon: '♻️' },
      { kw: '牵引', icon: '🚜' },
      { kw: '核心', icon: '🧠' },
      { kw: '床', icon: '🛏️' },
      { kw: '按摩椅', icon: '💺' },
      { kw: '窝', icon: '🐾' },
      { kw: '兔子', icon: '🐇' },
      { kw: '狐狸', icon: '🦊' },
      { kw: '保险柜', icon: '🗄️' },
      { kw: '碉堡', icon: '🗼' },
      { kw: '榨汁', icon: '🥤' },
      { kw: '导航', icon: '🧭' },
      { kw: '探测', icon: '🔍' },
      { kw: '炼丹', icon: '⚗️' },
      { kw: '育种', icon: '🧬' },
      { kw: '训练器', icon: '🏋️' },
      { kw: '机床', icon: '🔧' },
      { kw: '工作台', icon: '🔧' },
      { kw: '控制台', icon: '🎛️' },
      { kw: '通讯台', icon: '☎️' },
    ],
  },
  /** 图标兜底（作物 / 建筑） */
  fallbackIcon: { crop: '🌱', building: '🏗️' },
  /** 指令模板：与 QQ 端逐字一致 */
  commands: {
    plant: (seedName) => `种植 ${seedName}`,
    harvest: (cropName) => `收获 ${cropName}`,
    install: (buildingName) => `安装 ${buildingName}`,
    remove: (buildingName) => `拆除 ${buildingName}`,
    collect: () => '产出',
    goHome: (houseName) => `前往 ${houseName}`,
    // 凭证：使用后写入「凭证」标记，作物上限 +5、建筑上限 +1（原版每日限一次）
    useVoucher: () => '使用 凭证',
    /** 带数量的批量写法（原版 parseCountedAction 支持「名称+数量」） */
    withCount: (name, count) => `${name}${count}`,
  },
  /**
   * 批量 / 拖拽刷选配置（QQ 农场式操作）
   * - maxPerCommand：单条指令允许携带的最大数量，超出自动拆成多条
   *   （如种 150 棵 → 「种植 种子99」+「种植 种子51」）
   * - drag：刷选判定用的指针移动阈值
   */
  batch: {
    maxPerCommand: 99,
    /** toast 里最多合并展示的执行结果条数（避免刷屏） */
    toastResultLimit: 3,
  },
  /** 文案（集中在便于调整/本地化） */
  texts: {
    notAtHome: '需要站在自己的院子里才能动土，先回家吧',
    emptyCrop: '点一下选种子',
    emptyBuilding: '点一下装建筑',
    pickSeedTitle: '选一颗种子种下',
    pickBuildingTitle: '选一个建筑安装',
    noSeed: '背包里没有可种植的种子',
    noBuilding: '背包里没有可安装的建筑',
    // 批量 / 拖拽刷选
    batchOn: '✥ 批量',
    batchOff: '退出批量',
    batchHint: '开启后可在地块上按住拖动刷选，再一次性种下 / 收获 / 拆除',
    batchEmpty: '批量：点或拖着刷过要操作的地块',
    seedCount: (n) => `种下 ${n} 颗`,
    installCount: (n) => `安装 ${n} 个`,
    harvestCount: (n) => `收获 ${n} 块`,
    removeCount: (n) => `拆除 ${n} 个`,
    overLimit: (free) => `已开垦地块只剩 ${free} 块，超出的作物不参与产出，已自动截断`,
    nothingToHarvest: '地里没有可收获的作物',
  },
};

/**
 * 家园前线面板（FrontlineView）配置。
 *
 * 与后端 `server/src/modules/game/frontline-view.service.ts` 的只读视图一一对应；
 * 本页面的安装 / 拆卸 / 开始战斗 / 前往前线 **不新增写接口**，一律通过
 * commandApi.execute 发送与 QQ 端完全相同的文本指令（见 commands 模板），
 * 保证只有一条写路径、结算口径永不双轨。
 */
export const HOME_FRONTLINE_CONFIG = {
  /** 前线数据自动刷新间隔（毫秒）；操作后会立即再拉一次 */
  refreshMs: 30000,
  /** 执行指令后重新拉取数据的延迟（毫秒），等后端写完再读 */
  refetchDelayMs: 500,
  /** 防御建筑 / 武器 / 敌人的图标兜底与关键词匹配（自上而下首个命中生效） */
  icons: {
    building: [
      { kw: '机枪', icon: '🔫' },
      { kw: '火炮', icon: '💥' },
      { kw: '喷火', icon: '🔥' },
      { kw: '重炮', icon: '🧨' },
      { kw: '碉堡', icon: '🏰' },
    ],
    weapon: [
      { kw: '机枪', icon: '🔫' },
      { kw: '火炮', icon: '💥' },
      { kw: '喷火', icon: '🔥' },
      { kw: '重炮', icon: '🧨' },
      { kw: '火力', icon: '🎯' },
    ],
    enemy: [
      { kw: '将军', icon: '👑' },
      { kw: '千夫长', icon: '🎖️' },
      { kw: '百夫长', icon: '🪖' },
      { kw: '十夫长', icon: '⛑️' },
      { kw: '地精', icon: '👺' },
    ],
  },
  fallbackIcon: { building: '🏗️', weapon: '🎯', enemy: '👾' },
  /** 指令模板：与 QQ 端逐字一致 */
  commands: {
    // 前往前线（需先走到自己家园附近，原版「前往 家园名前线」）
    goFrontline: (houseName) => `前往 ${houseName}前线`,
    install: (buildingName) => `安装 ${buildingName}`,
    remove: (buildingName) => `拆卸 ${buildingName}`,
    startBattle: () => '开始战斗',
    // 查看前线文本状态（家园前线），与 UI 互为印证
    view: () => '家园前线',
  },
  /** 文案（集中在便于调整/本地化） */
  texts: {
    needBuilt: '需要先完成房子的建造，才能开启前线',
    noHouse: '还没有家园',
    needFrontline: '需要站在家园前线才能布防，先前往前线吧',
    atHomeElsewhere: '你不在前线地图上，布防与拆卸需要站在前线',
    frontlineQuiet: '前线平静，没有敌人',
    canBattle: '可以开始战斗',
    hasEnemies: '还有需要解决的敌人，先击败它们',
    startBattleConfirm: '开始战斗会消耗 1 点活跃度，并引来一波地精攻势，确定吗？',
    removeConfirm: (name, count) => `确定把前线的 ${name} ×${count} 拆卸装箱收回背包吗？`,
    installEmpty: '背包里没有可安装的防御建筑（带 攻击 加成的建筑）',
    noFirepower: '火力通道为空，安装防御建筑后会生成对应武器',
    frontlineHint: '防御阵地和地精无视载具伤害上限，攻击无载具目标时一击必杀',
  },
};

/**
 * 家园建造四步引导（圈地 → 开挖地基 → 建造地基 → 建造房子）前端配置
 *
 * 与后端 `server/src/modules/game/home-build-guide.util.ts` 一一对应：后端在四条
 * 建造指令的回包末尾追加引导文本，前端按 headerRegex 识别后渲染成带动画的引导卡片
 * （HomeBuildGuide.vue），QQ 端则直接读同一段纯文本。
 *
 * 重要约定：卡片上的按钮**不新增写接口**，一律发送与 QQ 端逐字相同的指令，
 * 保证只有一条写路径。
 */
export const HOME_BUILD_GUIDE_CONFIG = {
  /**
   * 识别正则：必须与后端 HOME_BUILD_GUIDE_HEADER 输出一致（`🏗️ 家园建造进度 N/4`）。
   * 修改后端前缀时此处必须同步，否则网页端会退化为纯文本展示。
   */
  headerRegex: /\u{1F3D7}\u{FE0F}?\s*家园建造进度\s*(\d)\s*\/\s*4/u,
  /** 总步数（进度值达到即视为建成） */
  total: 4,
  /** 进度 0（尚未圈地）时引导玩家发送的第一条指令 */
  firstCommand: '圈地',
  /** 进度 0 的「圈地」步：全屏引导把它当成第 0 步渲染，CTA 比通用「下一步」更明确 */
  claim: {
    step: 0,
    name: '圈地',
    icon: '🚩',
    headline: '圈下一块属于你的地',
    subtitle: '家园，从一块空地开始',
    tip: '走到地图上你中意的地点，发送「圈地」就能把这块地圈成自己的院子（地点不用太纠结，之后能搬家）',
    cta: '🚀 开始圈地',
  },
  /** 四步定义：图标 / 名称 / 大标题 / 材料清单 / 下一条指令 / 说明 / 该步可用的辅助指令 */
  steps: [
    {
      step: 1,
      name: '圈地',
      icon: '🚩',
      headline: '院子已经圈好了',
      subtitle: '清理地面，才能动土',
      next: '开挖地基',
      tip: '院子里还有土堆和杂草挡着。点清障按钮一次清一块；剩得多就用「一次清完」，倒计时里也能连点排队',
      materials: [],
      cmds: ['挖土', '割草'],
    },
    {
      step: 2,
      name: '开挖地基',
      icon: '⛏️',
      headline: '挖开地基坑',
      subtitle: '清掉障碍，备齐材料',
      next: '建造地基',
      tip: '地基坑出现了，坑边会有多堆土（通常 2 堆）。点「清完」会按剩余次数全部安排；若清完一堆后还有，系统会提示继续挖——不是没挖到。材料备好后发送「建造地基」',
      materials: [
        { icon: '🪵', name: '木头', qty: 80 },
        { icon: '🪨', name: '石头', qty: 120 },
        { icon: '⛏️', name: '铁矿', qty: 40 },
        { icon: '🪢', name: '绳子', qty: 40 },
      ],
      cmds: ['挖土'],
    },
    {
      step: 3,
      name: '建造地基',
      icon: '🧱',
      headline: '地基打好，盖房子',
      subtitle: '最后一关：把小屋立起来',
      next: '建造房子',
      tip: '地基已经完成。备齐下面这些材料，发送「建造房子」，小屋就会拔地而起',
      materials: [
        { icon: '🪵', name: '木头', qty: 300 },
        { icon: '🪨', name: '石头', qty: 500 },
        { icon: '⛏️', name: '铁矿', qty: 160 },
        { icon: '🪢', name: '绳子', qty: 120 },
      ],
      cmds: [],
    },
    {
      step: 4,
      name: '建造房子',
      icon: '🏠',
      headline: '房子开工了！',
      subtitle: '工地正热火朝天',
      next: '',
      tip: '墙体和屋顶正在施工，约 2 分钟后完工。完工前先别急着种地——房子落成后才能种植 / 安装 / 收获',
      materials: [],
      cmds: [],
    },
  ],
  /** 动画节奏（毫秒）与降级开关：系统开启「减少动效」时自动关闭全部动画 */
  animation: {
    enabled: true,
    /** 每一步节点依次入场的间隔 */
    stepDelayMs: 110,
    /** 进度推进时的高亮闪烁时长 */
    flashMs: 1200,
    /** 第 4 步（房子建成）撒花时长 */
    celebrateMs: 6000,
  },
  /**
   * 指令回包后自动跳转家园页：只在指定步（默认圈地成功）触发一次，
   * 让玩家直接在 /home 页面接着清理地面 / 开挖地基。置 enabled=false 即只给按钮不自动跳。
   */
  autoRedirect: { enabled: true, step: 1, delayMs: 1000 },
  texts: {
    title: '家园建造进度',
    openHome: '🏡 打开家园',
    nextCmd: (cmd) => `下一步：发送「${cmd}」`,
    building: '🏗️ 建造中，请稍候',
    startTip: '先去到你中意的地点，然后圈一块地（地点不用太纠结，能搬家）',
    doneTitle: '🎉 家园已建成',
    doneTip: '现在可以安装建筑、种植作物、使用家园产出了',
    notAtHome: '需要先回到自己的院子，点「先回家」或发送「前往 房名」',
    /** 家园写操作门禁提示（建成前点种植/收获/安装/拆除/凭证开垦时） */
    needBuilt: '需要先完成房屋的建造，才能在院子里种植 / 收获 / 安装 / 拆除',
  },
};
