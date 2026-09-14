<!--
  通用物品选择弹窗（ItemPickerModal）
  从游戏物品目录（items.json 物品 + equipments.json 装备，接口 GET /admin/gm/catalog）
  中搜索并选择一个物品。设计为公共组件：任何需要「从全部游戏道具中选择」的场景
  （签到奖励、GM 发放、商店/掉落配置等）都可直接挂载，选择结果通过 select 事件抛出，
  组件自身不持有业务状态，也不关心选中后用来做什么。

  用法：
    <ItemPickerModal v-model:visible="pickerVisible" title="选择奖励物品" @select="onPicked" />
-->
<template>
  <Teleport to="body">
    <div v-if="visible" class="ipm-mask" @click.self="close">
      <div class="ipm-box">
        <!-- 头部：标题 + 条目数 + 关闭 -->
        <div class="ipm-head">
          <h3>{{ title }}</h3>
          <span class="ipm-count">{{ filtered.length }} 项</span>
          <button class="ipm-close" type="button" title="关闭" @click="close">×</button>
        </div>

        <!-- 搜索框：打开时自动聚焦，支持名称模糊匹配 -->
        <div class="ipm-search">
          <span class="ipm-search-icon">⌕</span>
          <input ref="searchRef" v-model="keyword" type="text" placeholder="搜索物品/装备名称…" />
        </div>

        <!-- 目录列表：色点区分类型（紫=物品 / 粉=装备 / 青=资源），点击即选中 -->
        <div class="ipm-list">
          <div
            v-for="it in filtered"
            :key="it.category + it.name"
            class="ipm-item"
            @click="pick(it)"
          >
            <span class="ipm-dot" :class="typeClass(it.category)"></span>
            <span class="ipm-name" :title="it.name">{{ it.name }}</span>
            <span class="ipm-cat">{{ it.category }}</span>
          </div>
          <div v-if="!filtered.length" class="ipm-empty">
            <template v-if="loading">物品目录加载中…</template>
            <template v-else-if="loadError">目录加载失败：{{ loadError }}（关闭后重开可重试）</template>
            <template v-else>没有匹配的物品<span>换个关键词试试</span></template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 物品目录懒加载 + 跨挂载点共享：
 * 目录数据全服一致且只读，用模块级缓存保证多个挂载点（签到奖励、GM 发放…）
 * 只发一次请求；请求失败时清空 Promise 允许下次重开重试。
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { adminApi } from '../api';

const props = defineProps({
  /** 是否显示弹窗（配合 v-model:visible 使用） */
  visible: { type: Boolean, default: false },
  /** 弹窗标题（按业务场景自定义，如「选择奖励物品」） */
  title: { type: String, default: '选择物品' },
});

const emit = defineEmits(['update:visible', 'select']);

/** 模块级目录缓存（跨组件实例共享一次请求结果） */
let catalogCache = null;
let catalogPromise = null;

const keyword = ref('');
const loading = ref(false);
const loadError = ref('');
const catalog = ref([]);
const searchRef = ref(null);

/** 关键词过滤后的目录（大小写不敏感的名称包含匹配） */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return catalog.value;
  return catalog.value.filter((i) => String(i.name).toLowerCase().includes(kw));
});

/** 懒加载目录：有缓存直接用；否则请求一次并落缓存 */
async function ensureCatalog() {
  if (catalog.value.length) return;
  if (catalogCache) {
    catalog.value = catalogCache;
    return;
  }
  if (!catalogPromise) {
    loading.value = true;
    catalogPromise = adminApi
      .gmCatalog()
      .then((res) => {
        // 响应拦截器已解包为响应体；兼容 { items } 与 { data: { items } } 两种返回形态
        const items = res?.items || res?.data?.items || [];
        catalogCache = items;
        catalog.value = items;
      })
      .catch((e) => {
        loadError.value = e?.response?.data?.message || e?.message || '未知错误';
        catalogPromise = null; // 失败不缓存 Promise，下次打开可重试
      })
      .finally(() => {
        loading.value = false;
      });
  }
  await catalogPromise;
}

// 打开时重置搜索态、拉目录并聚焦搜索框
watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    keyword.value = '';
    loadError.value = '';
    ensureCatalog();
    nextTick(() => searchRef.value?.focus());
  },
);

function close() {
  emit('update:visible', false);
}

/** 选中一个物品：把 { name, category } 抛给业务方，由业务方决定回填到哪 */
function pick(it) {
  emit('select', { name: it.name, category: it.category });
  close();
}

/** 类型色点类名：紫=物品，粉=装备，青=资源（与背包管理目录视觉一致） */
function typeClass(t) {
  if (t === '装备') return 'equip';
  if (t === '资源') return 'res';
  return '';
}

/** Esc 快捷关闭 */
function onKeydown(e) {
  if (e.key === 'Escape') close();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<style scoped>
/* ===== 遮罩与弹窗容器（对齐后台暗紫玻璃拟态） ===== */
.ipm-mask {
  position: fixed;
  inset: 0;
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.ipm-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(460px, calc(100vw - 40px));
  max-height: min(600px, calc(100vh - 60px));
  padding: 16px 18px;
  background: rgba(20, 18, 42, 0.96);
  border: 1px solid var(--border, rgba(139, 92, 246, 0.28));
  border-radius: 16px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
}
/* ===== 头部 ===== */
.ipm-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ipm-head h3 {
  flex: 1;
  font-size: 15px;
  color: var(--text, #eee);
}
.ipm-count {
  font-size: 12px;
  color: var(--muted-dark, #8a86a8);
  font-variant-numeric: tabular-nums;
}
.ipm-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: var(--muted, #b6b2cf);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.18s ease;
}
.ipm-close:hover {
  color: #f87171;
  background: rgba(248, 113, 113, 0.1);
  border-color: rgba(248, 113, 113, 0.3);
}
/* ===== 搜索框 ===== */
.ipm-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: rgba(10, 10, 26, 0.7);
  border: 1px solid var(--border, rgba(139, 92, 246, 0.28));
  border-radius: 10px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.ipm-search:focus-within {
  border-color: var(--accent, #8b5cf6);
  box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
}
.ipm-search-icon {
  color: var(--muted-dark, #8a86a8);
  font-size: 14px;
}
.ipm-search input {
  flex: 1;
  min-width: 0;
  padding: 9px 0;
  font-size: 13px;
  color: var(--text, #eee);
  background: transparent;
  border: none;
  outline: none;
}
.ipm-search input::placeholder {
  color: var(--muted-dark, #8a86a8);
}
/* ===== 目录列表：独立滚动 ===== */
.ipm-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  padding: 4px 2px 4px 0;
  scrollbar-width: thin;
  scrollbar-color: var(--border, rgba(139, 92, 246, 0.28)) transparent;
}
.ipm-list::-webkit-scrollbar {
  width: 8px;
}
.ipm-list::-webkit-scrollbar-thumb {
  background: var(--border, rgba(139, 92, 246, 0.28));
  border-radius: 4px;
}
.ipm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.ipm-item:hover,
.ipm-item:focus-within {
  background: rgba(139, 92, 246, 0.1);
  border-color: rgba(139, 92, 246, 0.25);
}
.ipm-dot {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #a78bfa; /* 物品：紫 */
  box-shadow: 0 0 6px rgba(167, 139, 250, 0.6);
}
.ipm-dot.equip {
  background: #f472b6; /* 装备：粉 */
  box-shadow: 0 0 6px rgba(244, 114, 182, 0.6);
}
.ipm-dot.res {
  background: #22d3ee; /* 资源：青 */
  box-shadow: 0 0 6px rgba(34, 211, 238, 0.6);
}
.ipm-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text, #eee);
}
.ipm-cat {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted-dark, #8a86a8);
}
/* ===== 空状态 ===== */
.ipm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 30px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted-dark, #8a86a8);
}
.ipm-empty span {
  font-size: 11.5px;
  opacity: 0.8;
}
</style>
