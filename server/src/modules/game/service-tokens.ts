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
