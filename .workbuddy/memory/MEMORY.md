# 使魔大战3 · 项目长期笔记

## 项目定位
易语言原版《使魔大战》的复刻重制。文字指令式 MUD/放置 RPG（聊天框输入指令游戏），QQ 机器人 + Web 双端。技术栈 NestJS + TS + Prisma + MySQL 8，前端 Vue + Vite。

## 关键工程事实
- 内容数据：`server/prisma/data/*.json`（25 文件约 1.6MB），运行时 static-data.service.ts 懒加载+内存缓存；经 seed.ts 落库
- Prisma schema 509 行 16 模型；Player 单模型 91 行，含 14 个 JSON 字段（backpack/equipment/weapons/markers/buffs/tasks/titles 等）——继承原版内存结构的「宽 JSON 文档」模式
- 写入一致性：player-mutate.service.ts 持 `PlayerService.enqueueUserWrite` 用户级串行锁 + Player.version 乐观锁；只读指令不落库
- game 模块 53,795 行；game.service.ts 15,222 行（220 async 方法）、combat-system.service.ts 10,949 行——God Service，待按指令域拆分
- 升级公式在 bonus.service.ts:405：`(等级²+5)×(1+加成/100)×(1-减益/100)`，累计经验 ≈ N³/3 + 5N
- 原版需求基线：根目录 `原版玩法功能模块列表.md`（529 行，16 模块 + 137 指令）；复刻以该文件为边界
- 指令路由覆盖原版 16 模块全部（game-command.handler.ts），玩法广度达标

## 已知核心问题（2026-09-02 评审结论）
- **数据级 P0**：等级字段全线失效（monsters/maps/craftings/tasks level 全为 1、equipments 无 level）；地精系列经验崩坏（HP 8→12500）；心魔经验倒挂（4e6 HP→66）；主线断链（主线-逃跑缺失）；分解神兽蛋 500 倍套利；7 种怪物掉落未定义（含数据核心）
- **系统空壳**：称号 140 条 bonus/requirements/rewards 全空（硬编码于 familiar-system.service.ts:3975~4119）；副本 27 图仅 9 图配置、4 件挑战道具无来源无用途
- **内容空洞**：教程(HP30)→进阶(HP50000) 1,666 倍难度真空；强壮种子 12 件无来源但 15 条采集指令已配置
- 完整结论与修复建议见 `docs/review/`（00-03 四份报告）

## 用户偏好
- 结论先行、结构清晰、表格呈现；中文回复；直接推理不模糊措辞
- 协作式推进：Write/Edit 前确认落盘位置（如评审报告确认落在 docs/review/）
- 已建立团队评审流程：成员用 Agent ID（design-strategist/engineering-lead/quality-lead）spawn；注意 subagent_type 传成员 ID 会缺 Bash 工具，需用 general-purpose；并发多 agent 易撞 429 限流，失败后重派即可
