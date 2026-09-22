<template>
  <!-- QQ 内置浏览器拦截层：手机 QQ 中点开链接时禁止直接游玩，引导到系统浏览器 -->
  <div v-if="qqBlocked" class="qq-block-overlay">
    <div class="qq-block-card">
      <div class="qq-block-icon">⚠️</div>
      <h2 class="qq-block-title">请在系统浏览器中打开</h2>
      <p class="qq-block-desc">
        检测到你正在通过 <b>QQ 内置浏览器</b> 访问本游戏，<br />
        其内核兼容性较差，会导致聊天、登录等功能异常。
      </p>
      <ol class="qq-block-steps">
        <li>点击屏幕右上角「<b>⋯</b>」（部分安卓机型为「<b>⋮</b>」或「＞」）</li>
        <li>在弹出菜单中选择「<b>在浏览器打开</b>」<br /><span class="step-sub">iOS 显示为「在 Safari 中打开」，安卓可选择 Chrome 等任意浏览器</span></li>
        <li>在新打开的浏览器页面中继续登录游玩</li>
      </ol>
      <div class="qq-block-actions">
        <button class="qb-btn qb-primary" @click="tryOpenSystem">🚀 尝试直接跳转系统浏览器</button>
        <button class="qb-btn" @click="copyLink">{{ linkCopied ? '✅ 已复制，请粘贴到浏览器打开' : '📋 复制游戏链接' }}</button>
      </div>
      <p v-if="blockTip" class="qq-block-tip">{{ blockTip }}</p>
    </div>
  </div>

  <!--
    游戏外壳：手机端在路由视图之外常驻两条「永不移动」的界面边栏 ——
    顶部 HUD（头像/等级/血条/经验）与底部标签栏（公屏/家园/前线/竞技场/我的）。
    这正是手游 UI 与网页 UI 最大的结构差异：HUD 与导航跨界面保持不变，
    只有中间的内容区在换。桌面端不渲染它们，布局与之前完全一致。
    keep-alive 让四个主页面切回来时不重建：秒开、不重新连 socket、不丢滚动位置。
  -->
  <div class="game-shell" :class="{ 'is-mobile': device.isMobile }">
    <MobileHud v-if="showShell" />
    <div class="game-stage">
      <router-view v-slot="{ Component }">
        <keep-alive :include="SHELL_VIEWS">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </div>
    <MobileTabBar v-if="showShell" />
  </div>
  <!-- 手机端「我的」角色面板：挂在 App 级，家园/前线/竞技场任意一屏都能直接升起 -->
  <MePanel v-if="device.isMobile" />
  <!-- 全局轻提示宿主：成功/错误/警告/信息统一反馈 -->
  <ToastHost />
</template>

<script setup>
/**
 * 根组件：游戏外壳（HUD + 路由视图 + 底部标签栏）+ 全局轻提示宿主。
 * 附带手机 QQ 内置浏览器拦截：按 UA 特征命中内嵌 WebView（QQ/版本号段、V1_AND_SQ_）时渲染全屏拦截层，
 * 提供「右上角菜单→在浏览器打开」指引、intent 一键跳转与复制链接三种脱困方式。
 * 不提供任何"继续游玩"入口：QQ 内核下聊天/长连接表现不可控，必须离开。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import ToastHost from './components/ToastHost.vue';
import MobileHud from './components/mobile/MobileHud.vue';
import MobileTabBar from './components/mobile/MobileTabBar.vue';
import MePanel from './components/mobile/MePanel.vue';
import { useDeviceStore } from './stores/device';
import { useUiStore } from './stores/ui';

const device = useDeviceStore();
const ui = useUiStore();
const route = useRoute();

/** 参与 keep-alive 的主页面（组件名由文件名推断，见各 view 的 defineOptions） */
const SHELL_VIEWS = ['ChatView', 'HomeView', 'FrontlineView', 'ArenaView'];

/** 登录/开局引导/管理后台这几屏不套手机外壳：前两者是流程页，后台是桌面向的密集表格 */
const showShell = computed(
  () => device.isMobile && !['/login', '/onboard', '/admin'].includes(route.path),
);

/** 键盘弹起时收起 HUD 占位，把屏幕尽量让给输入区 */
const shellPad = computed(() => device.isMobile && !['/login', '/onboard', '/admin'].includes(route.path));

watch(
  shellPad,
  (on) => {
    document.documentElement.classList.toggle('has-shell', on);
    if (!on) ui.closeMe();
  },
  { immediate: true },
);
watch(
  () => device.keyboardOpen,
  (kb) => document.body.classList.toggle('kb-open', kb),
);

onMounted(() => {
  device.init();
  // 手机返回键：只要「我的」面板还开着就先收面板，而不是直接退出游戏页。
  // 靶子条目由 ui store 统一管（见 stores/ui.js 的 openMe/afterMeClosed），这里只负责把
  // 浏览器发起的 popstate 通报给它。Vue Router 的 popstate 监听注册得更早，会先按条目导航，
  // 但靶子条目的 URL 与当前页相同，所以那一步是空操作。
  window.addEventListener('popstate', onPopState);
});
onUnmounted(() => {
  window.removeEventListener('popstate', onPopState);
  device.teardown();
});
function onPopState() { ui.handlePopByBrowser(true); }

/** 是否为手机 QQ 内置浏览器（UA 特征判定） */
function isMobileQqWebview() {
  const ua = navigator.userAgent || '';
  // 仅拦截移动端；桌面端不受影响
  if (!/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  // 手机 QQ 内嵌 WebView 的关键特征：
  // - "QQ/数字.数字" 版本号段（iOS/安卓手机 QQ 均有，如 QQ/8.9.63）
  // - "V1_AND_SQ_" 为安卓手机 QQ 特有标记（SQ = 手机QQ）
  // 注意区分：独立"QQ浏览器"App 的 UA 只有 MQQBrowser、无上述两段，属于正常浏览器不拦截；
  // 微信内置浏览器为 MicroMessenger 标记，也不在此列。
  return /QQ\/\d+\.\d/.test(ua) || /V1_AND_SQ_/.test(ua);
}

// 命中 QQ 内置浏览器 → 全屏拦截（无绕过按钮）
const qqBlocked = ref(isMobileQqWebview());
const linkCopied = ref(false);
const blockTip = ref('');
let tipTimer = null;

function showTip(text) {
  blockTip.value = text;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => (blockTip.value = ''), 4000);
}

/** 复制当前页面完整链接（clipboard 失败时降级为隐藏文本域 + execCommand） */
async function copyLink() {
  const url = window.location.href;
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      ok = false;
    }
  }
  if (ok) {
    linkCopied.value = true;
    showTip('链接已复制！请退出 QQ 打开浏览器，粘贴地址栏访问');
    setTimeout(() => (linkCopied.value = false), 6000);
  } else {
    showTip('复制失败，请手动输入网址或让好友重新发送链接到浏览器打开');
  }
}

/** 尝试自动跳出 QQ 内置浏览器：安卓走 intent:// 系统浏览器协议（可能弹出选择器），iOS 无可靠方案则提示手动 */
function tryOpenSystem() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) {
    // 去掉协议头拼成 intent://host/path#Intent;scheme=https;...;end 格式，
    // 不指定 package 时系统会弹出支持的应用选择器，由玩家挑一个浏览器打开
    window.location.href =
      'intent://' +
      window.location.href.replace(/^https?:\/\//, '') +
      '#Intent;scheme=https;action=android.intent.action.VIEW;end';
    // 跳转被 QQ 拦截或无响应时兜底提示
    showTip('若未弹出浏览器选择框，请按上方步骤手动「在浏览器打开」');
  } else {
    showTip('iPhone 无法自动跳转，请点右上角「⋯」→「在 Safari 中打开」');
    copyLink();
  }
}

onUnmounted(() => clearTimeout(tipTimer));
</script>

<style scoped>
/* ===== QQ 内置浏览器拦截层 ===== */
.qq-block-overlay {
  position: fixed;
  inset: 0;
  /* 盖过一切业务弹窗（公告 200 / toast 等） */
  z-index: 9999;
  background: linear-gradient(160deg, #12101f 0%, #1a1630 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.qq-block-card {
  width: min(420px, 94vw);
  max-height: 90vh;
  overflow-y: auto;
  background: var(--bg2);
  border: 1px solid rgba(251, 191, 36, 0.4);
  border-radius: 16px;
  padding: 28px 22px;
  text-align: center;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}
.qq-block-icon {
  font-size: 44px;
  line-height: 1;
}
.qq-block-title {
  margin: 14px 0 10px;
  font-size: 19px;
  color: #fde68a;
  font-weight: 700;
}
.qq-block-desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary, #cbd5e1);
}
.qq-block-desc b {
  color: #fbbf24;
}
/* 操作步骤：左对齐有序列表 */
.qq-block-steps {
  margin: 0 0 20px;
  padding-left: 20px;
  text-align: left;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text, #e2e8f0);
}
.step-sub {
  display: inline-block;
  font-size: 11px;
  color: var(--muted, #94a3b8);
}
.qq-block-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.qb-btn {
  padding: 11px 16px;
  border-radius: 10px;
  border: 1px solid var(--border-light, rgba(139, 92, 246, 0.25));
  background: rgba(139, 92, 246, 0.08);
  color: var(--text, #e2e8f0);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  touch-action: manipulation;
}
.qb-btn:active {
  transform: scale(0.97);
}
/* 主操作按钮：渐变高亮 */
.qb-primary {
  border: none;
  background: linear-gradient(135deg, #8b5cf6, #6366f1);
  color: #fff;
  box-shadow: 0 4px 16px rgba(139, 92, 246, 0.35);
}
.qq-block-tip {
  margin: 14px 0 0;
  font-size: 12px;
  color: #34d399;
  animation: fadeInUp 0.25s ease-out;
}
</style>
