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

  /** SQLite 数据库文件路径 */
  public readonly databaseUrl: string;

  /** AstrBot 对接：允许的机器人在线注册码 / 校验 Token */
  public readonly botAccessToken: string;

  /** 指令前缀列表：以这些前缀开头的输入视为指令 */
  public readonly commandPrefixes: string[];

  /** 是否必须带前缀才当作指令。false 时无前缀的输入也尝试作为指令处理 */
  public readonly commandRequirePrefix: boolean;

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
    // 指令前缀：逗号分隔，默认支持 / ! ！；设为空字符串则视为仅使用无前缀指令
    this.commandPrefixes = (process.env.COMMAND_PREFIXES || '/,! ！')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // 是否必须带前缀才是指令
    this.commandRequirePrefix = (process.env.COMMAND_REQUIRE_PREFIX || 'false') !== 'false';
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
