/**
 * 指令处理器注册表：集中登记所有 CommandHandler，key 与数据库 Command.handlerKey 对应。
 * 新增指令时：1) 在此导入并加入 handlerProviders 2) 在数据库 Command 表插入对应记录
 */
import { CommandHandler } from '../interfaces/command.interface';
import { HelpHandler } from './help.handler';
import { InfoHandler } from './info.handler';
import { InventoryHandler } from './inventory.handler';
import { AttackHandler } from './attack.handler';
import { MapHandler } from './map.handler';
import { StatusHandler } from './status.handler';
import { EquipHandler } from './equip.handler';
import { UnequipHandler } from './unequip.handler';
import { UseHandler } from './use.handler';
import { SkillHandler } from './skill.handler';
import { RescueHandler } from './rescue.handler';
import { TalkHandler } from './talk.handler';
import { TeleportHandler } from './teleport.handler';
import { HomeHandler } from './home.handler';
import { GatherHandler } from './gather.handler';
import { GameCommandHandler } from './game-command.handler';
import { LotteryCommandHandler } from './lottery-command.handler';
import { WorldEventHandler } from './world-event.handler';
import { ArenaHandler } from './arena.handler';

/// 指令处理器类列表（供 Nest 注册为 provider）
export const handlerProviders = [
  HelpHandler,
  InfoHandler,
  InventoryHandler,
  AttackHandler,
  MapHandler,
  StatusHandler,
  EquipHandler,
  UnequipHandler,
  UseHandler,
  SkillHandler,
  RescueHandler,
  TalkHandler,
  TeleportHandler,
  HomeHandler,
  GameCommandHandler,
  LotteryCommandHandler,
  GatherHandler,
  WorldEventHandler,
  ArenaHandler,
];

/// 组装 key -> 处理器实例 的映射
export function buildHandlerMap(instances: CommandHandler[]): Record<string, CommandHandler> {
  const map: Record<string, CommandHandler> = {};
  for (const instance of instances) {
    map[instance.key] = instance;
  }
  return map;
}