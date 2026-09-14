/**
 * 全局配置模块
 * 遵循"配置项抽取"原则：所有可能调整的端口、密钥、超时、URL、开关等均集中在此，
 * 可通过环境变量(.env)覆盖，避免修改代码。
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * 全局配置单例类
 * 集中管理服务运行所需的全部可配置参数，供各模块读取。
 */
export class GlobalConfig {
  private static instance: GlobalConfig;

  /** 服务监听端口 */
  public readonly port: number;

  /** CORS 允许的来源（前端地址列表） */
  public readonly corsOrigins: string[];

  /** JWT 签名密钥（生产环境必须通过环境变量覆盖） */
  public readonly jwtSecret: string;

  /** JWT 访问令牌有效期（秒），默认 7 天；令牌不随请求续期，到期须重新登录 */
  public readonly jwtExpiresIn: number;

  /** 数据库连接串（MySQL，由 .env 的 DATABASE_URL 决定） */
  public readonly databaseUrl: string;

  /** AstrBot 对接：允许的机器人在线注册码 / 校验 Token */
  public readonly botAccessToken: string;

  /** 反馈/私聊附件上传目录（相对服务根目录，由代码启动时自动创建） */
  public readonly uploadDir: string;

  /** 单个附件大小上限（字节），默认 10MB */
  public readonly uploadMaxSize: number;

  /** 上传附件的 URL 前缀（供前端拼接访问地址） */
  public readonly uploadUrlPrefix: string;

  /** 每条消息最多可携带的附件数量（默认 5） */
  public readonly maxAttachments: number;

  /**
   * 「在线玩家」展示配置（网页左下角状态栏：悬停「在线」看名单 + 上下线提示）
   * 条数上限做成配置项，避免大服一次广播带出超大名单。
   */
  public readonly presence = {
    /** 单次返回/广播的在线玩家名单条数上限（前端只展示前 N 个，其余折算为"还有 X 人"） */
    onlineListLimit: Number(process.env.PRESENCE_ONLINE_LIST_LIMIT || 10),
    /**
     * 在线玩家「显示名」缓存时长（毫秒），默认 60 秒。
     *
     * 缓存的是「userId → 显示名」映射，不是最终名单：名单每次按当前在线 ids 实时组装，
     * 所以谁上线/离线都立刻生效；缓存只把"上下线时全量查库"降级为"为新出现的 id 增量查库"。
     * TTL 决定名字新鲜度（玩家改名后最迟该时长生效），设为 0 表示关闭缓存。
     */
    onlineListCacheTtlMs: Number(process.env.PRESENCE_ONLINE_LIST_CACHE_TTL_MS || 60000),
  };

  /** 玩家默认属性（游戏数值配置示例，未来可迁移到数据库） */
  public readonly playerDefaults = {
    maxLevel: 100,
    baseHp: 100,
    baseAttack: 10,
    expPerLevel: 100,
    cooldownSeconds: 5,
  };

  private constructor() {
    this.port = Number(process.env.PORT || 3333);
    this.jwtSecret = process.env.JWT_SECRET || 'dev_secret_change_me';
    // 默认 7 天（604800 秒）：登录态在 localStorage 中持久保存，延长令牌有效期以避免玩家
    // 每日被踢回登录页。注意 jsonwebtoken 对 number 类型按「秒」解析。
    this.jwtExpiresIn = Number(process.env.JWT_EXPIRES_IN || 604800);
    this.databaseUrl =
      process.env.DATABASE_URL ||
      'mysql://root:root@localhost:3306/smdz?charset=utf8mb4'; // MySQL 数据库（本地开发回退）
    this.botAccessToken = process.env.BOT_ACCESS_TOKEN || 'astrbot_web_secret';
    // 指令前缀/是否强制前缀 已收敛到系统配置中心(SystemConfig 表 command.prefixes / command.requirePrefix)，
    // 不再在 .env 中冗余配置，避免双数据源不一致。
    // 附件上传目录（相对服务根目录），由启动时自动创建；可通过环境变量覆盖
    this.uploadDir = process.env.UPLOAD_DIR || 'uploads';
    // 单个附件大小上限（字节），默认 10MB
    this.uploadMaxSize = Number(process.env.UPLOAD_MAX_SIZE || 10 * 1024 * 1024);
    // 上传附件的 URL 前缀，用于前端拼接访问地址
    this.uploadUrlPrefix = process.env.UPLOAD_URL_PREFIX || '/uploads';
    // 每条消息最多可携带的附件数量
    this.maxAttachments = Number(process.env.MAX_ATTACHMENTS || 5);
    // CORS 白名单：默认允许本地开发端口与常见前端端口
    this.corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:8080')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 获取全局配置单例 */
  public static getInstance(): GlobalConfig {
    if (!GlobalConfig.instance) {
      GlobalConfig.instance = new GlobalConfig();
    }
    return GlobalConfig.instance;
  }
}
