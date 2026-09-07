/**
 * 服务注入 token（字符串别名）。
 *
 * PlayerService 需要在创建玩家时调用 ItemSystemService 的"生成装备"路径来发放
 * 初始武器，但 ItemSystemService → PlayerService 已有依赖，若再让 PlayerService
 * 直接 import ItemSystemService 会形成运行时模块循环加载（CommonJS 下类引用
 * 变 undefined，破坏 Nest DI 元数据）。故用字符串 token 别名解耦：
 * GameModule 中注册 `{ provide: ITEM_SYSTEM_SERVICE, useExisting: ItemSystemService }`。
 */
export const ITEM_SYSTEM_SERVICE = 'ITEM_SYSTEM_SERVICE';

/**
 * CombatSystemService 的字符串 token 别名。
 *
 * ItemService 的三池回复（奶/瓶装奶）需要「计算后属性.护盾」（含装备加成）作基数，
 * 但 CombatSystemService → ItemService（petItemService）已有依赖；若 ItemService 再
 * 直接 import CombatSystemService，会翻转 item.service → combat-system → familiar-skills
 * 的 CommonJS 模块初始化顺序，familiar-skills 顶部 `ItemSystemService.AFFIX_TO_BONUS`
 * 静态初始化会读到半初始化模块（test/item-primitives.spec.ts 实证崩溃）。
 * 故同 ITEM_SYSTEM_SERVICE 惯例：字符串 token + GameModule useExisting 别名解耦。
 */
export const COMBAT_SYSTEM_SERVICE = 'COMBAT_SYSTEM_SERVICE';
