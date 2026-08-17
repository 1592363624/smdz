<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="game-title">使魔大战3 · 网页版</h1>
      <p class="subtitle">公屏群聊文字游戏 · 提供API支持对接机器人</p>

      <!-- QQ 登录入口 -->
      <button
        class="qq-login-btn"
        :disabled="qqLoading || !qqConfigured"
        @click="qqLogin"
        :title="qqConfigured ? '使用QQ账号登录' : 'QQ登录未配置（需设置 QQ_APP_ID）'"
      >
        <svg class="qq-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
        </svg>
        <span>{{ qqLoading ? '跳转中...' : (qqConfigured ? 'QQ 登录' : 'QQ 登录未配置') }}</span>
      </button>

      <!-- 错误提示 -->
      <transition name="fade">
        <p v-if="error" class="error">{{ error }}</p>
      </transition>

      <p class="tip">提示：输入「信息」查看角色状态，输入「帮助」查看所有指令</p>
    </div>
  </div>
</template>

<script setup>
/**
 * 登录页面（纯 QQ 互联登录）
 * 游戏仅支持通过 QQ 互联登录，不再提供用户名+密码的自注册/自登录。
 * 组件挂载时检查 QQ 登录是否已配置，并处理 QQ 授权回调参数完成登录。
 */
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { API_BASE } from '../config';

const router = useRouter();
const route = useRoute();
const qqLoading = ref(false);
const qqConfigured = ref(false);
const error = ref('');

// 组件挂载时：检查 QQ 登录是否已配置，并处理 QQ 回调参数
onMounted(async () => {
  // 检查 QQ 登录是否已配置
  try {
    const res = await fetch(`${API_BASE}/auth/qq/status`);
    const data = await res.json();
    qqConfigured.value = data.data?.configured === true;
  } catch {
    qqConfigured.value = false;
  }

  // 处理 QQ 登录回调（从 URL 参数中获取 token 和用户信息）
  const qqToken = route.query.qq_token;
  const qqUserStr = route.query.qq_user;
  if (qqToken && qqUserStr) {
    try {
      // 保存 token 和用户信息
      localStorage.setItem('token', qqToken);
      const qqUser = JSON.parse(decodeURIComponent(qqUserStr));
      localStorage.setItem('user', JSON.stringify(qqUser));
      // QQ 登录后直接进入聊天页（昵称由 QQ 昵称提供，不再前端引导设置）
      router.push('/chat');
    } catch (e) {
      error.value = 'QQ 登录处理失败，请重试';
    }
  }

  // 处理 QQ 登录错误
  if (route.query.error === 'qq_auth_failed') {
    error.value = 'QQ 登录失败，请重试';
  }
});

/**
 * QQ 登录：跳转到 QQ 授权页面
 */
function qqLogin() {
  if (!qqConfigured.value) {
    error.value = 'QQ 登录尚未配置，请联系管理员设置 QQ_APP_ID 和 QQ_APP_KEY';
    return;
  }
  qqLoading.value = true;
  // 跳转到后端 QQ 授权入口
  window.location.href = `${API_BASE}/auth/qq/login`;
}
</script>

<style scoped>
/* QQ 登录按钮 - 逆流次元风格 */
.qq-login-btn {
  width: 100%;
  padding: 10px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s ease;
  position: relative;
  overflow: hidden;
}
.qq-login-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(18, 183, 245, 0.05), transparent);
  pointer-events: none;
}
.qq-login-btn:hover:not(:disabled) {
  border-color: rgba(18, 183, 245, 0.4);
  background: rgba(18, 183, 245, 0.08);
  box-shadow: 0 0 16px rgba(18, 183, 245, 0.15);
  transform: translateY(-1px);
}
.qq-login-btn:active:not(:disabled) {
  transform: translateY(0);
}
.qq-login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.qq-icon {
  width: 20px;
  height: 20px;
  color: #12b7f5;
  filter: drop-shadow(0 0 4px rgba(18, 183, 245, 0.3));
}

/* 错误提示淡入淡出动画 */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
