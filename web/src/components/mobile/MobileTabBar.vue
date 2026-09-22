<template>
  <!--
    手机端底部标签栏：手游的主导航一律在拇指区，不放汉堡菜单。
    五个入口 = 公屏/家园/前线/竞技场 四个路由 + 「我的」唤起角色面板。
    放在 App.vue 里常驻，所以切页时位置和外观完全不变，这本身就是「像 App」的关键。
  -->
  <nav class="mtb" aria-label="主导航">
    <button
      v-for="t in tabs"
      :key="t.key"
      class="mtb-item"
      :class="{ on: isActive(t) }"
      type="button"
      @click="onTap(t)"
    >
      <span class="mtb-coin">
        <span class="mtb-icon">{{ t.icon }}</span>
        <span v-if="t.badge" class="mtb-badge">{{ t.badge > 99 ? '99+' : t.badge }}</span>
      </span>
      <span class="mtb-label">{{ t.label }}</span>
    </button>
  </nav>
</template>

<script setup>
/**
 * 底部标签栏。
 * - isActive：前线路由同时属于家园系统，高亮时两个都不抢（各亮各的），
 *   避免「点前线结果两个都亮」的困惑。
 * - 再点已选中的标签 → 派发 smdz:tab-retap，让当前页自己决定回顶/刷新，
 *   这是 App 里肌肉记忆级的手势，不能省。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUiStore } from '../../stores/ui';
import { tapLight } from '../../utils/haptics';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();

const tabs = computed(() => [
  { key: 'chat', label: '公屏', icon: '💬', path: '/chat', closesMe: true },
  { key: 'home', label: '家园', icon: '🏠', path: '/home' },
  { key: 'frontline', label: '前线', icon: '🛡️', path: '/frontline' },
  { key: 'arena', label: '竞技场', icon: '🏟️', path: '/arena' },
  { key: 'me', label: '我的', icon: '👤', me: true },
]);

function isActive(t) {
  if (t.me) return ui.meOpen;
  return route.path === t.path;
}

function onTap(t) {
  tapLight();
  if (t.me) {
    ui.toggleMe();
    return;
  }
  const target = t.path;
  const retap = route.path === target;
  // 「我的」面板开着时切页：必须等它把压进去的返回靶子让掉再导航，
  // 否则 closeMe() 的 history.back() 会把这次 push 顶回原页面。
  ui.afterMeClosed(() => {
    if (retap) {
      // 再点已选中的标签：交给当前页自己决定回顶/刷新（App 级肌肉记忆）
      window.dispatchEvent(new CustomEvent('smdz:tab-retap', { detail: { path: target } }));
      return;
    }
    router.push(target);
  });
}
</script>

<style scoped>
.mtb {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 480;
  display: flex;
  align-items: stretch;
  height: calc(58px + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
  background: linear-gradient(180deg, rgba(24, 18, 52, 0.96) 0%, rgba(10, 10, 26, 0.99) 100%);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid rgba(139, 92, 246, 0.32);
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.55), 0 -1px 0 rgba(255, 255, 255, 0.04) inset;
  /* 底栏自己不能滚，也不能被页面带着橡皮筋 */
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.mtb::before {
  /* 顶部一条能量光带，选中项所在位置变亮，手游底栏常见的「流光」处理 */
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(139, 92, 246, 0.6), rgba(6, 182, 212, 0.6), transparent);
  pointer-events: none;
}
.mtb-item {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px 2px 3px;
  border: 0;
  background: none;
  color: var(--muted, #a0a0c0);
  cursor: pointer;
  position: relative;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.18s ease, transform 0.12s ease;
}
.mtb-item:active {
  transform: translateY(2px) scale(0.94);
}
.mtb-coin {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 26px;
  border-radius: 999px;
  transition: background 0.2s ease, box-shadow 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.mtb-icon {
  font-size: 19px;
  line-height: 1;
  filter: grayscale(0.55) brightness(0.85);
  transition: filter 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.mtb-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1;
  white-space: nowrap;
}
/* 选中态：金币托底发光 + 图标去饱和并弹起 + 上方一根指示条 */
.mtb-item.on {
  color: #fff;
}
.mtb-item.on .mtb-coin {
  background: radial-gradient(circle at 50% 45%, rgba(139, 92, 246, 0.55), rgba(6, 182, 212, 0.18) 70%, transparent 75%);
  box-shadow: 0 0 14px rgba(139, 92, 246, 0.45);
}
.mtb-item.on .mtb-icon {
  filter: none;
  transform: translateY(-1px) scale(1.1);
}
.mtb-item.on::after {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 22px;
  height: 2px;
  border-radius: 0 0 3px 3px;
  background: var(--accent-gradient, linear-gradient(90deg, #8b5cf6, #06b6d4));
  box-shadow: 0 0 8px rgba(139, 92, 246, 0.8);
}
.mtb-badge {
  position: absolute;
  top: -3px;
  right: -6px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--danger, #ef4444);
  color: #fff;
  font-size: 9.5px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  box-shadow: 0 0 0 1.5px rgba(10, 10, 26, 0.9);
}
/* 键盘弹起时底栏让位：iOS 会自动滚动到输入框，留着的半截底栏只会挡路 */
body.kb-open .mtb {
  transform: translateY(100%);
  transition: transform 0.18s ease;
}
</style>
