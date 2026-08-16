/**
 * 应用根模块
 * 负责汇总所有业务模块，NestJS 通过这里组织整个应用的依赖注入与路由。
 * - 生产模式下，通过 ServeStaticModule 托管前端静态文件（web/dist/）
 * - API 路由统一使用 /api 前缀
 * - 非 /api 和 /ws 的请求回退到 index.html（SPA 路由支持）
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ChatModule } from './modules/chat/chat.module';
import { CommandModule } from './modules/command/command.module';
import { BotModule } from './modules/bot/bot.module';
import { AdminModule } from './modules/admin/admin.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { GameModule } from './modules/game/game.module';
import { GameTasksModule } from './modules/game/game-tasks.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { SystemModule } from './modules/system/system.module';
import { GlobalConfig } from './config/global.config';

@Module({
  imports: [
    // 全局配置模块（读取 .env）
    ConfigModule.forRoot({ isGlobal: true }),
    // 数据访问层
    PrismaModule,
    // 系统配置中心（全局提供）
    SystemConfigModule,
    /**
     * 托管前端静态文件（web/dist/）
     * serveStatic 中间件在 Express 中的优先级低于路由，因此 /api/* 和 /ws/* 的请求会优先由 NestJS 路由处理
     * 非 API 的请求（如 /, /chat, /login 等）会查找 web/dist/ 下对应的静态文件
     * 若找不到文件（SPA 前端路由），serveStatic 会回退到 index.html
     */
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'web', 'dist'),
      exclude: ['/api/(.*)', '/ws/(.*)', '/uploads/(.*)'],
      serveStaticOptions: {
        // SPA 回退：所有未匹配到静态文件的请求都返回 index.html
        // 由前端 Vue Router 接管路由
        fallthrough: true,
      },
    }),
    /**
     * 托管用户上传的附件（反馈/私聊的图片与文件）
     * 通过 UPLOAD_DIR 配置指定目录（默认 uploads/），访问前缀为 /uploads/xxx
     */
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), GlobalConfig.getInstance().uploadDir),
      serveRoot: GlobalConfig.getInstance().uploadUrlPrefix,
    }),
    // 业务模块
    UsersModule,
    AuthModule,
    ChatModule,
    CommandModule,
    BotModule,
    AdminModule,
    GameModule,
    GameTasksModule,
    FeedbackModule,
    SystemModule,
  ],
})
export class AppModule {}
