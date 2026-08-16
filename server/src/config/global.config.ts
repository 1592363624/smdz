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

  /** JWT 访问令牌有效期（秒） */
  public readonly jwtExpiresIn: number;

  /** 数据库连接串（MySQL 或 SQLite，由 .env 的 DATABASE_URL 决定） */
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
    this.jwtExpiresIn = Number(process.env.JWT_EXPIRES_IN || 86400); // 默认 24 小时
    this.databaseUrl =
      process.env.DATABASE_URL ||
      'file:../prisma/dev.db'; // SQLite 数据库文件
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
