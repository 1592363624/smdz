<template>
  <!-- 命令面板（Cmd/Ctrl+K）：桌面端居中弹窗，移动端全屏 -->
  <transition name="palette-fade">
    <div
      v-if="ui.paletteOpen"
      class="palette-mask"
      @click.self="close"
    >
      <div class="palette" role="dialog" aria-modal="true" aria-label="指令面板">
        <div class="palette-input-wrap">
          <span class="palette-search-icon" aria-hidden="true">🔎</span>
          <input
            ref="inputEl"
            v-model="q"
            class="palette-input"
            type="text"
            :placeholder="placeholder"
            autocomplete="off"
            spellcheck="false"
            aria-label="搜索指令"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="choose()"
            @keydown.esc.prevent="close"
          />
          <kbd class="palette-kbd" aria-hidden="true">ESC</kbd>
        </div>

        <div class="palette-list" ref="listEl">
          <button
            v-for="(item, i) in results"
            :key="item.name"
            class="palette-item"
            :class="{ active: i === active }"
            @mouseenter="active = i"
            @click="choose(item)"
          >
            <span class="palette-item-name">{{ item.name }}</span>
            <span class="palette-item-desc">{{ item.description }}</span>
            <span v-if="item.alias" class="palette-item-alias">别名 {{ item.alias }}</span>
          </button>
          <div v-if="!results.length" class="palette-empty">
            {{ q ? '未匹配到指令' : '暂无可用指令' }}
          </div>
        </div>

        <div class="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 发送 / 填入</span>
          <span class="palette-foot-hint">共 {{ commands.length }} 条指令</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/ui';

const props = defineProps({
  /** 指令列表：[{ name, description, alias, argsSchema }] */
  commands: { type: Array, default: () => [] },
  /** 输入占位符 */
  placeholder: { type: String, default: '搜索指令，回车发送（无参指令直接发送，有参指令填入输入框）' },
});

const emit = defineEmits(['select']);

const ui = useUiStore();
const q = ref('');
const active = ref(0);
const inputEl = ref(null);
const listEl = ref(null);

/** 根据关键词过滤指令（名称/描述/别名） */
const results = computed(() => {
  const list = props.commands || [];
  const kw = q.value.trim().toLowerCase();
  if (!kw) return list.slice(0, 50);
  return list
    .filter((c) => {
      const hay = [c.name, c.description, c.alias]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(kw);
    })
    .slice(0, 50);
});

// 关键词变化后重置高亮项，避免越界
watch(q, () => {
  active.value = 0;
});

// 面板打开时自动聚焦输入框
watch(
  () => ui.paletteOpen,
  (open) => {
    if (open) {
      q.value = '';
      active.value = 0;
      nextTick(() => inputEl.value?.focus());
    }
  }
);

/** 方向键移动高亮 */
function move(dir) {
  const n = results.value.length;
  if (!n) return;
  active.value = (active.value + dir + n) % n;
  scrollActiveIntoView();
}

function scrollActiveIntoView() {
  nextTick(() => {
    const el = listEl.value?.querySelector('.palette-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  });
}

/** 选中当前项：发出 select 事件并关闭面板 */
function choose(item) {
  const target = item || results.value[active.value];
  if (!target) return;
  emit('select', target.name);
  close();
}

function close() {
  ui.closePalette();
}

/** 全局快捷键：Cmd/Ctrl+K 切换面板 */
function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    ui.togglePalette();
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.palette-mask {
  position: fixed;
  inset: 0;
  z-index: 9997;
  background: rgba(5, 5, 16, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
}
.palette {
  width: min(560px, 92vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: rgba(20, 16, 42, 0.96);
  border: 1px solid var(--glass-border, rgba(139, 92, 246, 0.25));
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.palette-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--glass-border, rgba(139, 92, 246, 0.18));
}
.palette-search-icon {
  font-size: 15px;
  opacity: 0.7;
}
.palette-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text, #f1f1f9);
  font-size: 15px;
}
.palette-input::placeholder {
  color: var(--muted-dark, #6b6b8a);
}
.palette-kbd {
  font-size: 10px;
  color: var(--muted, #a0a0c0);
  border: 1px solid var(--glass-border, rgba(139, 92, 246, 0.25));
  border-radius: 5px;
  padding: 1px 6px;
  background: rgba(0, 0, 0, 0.2);
}
.palette-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.palette-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  color: var(--text, #f1f1f9);
  transition: background 0.12s ease;
}
.palette-item.active {
  background: rgba(139, 92, 246, 0.16);
  box-shadow: inset 0 0 0 1px rgba(139, 92, 246, 0.3);
}
.palette-item-name {
  font-weight: 700;
  color: var(--accent2, #06b6d4);
  font-size: 14px;
  flex-shrink: 0;
}
.palette-item-desc {
  flex: 1;
  min-width: 0;
  color: var(--muted, #a0a0c0);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette-item-alias {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted-dark, #6b6b8a);
}
.palette-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--muted-dark, #6b6b8a);
  font-size: 13px;
}
.palette-foot {
  display: flex;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid var(--glass-border, rgba(139, 92, 246, 0.18));
  font-size: 11px;
  color: var(--muted, #a0a0c0);
}
.palette-foot kbd {
  font-size: 10px;
  border: 1px solid var(--glass-border, rgba(139, 92, 246, 0.25));
  border-radius: 4px;
  padding: 0 5px;
  margin-right: 2px;
  background: rgba(0, 0, 0, 0.2);
}
.palette-foot-hint {
  margin-left: auto;
  color: var(--muted-dark, #6b6b8a);
}

/* 移动端：面板占满全屏，方便拇指操作 */
@media (max-width: 640px) {
  .palette-mask {
    padding-top: 0;
    align-items: stretch;
  }
  .palette {
    width: 100vw;
    max-height: 100vh;
    max-height: 100dvh;
    height: 100%;
    border-radius: 0;
    border: none;
  }
  .palette-input {
    font-size: 16px; /* ≥16px 避免 iOS 聚焦时自动缩放 */
  }
  .palette-foot {
    padding-bottom: calc(8px + var(--safe-bottom, 0px));
  }
}

.palette-fade-enter-active,
.palette-fade-leave-active {
  transition: opacity 0.2s ease;
}
.palette-fade-enter-from,
.palette-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .palette-fade-enter-active,
  .palette-fade-leave-active {
    transition: none;
  }
}
</style>
