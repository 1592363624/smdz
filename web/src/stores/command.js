/**
 * 指令列表状态（Pinia）
 * 接管原本散落在 ChatView 的 commands（全量指令列表：名称/描述/别名/参数 schema）。
 * 提供统一加载动作，供命令面板、自动补全、消息高亮、参数校验等共享，避免各视图各自拉取。
 */
import { defineStore } from 'pinia';
import { commandApi } from '../api';

export const useCommandStore = defineStore('command', {
  state: () => ({
    /** 指令列表：[{ name, description, alias, argsSchema }] */
    commands: [],
  }),
  getters: {
    /** 按指令名查找（参数校验 / 点击发送时用） */
    byName: (state) => (name) =>
      state.commands.find((c) => c.name === name) || null,
  },
  actions: {
    setCommands(list) {
      this.commands = Array.isArray(list) ? list : [];
    },
    /** 从后端拉取指令列表并写入 store */
    async loadCommands() {
      const res = await commandApi.list();
      const list = res?.data ?? res ?? [];
      this.setCommands(list);
      return this.commands;
    },
  },
});
