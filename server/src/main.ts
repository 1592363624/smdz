/**
 * 使魔大战3 网页版 - 后端服务入口
 * 负责：创建 Nest 应用实例、加载全局配置、启用 CORS、挂载全局前缀与 Swagger(OpenAPI) 文档。
 */

import './time-zone';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as express from 'express';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { GlobalConfig } from './config/global.config';
import { maintenanceMiddleware } from './maintenance/maintenance.middleware';

async function bootstrap() {
  // 读取启动配置（端口、CORS 白名单等），来自配置文件/环境变量
  const config = GlobalConfig.getInstance();

  // 确保附件上传目录存在（反馈/私聊的图片与文件）
  const uploadDir = join(process.cwd(), config.uploadDir);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
    // eslint-disable-next-line no-console
    console.log(`📁 已创建上传目录: ${uploadDir}`);
  }

  // 预创建 Express 实例并最先挂载维护模式中间件：
  // NestFactory.create 之后再用 app.use() 注册的中间件会排在 Nest 路由与
  // serve-static 之后（只在所有路由 fallthrough 后才执行），无法拦截静态
  // 页面请求；因此必须通过 ExpressAdapter 在应用初始化前预先注册。
  const server = express();
  server.use(maintenanceMiddleware);

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));

  // 全局接口前缀，便于统一路由，如 /api/auth/qq/login
  app.setGlobalPrefix('api');

  // 全局参数校验管道（配合 class-validator 使用）
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 过滤掉 DTO 中未声明的字段
      transform: true, // 自动将请求体转换为 DTO 实例
    }),
  );

  // CORS：允许前端(含开发热更新端口)跨域访问
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  // Swagger / OpenAPI 文档：方便导入 Apifox 等工具调试
  const swaggerConfig = new DocumentBuilder()
    .setTitle('使魔大战3 网页版 API')
    .setDescription('使魔大战3 网页版后端接口文档（OpenAPI 3.0 规范）')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.port;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 服务已启动: http://localhost:${port}/api/docs`);
}

bootstrap();
