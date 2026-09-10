/**
 * 前端路由
 * /login   登录页
 * /onboard 使魔契约引导页（未选择使魔的新玩家首屏，需登录）
 * /chat    公屏聊天页(需登录)
 */
import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../views/LoginView.vue';
import OnboardView from '../views/OnboardView.vue';
import ChatView from '../views/ChatView.vue';
import AdminView from '../views/AdminView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/login', name: 'login', component: LoginView },
    // 是否真正需要引导由页面内预检决定（已开局玩家访问会立即被送回 /chat）
    { path: '/onboard', name: 'onboard', component: OnboardView, meta: { requiresAuth: true } },
    { path: '/chat', name: 'chat', component: ChatView, meta: { requiresAuth: true } },
    { path: '/admin', name: 'admin', component: AdminView, meta: { requiresAuth: true, requiresAdmin: true } },
  ],
});

// 全局路由守卫：未登录跳转登录页
router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (to.meta.requiresAuth && !token) {
    return { name: 'login' };
  }
  if (to.name === 'login' && token) {
    return { name: 'chat' };
  }
  return true;
});

export default router;
