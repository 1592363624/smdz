<template>
  <div class="ar-page">
    <!-- 顶栏：赛季 / 本服规模 / 开放状态与刷新 -->
    <header class="ar-top">
      <button class="ar-back" title="返回聊天" @click="router.push('/chat')">←</button>
      <div class="ar-head-main">
        <div class="ar-title">🏟️ 使魔竞技场 · 镜像天梯</div>
        <div class="ar-meta">
          <span>{{ seasonText }}</span>
          <span>镜像 {{ num(overview?.mirrorCount) }}</span>
          <span>参战 {{ num(overview?.profileCount) }}</span>
          <span>场次 {{ num(overview?.matchCount) }}</span>
          <span v-if="closedText" class="ar-warn">⚠ {{ closedText }}</span>
          <span v-else class="ar-ok">名次互换制：没有积分，也就没有喂分</span>
        </div>
      </div>
      <div class="ar-head-ops">
        <span v-if="myTier" class="ar-tier" :class="toneClass(myTier)">{{ myTier.name }} · 第 {{ num(me?.rank) }} 名</span>
        <button class="ar-btn ghost" :disabled="loading" @click="refresh">刷新</button>
      </div>
    </header>

    <!-- 首屏还没拿到任何数据：整页占位（拿到之后失败只在正文顶部显示错误条，不清空已渲染内容） -->
    <div v-if="loading && !overview" class="ar-loading">竞技场数据加载中…</div>
    <div v-else-if="error && !overview" class="ar-loading err">{{ error }}</div>

    <main v-else-if="overview" class="ar-body">
      <div v-if="error" class="ar-banner">{{ error }}（其余数据仍为最近一次成功结果）</div>

      <!-- ======================= 我的天梯 ======================= -->
      <section class="ar-block">
        <div class="ar-block-head">
          <span class="ar-b-chip me">📊</span>
          <span class="ar-b-title">我的天梯</span>
          <span class="ar-b-note">入场 {{ entryCostText }} · 刷新镜像 {{ submitCostText }} · 参战门槛 等级 ≥ {{ num(cfg?.minLevelToEnter) }}</span>
        </div>

        <div v-if="!me" class="ar-empty">还没有天梯档案：在聊天里发送「竞技场」即可建档上榜</div>
        <template v-else>
          <div class="ar-stat-row">
            <div class="ar-stat">
              <div class="ar-stat-val">{{ me.rank ? `第 ${num(me.rank)}` : '未上榜' }}</div>
              <div class="ar-stat-label">当前名次（赛季最佳 {{ bestRankText }}）</div>
            </div>
            <div class="ar-stat">
              <div class="ar-stat-val" :class="{ warn: canChallengeCount <= 0 }">{{ num(canChallengeCount) }}<em>人</em></div>
              <div class="ar-stat-label">可正式挑战的镜像（{{ windowText }}；打不高于你的算免费练手）</div>
            </div>
            <div class="ar-stat">
              <div class="ar-stat-val">{{ me.wins }}<em>/{{ me.losses }}/{{ me.draws }}</em></div>
              <div class="ar-stat-label">胜 / 负 / 平（{{ streakText }}）</div>
            </div>
            <div class="ar-stat">
              <div class="ar-stat-val" :class="{ warn: me.dailyLeft <= 0 }">{{ num(me.dailyLeft) }}<em>/{{ num(me.dailyLimit) }}</em></div>
              <div class="ar-stat-label">今日剩余挑战（0 点重置）</div>
            </div>
          </div>
          <div class="ar-bar"><div class="ar-bar-fill" :style="{ width: dailyPct + '%' }"></div></div>

          <!-- 段位表按名次区间显示：改名改线都在后台，这里只是把当前生效的那份摊开 -->
          <div class="ar-scale">
            <span
              v-for="t in tiers"
              :key="'scale-' + t.key"
              class="ar-tier"
              :class="[toneClass(t), { on: t.key === myTier?.key }]"
              :title="`赛季末排进第 ${t.rankFrom} ~ ${t.rankTo || '∞'} 名即为本段位`"
            >{{ t.name }} {{ tierRangeText(t) }}</span>
          </div>

          <!-- 镜像状态：冻结快照不会随主人变强，所以提交时间与新鲜度必须摆在台面上 -->
          <div class="ar-mirror">
            <div class="ar-mirror-main">
              <div class="ar-mirror-title">
                🪞 {{ myMirror ? `我的镜像 · 榜上第 ${num(myMirror.rank) || '—'} 位` : '尚未提交镜像' }}
              </div>
              <div class="ar-mirror-sub">
                <template v-if="myMirror">
                  Lv.{{ num(myMirror.level) }} · 战力 {{ fmtNum(myMirror.power) }} · {{ mirrorAgoText }}
                  <em v-if="myMirrorVersion">· 榜上版本 v{{ myMirrorVersion }}</em>
                </template>
                <template v-else>只有自己也在榜上，才能挑战别人（服务端同口径拦截）</template>
              </div>
              <div v-if="mirrorStale" class="ar-mirror-hint">
                {{ staleHint }}——榜上打的是这一版快照，换了装备不刷新就一直用老配置挨打
              </div>
            </div>
            <button class="ar-btn primary" :disabled="running || !arenaOpen" :title="closedText || `发送指令：${CMD.submit}`" @click="submitMirror">
              🪞 提交镜像（{{ submitCostText }}）
            </button>
          </div>
        </template>
      </section>

      <!-- ======================= 天梯榜 ======================= -->
      <section class="ar-block">
        <div class="ar-block-head">
          <span class="ar-b-chip ladder">🏆</span>
          <span class="ar-b-title">天梯榜</span>
          <span v-if="ladder" class="ar-b-note">共 {{ num(ladder.total) }} 个镜像 · 每页 {{ ladderRows.length }} 行</span>
        </div>

        <div v-if="!ladderRows.length" class="ar-empty">{{ loading ? '榜单加载中…' : '本赛季还没有镜像，先「提交镜像」成为第一个上榜的人' }}</div>
        <div v-else class="ar-table-wrap">
          <table class="ar-table">
            <thead>
              <tr>
                <th>名次</th>
                <th>段位</th>
                <th>主人</th>
                <th>等级</th>
                <th>战力</th>
                <th>镜像版本 / 提交</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in ladderRows" :key="row.mirrorId" :class="{ mine: row.ownerId === me?.userId }">
                <td class="rank">{{ row.rank }}</td>
                <td><span class="ar-tier" :class="tierClassByName(row.tier)">{{ row.tier || '未定级' }}</span></td>
                <td class="name" :title="row.ownerName">{{ row.ownerName }}</td>
                <td class="num">Lv.{{ num(row.level) }}</td>
                <td class="num">{{ fmtNum(row.power) }}</td>
                <td class="ver">v{{ num(row.mirrorVersion) }}<em>{{ fmtAgo(row.capturedAt) }}</em></td>
                <td>
                  <!-- 自己的镜像不给挑战：服务端也会拒，这里只是把「为什么不能点」写进 title -->
                  <button
                    class="ar-btn tiny"
                    :class="{ ghost: isPracticeTarget(row) }"
                    :disabled="Boolean(challengeBlock(row)) || running"
                    :title="challengeBlock(row) || (isPracticeTarget(row) ? `和 ${row.ownerName} 的镜像练一手：免费、不占次数、不计名次` : `向 ${row.ownerName} 的镜像开战`)"
                    @click="challenge(row)"
                  >{{ isPracticeTarget(row) ? '练手' : '挑战' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="ar-pager">
          <button class="ar-btn tiny ghost" :disabled="ladderPage <= 1 || loading" @click="goLadderPage(ladderPage - 1)">← 上一页</button>
          <!-- v-for 与 v-if 不同元素：Vue3 里同标签上 v-if 先于 v-for 求值，拿不到 p，故用 template 包一层 -->
          <template v-for="(p, pi) in pageButtons(ladderPage, ladderPages)" :key="'lp-' + pi">
            <span v-if="p === 0" class="ar-dots">…</span>
            <button v-else class="ar-btn tiny page" :class="{ on: p === ladderPage }" :disabled="loading" @click="goLadderPage(p)">{{ p }}</button>
          </template>
          <button class="ar-btn tiny ghost" :disabled="ladderPage >= ladderPages || loading" @click="goLadderPage(ladderPage + 1)">下一页 →</button>
          <span class="ar-dim">共 {{ num(ladder?.total) }} 个镜像 · {{ ladderPage }}/{{ ladderPages }} 页</span>
        </div>
      </section>

      <!-- ======================= 我的战绩 ======================= -->
      <section class="ar-block">
        <div class="ar-block-head">
          <span class="ar-b-chip history">📜</span>
          <span class="ar-b-title">我的战绩</span>
          <span class="ar-b-note">攻出去的与别人打我的都在这一张表里</span>
        </div>

        <div v-if="!matchRows.length" class="ar-empty">{{ loading ? '战绩加载中…' : '还没有一场竞技场战斗：去天梯榜挑一个镜像吧' }}</div>
        <div v-else class="ar-match-list">
          <div v-for="row in matchRows" :key="row.id" class="ar-match">
            <span class="ar-result" :class="resultClass(row)">{{ resultText(row) }}</span>
            <div class="ar-match-main">
              <div class="ar-match-title">
                <template v-if="row.attacked">我 → {{ row.opponent }}<em>v{{ num(row.mirrorVersion) }}</em></template>
                <template v-else>{{ row.opponent }} → 我<em>v{{ num(row.mirrorVersion) }}</em></template>
              </div>
              <div class="ar-match-sub">
                {{ num(row.rounds) }} 次出手 · {{ num(row.durationSec) }}s ·
                <span :class="row.swapped ? 'ar-rank-move' : 'ar-rank-keep'">{{ rankChangeText(row) }}</span>
              </div>
            </div>
            <span class="ar-match-time">{{ fmtDateTime(row.createdAt) }}</span>
            <button class="ar-btn tiny" @click="openReport(row.id)">查看战报</button>
          </div>
        </div>

        <div class="ar-pager">
          <button class="ar-btn tiny ghost" :disabled="matchPage <= 1 || loading" @click="goMatchPage(matchPage - 1)">← 上一页</button>
          <template v-for="(p, pi) in pageButtons(matchPage, matchPages)" :key="'mp-' + pi">
            <span v-if="p === 0" class="ar-dots">…</span>
            <button v-else class="ar-btn tiny page" :class="{ on: p === matchPage }" :disabled="loading" @click="goMatchPage(p)">{{ p }}</button>
          </template>
          <button class="ar-btn tiny ghost" :disabled="matchPage >= matchPages || loading" @click="goMatchPage(matchPage + 1)">下一页 →</button>
          <span class="ar-dim">共 {{ num(matches?.total) }} 场 · {{ matchPage }}/{{ matchPages }} 页</span>
        </div>
      </section>

      <!-- ======================= 赛季奖励 ======================= -->
      <section class="ar-block">
        <div class="ar-block-head">
          <span class="ar-b-chip reward">🎁</span>
          <span class="ar-b-title">赛季奖励</span>
          <span class="ar-b-note">名次档、称号、头像框、特权与资源全部由后台配置，改表不发版</span>
        </div>
        <div v-if="!rewardBands.length" class="ar-empty">本赛季尚未配置名次档奖励（后台 arena.seasonRewards）</div>
        <div v-else class="ar-bands">
          <div v-for="band in rewardBands" :key="band.key" class="ar-band" :class="{ part: band.participation }">
            <div class="ar-band-rank">
              <b>{{ band.rankText }}</b>
              <em v-if="band.label">{{ band.label }}</em>
            </div>
            <div class="ar-band-items">
              <span v-for="(chip, ci) in band.chips" :key="ci" class="ar-chip" :class="chip.cls">{{ chip.text }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ======================= 装扮 ======================= -->
      <section class="ar-block">
        <div class="ar-block-head">
          <span class="ar-b-chip dress">🖼️</span>
          <span class="ar-b-title">装扮与特权</span>
          <span class="ar-b-note">头像框同时只能佩戴一个；特权是会到期的能力，不是后台身份</span>
        </div>

        <div v-if="!ownedFrames.length" class="ar-empty">还没有头像框：赛季结算按名次发放（见上方「赛季奖励」）</div>
        <div v-else class="ar-frames">
          <div v-for="f in ownedFrames" :key="f.key" class="ar-frame" :class="[toneClass(f), { on: f.equipped }]">
            <span class="ar-frame-ring"><span class="ar-frame-av">{{ avatarLetter }}</span></span>
            <div class="ar-frame-main">
              <div class="ar-frame-name">{{ f.name }}<em v-if="f.equipped">佩戴中</em></div>
              <div class="ar-frame-desc">{{ f.description || f.key }}<span v-if="f.source"> · 来源 {{ sourceText(f.source) }}</span></div>
            </div>
            <button class="ar-btn tiny" :disabled="running || f.equipped" @click="wearFrame(f)">{{ f.equipped ? '已佩戴' : '佩戴' }}</button>
          </div>
        </div>
        <button v-if="equippedFrameKey" class="ar-btn tiny ghost" :disabled="running" @click="unequipFrame()" title="发送「头像框 佩戴 无」">卸下当前头像框</button>

        <div class="ar-priv-head">生效中的特权</div>
        <div v-if="!privileges.length" class="ar-empty slim">暂无特权：打进配置的名次档即可拿到如「野外批量采集」这类能力</div>
        <div v-else class="ar-privs">
          <div v-for="p in privileges" :key="p.key" class="ar-priv">
            <span class="ar-priv-name">⚙️ {{ p.name || p.key }}</span>
            <span class="ar-priv-expire">{{ p.expiresAt ? fmtDateTime(p.expiresAt) + ' 到期' : '永久' }}</span>
            <span v-if="p.reason" class="ar-priv-reason">{{ p.reason }}</span>
          </div>
        </div>
      </section>

      <!-- ======================= 竞技场管理（仅 ADMIN / SUPER_ADMIN 渲染） ======================= -->
      <section v-if="isAdmin" class="ar-block admin">
        <div class="ar-block-head">
          <span class="ar-b-chip admin">🛠️</span>
          <span class="ar-b-title">竞技场管理</span>
          <span class="ar-b-note">与「竞技场管理」指令收敛到同一批方法，两条入口一个逻辑</span>
        </div>

        <div class="ar-admin-row">
          <button class="ar-btn danger" :disabled="adminBusy" @click="adminSettle">立即结算</button>
          <span class="ar-dim">幂等：未到期的赛季不会被发奖</span>
          <input v-model="extendDays" class="ar-input short" type="number" min="0" step="1" title="从现在起几天后赛季结束（0 = 立刻到期）" />
          <button class="ar-btn" :disabled="adminBusy" @click="adminExtend">改期</button>
        </div>

        <div class="ar-admin-row">
          <select v-model="holdersKey" class="ar-input" @change="loadHolders">
            <option v-for="d in privilegeDefs" :key="d.key" :value="d.key">{{ d.name || d.key }}</option>
          </select>
          <input v-model="grantForm.userId" class="ar-input short" type="number" placeholder="玩家ID" />
          <input v-model="grantForm.key" class="ar-input" placeholder="特权键" />
          <input v-model="grantForm.days" class="ar-input short" type="number" placeholder="天数(0=永久)" />
          <input v-model="grantForm.reason" class="ar-input" placeholder="理由（可空）" />
          <button class="ar-btn primary" :disabled="adminBusy" @click="adminGrant">授予</button>
        </div>

        <div v-if="!holderRows.length" class="ar-empty slim">该特权目前没有在册持有者</div>
        <div v-else class="ar-table-wrap">
          <table class="ar-table">
            <thead>
              <tr><th>玩家 ID</th><th>到期</th><th>理由</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="(h, hi) in holderRows" :key="h.userId + '-' + hi">
                <td class="num">{{ h.userId }}</td>
                <td>{{ h.expiresAt ? fmtDateTime(h.expiresAt) : '永久' }}</td>
                <td class="name" :title="h.reason">{{ h.reason || '—' }}</td>
                <td><button class="ar-btn tiny danger ghost" :disabled="adminBusy" @click="adminRevoke(h)">撤销</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="adminResult" class="ar-admin-result">{{ adminResult }}</div>
      </section>
    </main>

    <!-- ======================= 战报抽屉（正文 + 逐回合明细，可回放） ======================= -->
    <div v-if="reportOpen" class="ar-mask" @click.self="closeReport">
      <aside class="ar-drawer">
        <header class="ar-drawer-head">
          <div class="ar-drawer-head-main">
            <div class="ar-drawer-title">战报 #{{ report?.id ?? reportId }}</div>
            <div class="ar-drawer-sub">
              <template v-if="report">{{ report.attacker?.name }} vs {{ report.defender?.name }} · 胜者 {{ winnerText }}{{ reportRankText }} · {{ num(report.rounds) }} 次出手 · {{ num(report.durationSec) }}s</template>
              <template v-else>读取中…</template>
            </div>
          </div>
          <button class="ar-btn ghost tiny" @click="closeReport">关闭 ✕</button>
        </header>

        <!-- 抽屉正文：整块可滚（回合表很长，不能只靠表自身限高） -->
        <div class="ar-drawer-body">
          <div v-if="reportLoading" class="ar-loading">战报读取中…</div>
          <div v-else-if="reportError" class="ar-loading err">{{ reportError }}</div>

          <template v-else-if="report">
            <!-- 双方终局：面板 + 三池余量 + 承伤统计，看「谁被谁耗死的」 -->
            <div v-if="report.sides" class="ar-sides">
              <div v-for="side in sideViews" :key="side.key" class="ar-side" :class="{ win: report.winner === side.key, me: side.isMe }">
                <div class="ar-side-name">{{ side.label }} {{ side.name }}</div>
                <div class="ar-side-sub">Lv.{{ num(side.level) }} · 战力 {{ fmtNum(side.power) }}</div>
                <div class="ar-side-pools">
                  <span>盾 {{ fmtNum(side.pools?.shield) }}</span>
                  <span>甲 {{ fmtNum(side.pools?.armor) }}</span>
                  <span>命 {{ fmtNum(side.pools?.hp) }}</span>
                </div>
                <div class="ar-side-taken">承受 {{ fmtNum(side.taken?.damage) }} · 被打 {{ num(side.taken?.hits) }}/{{ num(side.taken?.actions) }} 次命中</div>
              </div>
            </div>

            <div v-if="reportRounds.length" class="ar-table-wrap round">
              <table class="ar-table">
                <thead>
                  <tr><th>时刻</th><th>出手方</th><th>武器</th><th>判定</th><th>伤害（盾/甲/命）</th><th>承伤方余量</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(r, ri) in reportRounds" :key="ri" :class="{ crit: r.crit, miss: r.miss }">
                    <td class="num">{{ r.t }}s</td>
                    <td>{{ r.side }}</td>
                    <td class="name">{{ r.weapon }}</td>
                    <td>{{ r.verdict }}</td>
                    <td class="num">{{ r.damage }}<em v-if="r.split"> {{ r.split }}</em><em v-if="r.leech"> {{ r.leech }}</em></td>
                    <td class="num pools">{{ r.pools }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 原文：服务端渲染的战报正文，逐字展示（等宽块，保持全角对齐） -->
            <pre v-if="reportLines" class="ar-lines">{{ reportLines }}</pre>
            <div v-else class="ar-empty">这份战报没有正文文本（只有逐回合明细）</div>
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
/**
 * 使魔竞技场 · 镜像天梯（异步 PVP）网页面板。
 *
 * 读：arenaApi 的只读接口（与指令「竞技场 / 竞技场战绩 / 战报」同一批数据，不同呈现）。
 * 写：提交镜像 / 挑战 / 佩戴头像框一律经 commandApi.execute 发送与 QQ 端逐字相同的指令文本——
 *     本页不存在第二条写路径，门槛、计费、席位互换、防连打都只有服务端一份实现；
 *     前端 challengeBlock() 只是提前挡一次少发无效指令，不是裁判。
 * 管理（ADMIN/SUPER_ADMIN）：adminArenaApi，后台动作走 HTTP 是指令侧之外的另一条运维入口，
 *     服务端两边收敛到 ArenaSeasonService 同一批方法。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { adminArenaApi, arenaApi, commandApi } from '../api';
import { useUiStore } from '../stores/ui';

const router = useRouter();
const ui = useUiStore();

/** 面板自动刷新间隔（毫秒）：名次与每日次数会被别人的挑战改动，纯轮询足够 */
const REFRESH_MS = 30000;
/** 指令发出后补拉数据的延迟（毫秒），等后端写完再读 */
const REFETCH_DELAY_MS = 500;
/**
 * 镜像「陈旧」阈值（小时）：镜像是冻结快照，主人换装不会带进已挂出的榜。
 * 只提示、不自动刷新——自动刷新会把「挑战一个已知镜像」变成打随机人。
 */
const MIRROR_STALE_HOURS = 24;
/** 未上榜时给挑战按钮的兜底文案 */
const NO_MIRROR_TEXT = '先「提交镜像」上榜，才能挑战别人';

/** 指令文本：与 QQ 端逐字一致（服务端 ARENA_COMMANDS 及其别名口径） */
const CMD = {
  submit: '提交镜像',
  challenge: (target) => `挑战镜像 ${target}`,
  wear: (key) => `头像框 佩戴 ${key}`,
  unequip: '头像框 佩戴 无',
};

/** 奖励条目类型 → 展示名（name 为空的条目如经验/活力靠它兜底） */
const REWARD_TYPE_NAME = {
  item: '资源', exp: '经验', vitality: '活力', title: '称号', frame: '头像框', privilege: '特权',
};
const REWARD_ICON = {
  item: '📦', exp: '✨', vitality: '⚡', title: '🏅', frame: '🖼️', privilege: '⚙️',
};
/**
 * tone → 主题类：后端只给段位/头像框一个 tone 标识串，配色属于表现层。
 * 改这里即可整页换肤，不动配置表与数据库；未收录的 tone 落 ar-tone-default。
 */
const TONE_CLASS = {
  gold: 'ar-tone-gold',
  purple: 'ar-tone-purple',
  cyan: 'ar-tone-cyan',
  'silver-blue': 'ar-tone-silverblue',
  'bronze-gold': 'ar-tone-bronzegold',
  silver: 'ar-tone-silver',
  brown: 'ar-tone-brown',
  // 头像框 tone 与段位 tone 共用同一批色，避免同一套紫/金写两遍
  'gold-crown': 'ar-tone-gold',
  'silver-ring': 'ar-tone-silver',
  'bronze-mark': 'ar-tone-bronzegold',
};

// ---------- 状态 ----------
const overview = ref(null);
const ladder = ref(null);
const matches = ref(null);
/** GET frames 回包：{frames:{owned,equipped}, privileges:[]} */
const entitlement = ref(null);
/** GET season-rewards 回包：{ranks:[], participation?} */
const rewardConfig = ref(null);

const ladderPage = ref(1);
const matchPage = ref(1);
const loading = ref(false);
/** 指令执行中：期间禁用所有写按钮，避免并发提交镜像 / 连点挑战 */
const running = ref(false);
const error = ref('');

const reportOpen = ref(false);
const report = ref(null);
const reportId = ref(0);
const reportLoading = ref(false);
const reportError = ref('');

const adminBusy = ref(false);
const adminResult = ref('');
const extendDays = ref(7);
const holdersKey = ref('batchGather');
const holderData = ref(null);
const grantForm = ref({ userId: '', key: 'batchGather', days: 30, reason: '' });

/** 登录用户：只用于管理区块显隐（真正的权限判定在服务端守卫） */
const user = ref(readStoredUser());
const isAdmin = computed(() => ['ADMIN', 'SUPER_ADMIN'].includes(user.value?.role));

let timer = null;

// ---------- 派生数据 ----------
const cfg = computed(() => overview.value?.config || null);
const me = computed(() => overview.value?.me || null);
const season = computed(() => overview.value?.season || null);
/** 段位表：后端已按 rankFrom 升序给（rankTo=0 表示不设上限），这里再排一次以承受配置乱序填写 */
const tiers = computed(() => [...(cfg.value?.tiers || [])].sort((a, b) => (Number(a.rankFrom) || 0) - (Number(b.rankFrom) || 0)));
/** 取覆盖当前名次的段位（与后端 deriveArenaTier 同口径：区间含头含尾，未上榜不给段位） */
const myTier = computed(() => {
  const rank = Number(me.value?.rank) || 0;
  if (!rank) return null;
  return tiers.value.find((t) => rank >= (Number(t.rankFrom) || 1) && (!(Number(t.rankTo) || 0) || rank <= Number(t.rankTo))) || null;
});
/** 赛季最佳名次：0 表示还没上过榜，别显示成「第 0 名」 */
const bestRankText = computed(() => {
  const best = Number(me.value?.bestRank) || 0;
  return best > 0 ? `第 ${best} 名` : '未上榜';
});
/** 可挑战人数：排名互换制下只有排在你前面的人能被你打（窗口>0 还要再截一刀） */
const canChallengeCount = computed(() => {
  const rank = Number(me.value?.rank) || 0;
  if (!rank) return 0;
  const window = Number(cfg.value?.challengeRankWindow) || 0;
  const span = window > 0 ? Math.min(window, rank - 1) : rank - 1;
  return Math.max(0, span);
});
const windowText = computed(() => {
  const window = Number(me.value?.challengeRankWindow ?? cfg.value?.challengeRankWindow) || 0;
  if (window === 1) return '只能一顺位往上打';
  if (window > 1) return `最多往上打 ${window} 名`;
  return '排名比你高就能打';
});
const arenaOpen = computed(() => Boolean(cfg.value?.enabled) && !season.value?.expired && !season.value?.notStarted);
const closedText = computed(() => {
  if (!cfg.value) return '概况加载中';
  if (!cfg.value.enabled) return '竞技场暂未开放';
  if (season.value?.notStarted) return `赛季将于 ${fmtDateTime(season.value.startAt)} 开放`;
  if (season.value?.expired) return '本赛季已结束，等待结算';
  return '';
});
const seasonText = computed(() => {
  if (!season.value) return '赛季加载中…';
  return `赛季 ${season.value.name || 'S' + season.value.no} · 至 ${fmtDateTime(season.value.endAt)}`;
});
const ladderRows = computed(() => ladder.value?.rows || []);
const ladderPages = computed(() => Number(ladder.value?.pages) || 1);
const matchRows = computed(() => matches.value?.rows || []);
/** 战绩接口只给 total/pageSize 不给页数，按 pageSize 自己算（pageSize 缺失时按 1 兜底不除零） */
const matchPages = computed(() => {
  const size = Number(matches.value?.pageSize) || 1;
  return Math.max(1, Math.ceil((Number(matches.value?.total) || 0) / size));
});
const myMirror = computed(() => me.value?.mirror || null);
const ownedFrames = computed(() => entitlement.value?.frames?.owned || []);
const equippedFrameKey = computed(() => entitlement.value?.frames?.equipped || '');
const privileges = computed(() => entitlement.value?.privileges || []);
const privilegeDefs = computed(() => holderData.value?.defs || [{ key: 'batchGather', name: '野外批量采集' }]);
const holderRows = computed(() => holderData.value?.holders || []);
const avatarLetter = computed(() => String(user.value?.nickname || user.value?.username || '?').trim().charAt(0) || '?');

/** 连胜/连败文案（streak 正数为连胜、负数为连败，服务端存的就是带符号数） */
const streakText = computed(() => {
  const s = Number(me.value?.streak) || 0;
  if (s > 0) return `连胜 ${s}`;
  if (s < 0) return `连败 ${-s}`;
  return '无连胜';
});
const dailyPct = computed(() => {
  const limit = Number(me.value?.dailyLimit) || 0;
  const left = Number(me.value?.dailyLeft) || 0;
  // 上限为 0 是「今天一次都不能打」（后台把次数配置改成 0 即停赛），不是满格
  if (!limit) return 0;
  return Math.max(0, Math.min(100, Math.round((left / limit) * 100)));
});
/**
 * 我自己在榜上的镜像版本号：overview 的 me.mirror 不带 version，
 * 但榜单行带（且含我自己这一行），从当前页就地取，不额外发请求。
 */
const myMirrorVersion = computed(() => {
  const id = Number(myMirror.value?.id) || 0;
  if (!id) return 0;
  return Number(ladderRows.value.find((r) => Number(r.mirrorId) === id)?.mirrorVersion) || 0;
});
/** 镜像提交于多久以前（口径与服务端面板文本一致：分钟 / 小时 / 天） */
const mirrorAgoText = computed(() => {
  const at = Number(myMirror.value?.submittedAt) || 0;
  return at ? `${fmtAgo(at)}提交` : '提交时间未知';
});
const mirrorStale = computed(() => {
  const at = Number(myMirror.value?.submittedAt) || 0;
  if (!at) return false;
  return Date.now() - at > MIRROR_STALE_HOURS * 3600 * 1000;
});
const staleHint = computed(() => {
  const hours = Math.floor((Date.now() - (Number(myMirror.value?.submittedAt) || Date.now())) / 3600000);
  return `镜像已挂 ${hours > 0 ? `${hours} 小时` : '很久'}，等级/装备若已变化建议刷新`;
});
const entryCostText = computed(() => costLabel(cfg.value?.entry));
const submitCostText = computed(() => costLabel(cfg.value?.submit));

/** 赛季奖励档位：把「后台可配」这件事直接演给玩家看，名次区间 → 称号/头像框/特权/资源 */
const rewardBands = computed(() => {
  const bands = (rewardConfig.value?.ranks || []).map((band) => ({
    key: `rank-${band.from}-${band.to}`,
    rankText: band.from === band.to ? `第 ${band.from} 名` : `第 ${band.from} ~ ${band.to} 名`,
    label: band.label || '',
    chips: rewardChips(band),
  }));
  const part = rewardConfig.value?.participation;
  if (part) {
    const chips = rewardChips(part);
    const minMatches = Number(part.minMatches) || 0;
    if (chips.length || minMatches) {
      bands.push({
        key: 'participation',
        rankText: minMatches ? `打满 ${minMatches} 场` : '参与奖',
        label: '与名次档并行发放',
        chips,
        participation: true,
      });
    }
  }
  return bands;
});

const reportLines = computed(() => (report.value?.lines || []).join('\n'));

/** 逐回合明细 → 表格行（战报不只是文本：出手时刻 / 判定 / 三池分伤 / 承伤方余量） */
const reportRounds = computed(() => {
  const r = report.value;
  if (!r) return [];
  return (r.actionLog || []).map((a) => {
    const pool = a.poolDamage || {};
    const left = a.targetPools || {};
    return {
      t: Math.round((Number(a.t) || 0) * 10) / 10,
      side: a.side === 'attacker' ? `攻 ${r.attacker?.name ?? ''}` : `守 ${r.defender?.name ?? ''}`,
      weapon: a.weapon,
      miss: !a.hit,
      crit: Boolean(a.hit && a.crit),
      verdict: a.hit ? `${a.crit ? '暴击' : '命中'}${a.rating ? ' ' + a.rating : ''}` : '未命中',
      damage: fmtNum(a.damage),
      split: a.hit ? `(${Math.round(pool.shield || 0)}/${Math.round(pool.armor || 0)}/${Math.round(pool.hp || 0)})` : '',
      leech: Number(a.leech) > 0 ? `吸${Math.round(a.leech)}` : '',
      pools: `盾${Math.round(left.shield || 0)} 甲${Math.round(left.armor || 0)} 命${Math.round(left.hp || 0)}`,
    };
  });
});

/** 双方终局对比（含「哪一侧是我」，便于在别人的战报里也能对上号） */
const sideViews = computed(() => {
  const r = report.value;
  if (!r?.sides) return [];
  return ['attacker', 'defender'].map((key) => {
    const side = r.sides[key] || {};
    const isMe = Number(side.userId) === Number(me.value?.userId);
    return {
      key,
      isMe,
      label: key === 'attacker' ? '攻方' : '守方',
      name: side.name || (key === 'attacker' ? r.attacker?.name : r.defender?.name) || '未知',
      level: side.level,
      power: side.power,
      pools: side.pools,
      taken: side.taken,
    };
  });
});

/**
 * 战报头部双方的名次变化：席位互换制下，一场对局只有两种结局——
 * 打赢的顶替对手、被打赢的让出名次，平局与守成功的都不动。
 * 这里给的是结算瞬间的名次快照（名次会随之后的换位再变）。
 */
const reportRankText = computed(() => {
  const r = report.value;
  if (!r) return '';
  if (r.practice) return ' · 练手局（不计胜败、不动席位与名次）';
  const ranks = r?.ranks;
  if (!ranks?.attacker || !ranks?.defender) return '';
  const moved = Boolean(r?.seats?.swapped);
  const fmt = (side) => (side.before === side.after
    ? `第 ${side.before} 名`
    : `第 ${side.before} 名 → 第 ${side.after} 名`);
  return ` · 名次 ${fmt(ranks.attacker)}（攻）/ ${fmt(ranks.defender)}（守）${moved ? '' : '（未换位）'}`;
});

const winnerText = computed(() => {
  const r = report.value;
  if (!r) return '';
  if (r.winner === 'draw') return '平局（双方名次不变）';
  const name = r.winner === 'attacker' ? r.attacker?.name : r.defender?.name;
  return `${name}（${r.winner === 'attacker' ? '攻方' : '守方'}）`;
});

onMounted(() => {
  refresh();
  loadHoldersIfNeeded();
  timer = setInterval(refresh, REFRESH_MS);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

// ---------- 数据加载 ----------
/**
 * 整页刷新：并发拉五组只读数据，用 allSettled ——
 * 某一路失败（榜单翻页越界、装扮接口抖动）不该把已经渲染出来的其它卡片一起清空。
 */
async function refresh() {
  if (loading.value) return;
  loading.value = true;
  const jobs = [
    arenaApi.overview().then((res) => { overview.value = res?.data ?? null; }),
    loadLadder(ladderPage.value, true),
    loadMatches(matchPage.value, true),
    arenaApi.frames().then((res) => { entitlement.value = res?.data ?? null; }),
    arenaApi.seasonRewards().then((res) => { rewardConfig.value = res?.data ?? null; }),
  ];
  const settled = await Promise.allSettled(jobs);
  const failed = settled.find((s) => s.status === 'rejected');
  error.value = failed ? humanError(failed.reason) : '';
  loading.value = false;
}

async function loadLadder(page, keepError = false) {
  const res = await arenaApi.ladder(page);
  const data = res?.data ?? null;
  // 页码越界时服务端会回落第 1 页：同步回显，别让分页条停在空白页上
  if (data?.page && data.page !== page) ladderPage.value = data.page;
  else ladderPage.value = page;
  ladder.value = data;
  if (!keepError && data) error.value = '';
}

async function loadMatches(page, keepError = false) {
  const res = await arenaApi.matches(page);
  const data = res?.data ?? null;
  if (data?.page) matchPage.value = data.page;
  else matchPage.value = page;
  matches.value = data;
  if (!keepError && data) error.value = '';
}

async function goLadderPage(page) {
  const target = Math.max(1, Math.min(ladderPages.value, page));
  try {
    await loadLadder(target);
  } catch (e) {
    error.value = humanError(e);
  }
}

async function goMatchPage(page) {
  const target = Math.max(1, Math.min(matchPages.value, page));
  try {
    await loadMatches(target);
  } catch (e) {
    error.value = humanError(e);
  }
}

async function openReport(id) {
  reportOpen.value = true;
  reportId.value = Number(id) || 0;
  report.value = null;
  reportError.value = '';
  reportLoading.value = true;
  try {
    const res = await arenaApi.report(id);
    // 服务端对非参战方回 data:null（不是 403）：这里给一句人话，避免空白抽屉
    if (!res?.data) reportError.value = '战报不存在，或你不是这一场的参战方';
    else report.value = res.data;
  } catch (e) {
    reportError.value = humanError(e);
  } finally {
    reportLoading.value = false;
  }
}

function closeReport() {
  reportOpen.value = false;
  report.value = null;
  reportError.value = '';
}

// ---------- 写操作：全部经指令通道 ----------
/**
 * 唯一的写出口：发送与 QQ 端逐字相同的指令文本，回包 content 即结果（拒绝也在这段文本里）。
 * @param {string} cmd 指令文本
 * @param {{refetch?: boolean}} opts refetch=false 时由调用方自己决定补拉什么（如挑战后要开战报）
 * @returns {string} 指令回包文本（失败/异常返回空串）
 */
async function sendCommand(cmd, opts = {}) {
  if (running.value) {
    ui.pushToast({ type: 'info', message: '上一条指令还在执行中，稍等一下' });
    return '';
  }
  running.value = true;
  let text = '';
  try {
    const res = await commandApi.execute(cmd);
    text = String(res?.data?.content ?? '');
    // 竞技场回包常是多行长文本（战报正文），toast 只给首行，全文交给战报抽屉
    ui.pushToast({
      type: text.includes('成功') ? 'success' : 'info',
      message: text.split('\n')[0] || '指令已发送',
      timeout: 5000,
    });
  } catch (e) {
    ui.pushToast({ type: 'error', message: humanError(e) || `执行失败：${cmd}` });
  } finally {
    running.value = false;
    if (opts.refetch !== false) setTimeout(refresh, REFETCH_DELAY_MS);
  }
  return text;
}

/** 提交/刷新镜像：消耗与挑战各自独立计数（后端 submitMode 口径） */
async function submitMirror() {
  if (closedText.value) {
    ui.pushToast({ type: 'warning', message: closedText.value });
    return;
  }
  await sendCommand(CMD.submit);
}

/** 挑战：序号用全榜名次（服务端按名次回查镜像），与「挑战镜像 玩家名」等价 */
async function challenge(row) {
  const blocked = challengeBlock(row);
  if (blocked) {
    ui.pushToast({ type: 'warning', message: blocked });
    return;
  }
  const beforeId = Number(matchRows.value[0]?.id) || 0;
  const text = await sendCommand(CMD.challenge(row.rank), { refetch: false });
  if (!text) {
    setTimeout(refresh, REFETCH_DELAY_MS);
    return;
  }
  // 战斗已在服务端跑完：直接摊开最新一份战报回放，比在 toast 里塞整段回合文本可读
  try {
    await loadMatches(1);
    const newest = matchRows.value.find((r) => Number(r.id) > beforeId);
    if (newest) await openReport(newest.id);
  } catch (e) {
    error.value = humanError(e);
  }
  refresh();
}

/** 佩戴 / 卸下头像框（同一指令，「无」是服务端认的卸下键） */
async function wearFrame(frame) {
  await sendCommand(CMD.wear(frame.key));
}
async function unequipFrame() {
  await sendCommand(CMD.unequip);
}

// ---------- 管理（仅管理员可见，权限由服务端 RolesGuard 二次把关） ----------
async function loadHolders() {
  try {
    const res = await adminArenaApi.privileges(holdersKey.value);
    holderData.value = res?.data ?? null;
    if (res?.data?.key) holdersKey.value = res.data.key;
  } catch (e) {
    adminResult.value = `读取特权持有者失败：${humanError(e)}`;
  }
}

/** 只有管理员才多拉这一路，普通玩家不进这次请求（页面本来就要发五路） */
function loadHoldersIfNeeded() {
  if (!isAdmin.value) return;
  grantForm.value.key = holdersKey.value;
  loadHolders();
}

/** 管理动作统一出口：服务端把拒绝原因放 message、成功信息放 data，两种都要落到回显条上 */
async function runAdmin(label, action) {
  if (adminBusy.value) return;
  adminBusy.value = true;
  try {
    const res = await action();
    const payload = res?.data ?? {};
    const ok = res?.success !== false;
    const detail = typeof payload.text === 'string' && payload.text
      ? payload.text
      : (payload.endAt ? `新截止时间：${fmtDateTime(payload.endAt)}` : (payload.revoked ? `已撤销 ${payload.revoked} 条` : ''));
    adminResult.value = `${label}${ok ? '完成' : '失败'}${detail ? '：' + detail : ''}`;
    ui.pushToast({ type: ok ? 'success' : 'error', message: res?.message || adminResult.value });
    await Promise.all([loadHolders(), refresh()]);
  } catch (e) {
    adminResult.value = `${label}失败：${humanError(e)}`;
    ui.pushToast({ type: 'error', message: adminResult.value });
  } finally {
    adminBusy.value = false;
  }
}

function adminSettle() {
  if (!window.confirm('立即结算只会处理已到期的赛季（幂等），未到期不会发奖。确定执行？')) return;
  return runAdmin('赛季结算', () => adminArenaApi.settle());
}
function adminExtend() {
  const days = Number(extendDays.value);
  if (!Number.isFinite(days) || days < 0) {
    ui.pushToast({ type: 'warning', message: '请填写 0 或更大的天数（0 = 立刻到期）' });
    return;
  }
  return runAdmin('赛季改期', () => adminArenaApi.extendSeason(Math.floor(days)));
}
function adminGrant() {
  const userId = Number(grantForm.value.userId);
  const key = String(grantForm.value.key || '').trim();
  if (!userId || !key) {
    ui.pushToast({ type: 'warning', message: '授予需要玩家ID 与特权键' });
    return;
  }
  const days = Number(grantForm.value.days);
  return runAdmin(`授予特权 ${key}`, () => adminArenaApi.grantPrivilege({
    userId,
    key,
    days: Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 30,
    reason: String(grantForm.value.reason || '').trim() || undefined,
  }));
}
function adminRevoke(holder) {
  return runAdmin(`撤销 ${holder.userId} 的 ${holderData.value?.key || holdersKey.value}`, () => adminArenaApi.revokePrivilege({
    userId: holder.userId,
    key: holderData.value?.key || holdersKey.value,
  }));
}

// ---------- 展示工具 ----------
/** 挑战为什么不能点（返回空串表示可以打）；与后端门槛同口径但不自证，最终仍由服务端裁决 */
/** 这一场是不是练手局：守方排名不高于自己（服务端同口径判定，这里只用来做表现） */
function isPracticeTarget(row) {
  const myRank = Number(me.value?.rank) || 0;
  const rowRank = Number(row.rank) || 0;
  return myRank > 0 && rowRank >= myRank;
}
function challengeBlock(row) {
  if (closedText.value) return closedText.value;
  if (!myMirror.value) return NO_MIRROR_TEXT;
  if (Number(row.ownerId) === Number(me.value?.userId)) return '不能挑战自己的镜像';
  const practice = isPracticeTarget(row);
  const myRank = Number(me.value?.rank) || 0;
  const rowRank = Number(row.rank) || 0;
  // 每日次数只约束正式局：练手局免费不占次数，所以额度用完了也照样能打
  if (!practice && (Number(me.value?.dailyLeft) || 0) <= 0) {
    return '今日挑战次数已用完，明天 0 点重置（打排名不高于你的镜像是免费练手，不占次数）';
  }
  const window = Number(cfg.value?.challengeRankWindow) || 0;
  if (!practice && window > 0 && myRank && rowRank && myRank - rowRank > window) {
    return window === 1
      ? '只能一顺位往上打：先打赢排在你前面的那一个'
      : `一次最多能挑战高出 ${window} 名的对手`;
  }
  return '';
}

/** 入场/刷新消耗文案（与后端 costLabel 一致：free / 活力 / 门票） */
function costLabel(cost) {
  if (!cost) return '—';
  if (cost.mode === 'free') return '免费';
  if (cost.mode === 'ticket') return `${cost.ticketItem} ×${num(cost.ticketCost)}`;
  return `活力 ${num(cost.vitality)}`;
}

/** tone 字符串或带 tone 的定义对象（段位/头像框共用一份色表）→ 主题类 */
function toneClass(def) {
  const tone = typeof def === 'string' ? def : def?.tone;
  return TONE_CLASS[String(tone || '').trim()] || 'ar-tone-default';
}
/** 榜单行的 tier 是段位「名字」（库里存冗余名），按名字回查当前配置表的 tone */
function tierClassByName(name) {
  return toneClass(tiers.value.find((t) => t.name === name));
}

/** 头像框键 → 名称（未拥有过的键没有定义接口可查，v1 直接显示键名，不编名字） */
function frameName(key) {
  const hit = ownedFrames.value.find((f) => f.key === key);
  return hit ? hit.name : key;
}
/** 特权键 → 名称：拿当前生效特权的后端文案，查不到就显示键（避免前端另立一套命名） */
function privilegeName(key) {
  const hit = privileges.value.find((p) => p.key === key);
  return hit?.name || key;
}

/** 一个档位的奖励条目 → 展示 chips */
function rewardChips(band) {
  const chips = [];
  for (const title of band.titles || []) chips.push({ text: `🏅 称号 ${title}`, cls: 'title' });
  for (const frame of band.frames || []) chips.push({ text: `🖼️ 头像框 ${frameName(frame)}`, cls: 'frame' });
  for (const priv of band.privileges || []) {
    const days = Number(priv.days) || 0;
    chips.push({ text: `⚙️ 特权 ${privilegeName(priv.key)} ${days === 0 ? '永久' : `${days}天`}`, cls: 'priv' });
  }
  for (const item of band.rewards || []) {
    const type = item.type || 'item';
    const icon = REWARD_ICON[type] || '📦';
    const name = item.name || REWARD_TYPE_NAME[type] || type;
    chips.push({ text: `${icon} ${name} ×${num(item.quantity)}`, cls: 'item' });
  }
  return chips;
}

/** 战绩的胜负视角：row.attacked 表示我是攻方，winner 是绝对立场，两者换算成本人口吻 */
function resultText(row) {
  // 练手局不计胜败：标成「练」而不是胜/负，否则列表里看着像白捡的胜场
  if (row.practice) return '练';
  if (row.winner === 'draw') return '平';
  const iWin = (row.attacked && row.winner === 'attacker') || (!row.attacked && row.winner === 'defender');
  return iWin ? '胜' : '负';
}
function resultClass(row) {
  if (row.practice) return 'practice';
  if (row.winner === 'draw') return 'draw';
  return resultText(row) === '胜' ? 'win' : 'lose';
}
/**
 * 一场对局对「我」的名次做了什么：席位号（服务端内部排序键）不外露，
 * 只说结果——换没换位、往哪边换。
 */
function rankChangeText(row) {
  if (row.practice) return '练手局：不计成绩、不动名次';
  if (row.attacked) return row.swapped ? '打赢：顶替了他的名次' : '名次不变';
  return row.swapped ? '被顶替：名次让给了对手' : '守住了名次';
}
/** 段位区间文案：rankTo=0 是「不设上限」，写成 101+ 比 101~∞ 更像榜单 */
function tierRangeText(tier) {
  const from = Number(tier.rankFrom) || 1;
  const to = Number(tier.rankTo) || 0;
  if (!to || to <= from) return `第 ${from} 名`;
  return `${from}-${to}`;
}
/** 分页条：首尾恒定 + 当前页前后各一页，中间用省略号占位（页数可能上百） */
function pageButtons(current, pages) {
  const total = Math.max(1, pages || 1);
  const list = [];
  for (let p = 1; p <= total; p += 1) {
    if (p === 1 || p === total || Math.abs(p - current) <= 1) list.push(p);
    else if (list[list.length - 1] !== 0) list.push(0);
  }
  return list;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}
/** MM-DD HH:mm：赛季截止、战报时刻统一口径（年份在当前赛季内是噪音） */
function fmtDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}
/** 多久以前（与后端 formatAgo 同口径，同一份数据两条入口别各说一套话） */
function fmtAgo(ms) {
  const at = Number(ms) || 0;
  if (!at) return '';
  const diff = Math.max(0, Date.now() - at);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}
function sourceText(source) {
  const map = { season: '赛季奖励', admin: '后台授予', command: '指令发放' };
  return map[source] || source;
}
function humanError(e) {
  return e?.response?.data?.message || e?.message || '';
}
function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}
</script>

<style scoped>
/* 主题色变量（tone → 描边/文字色）在 .ar-tone-* 上定义，段位徽标与头像框共用一份 */
.ar-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg2, #14102a);
  color: var(--text, #f1f1f9);
  font-size: 13px;
  overflow: hidden;
}

/* ---------- 顶栏 ---------- */
.ar-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg3, #1e1a3a);
  flex-shrink: 0;
}
.ar-back {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2, #14102a);
  color: var(--text, #f1f1f9);
  cursor: pointer;
  font-size: 16px;
}
.ar-back:hover {
  filter: brightness(1.2);
}
.ar-head-main {
  min-width: 0;
  flex: 1;
}
.ar-title {
  font-size: 16px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}
.ar-warn {
  color: #f87171;
}
.ar-ok {
  color: #4ade80;
}
.ar-head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* ---------- 主体 ---------- */
.ar-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
.ar-loading.err {
  color: #f87171;
}
.ar-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ar-banner {
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.08);
  color: #fca5a5;
  font-size: 12px;
}

/* ---------- 卡片 ---------- */
.ar-block {
  background: linear-gradient(160deg, var(--bg3, #1e1a3a), rgba(20, 16, 42, 0.8));
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
}
.ar-block.admin {
  border-color: rgba(248, 113, 113, 0.35);
}
.ar-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 14px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.ar-b-chip {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 15px;
  flex-shrink: 0;
}
/* 卡片标题与右侧说明各占一头：小屏允许说明换行，标题不参与收缩 */
.ar-b-title {
  flex-shrink: 0;
}
.ar-b-chip.me { background: rgba(139, 92, 246, 0.2); }
.ar-b-chip.ladder { background: rgba(251, 191, 36, 0.18); }
.ar-b-chip.history { background: rgba(6, 182, 212, 0.18); }
.ar-b-chip.reward { background: rgba(236, 72, 153, 0.18); }
.ar-b-chip.dress { background: rgba(74, 222, 128, 0.16); }
.ar-b-chip.admin { background: rgba(248, 113, 113, 0.18); }
.ar-b-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
  font-weight: 500;
}

/* ---------- 我的天梯 ---------- */
.ar-stat-row {
  display: flex;
  gap: 10px;
}
.ar-stat {
  flex: 1;
  min-width: 0;
  text-align: center;
  background: var(--bg2, #14102a);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 4px;
}
.ar-stat-val {
  font-size: 20px;
  font-weight: 800;
}
.ar-stat-val em {
  font-style: normal;
  font-size: 13px;
  color: var(--muted);
  font-weight: 600;
}
.ar-stat-val.warn {
  color: #f87171;
}
.ar-stat-label {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.ar-bar {
  height: 6px;
  border-radius: 4px;
  background: rgba(139, 92, 246, 0.14);
  overflow: hidden;
  margin-top: 8px;
}
.ar-bar-fill {
  height: 100%;
  background: var(--accent-gradient);
  border-radius: 4px;
  transition: width 0.4s ease;
}
/* 段位刻度条：阈值全展示，一眼看出「后台改了线，这里跟着变」 */
.ar-scale {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 10px;
}
.ar-tier {
  padding: 2px 8px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid var(--ar-tone, var(--border));
  color: var(--ar-tone, var(--text));
  background: rgba(255, 255, 255, 0.03);
}
.ar-tier.on {
  background: var(--ar-tone-soft, rgba(139, 92, 246, 0.18));
  box-shadow: 0 0 10px var(--ar-tone-soft, rgba(139, 92, 246, 0.3));
}
.ar-mirror {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  background: rgba(6, 182, 212, 0.05);
}
.ar-mirror-main {
  flex: 1;
  min-width: 0;
}
.ar-mirror-title {
  font-weight: 700;
}
.ar-mirror-sub {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.ar-mirror-hint {
  font-size: 11px;
  color: #fb923c;
  margin-top: 4px;
  line-height: 1.5;
}

/* ---------- 表格 ---------- */
.ar-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.ar-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  min-width: 640px;
}
.ar-table th,
.ar-table td {
  padding: 7px 8px;
  text-align: left;
  border-bottom: 1px solid rgba(42, 31, 94, 0.6);
  white-space: nowrap;
}
.ar-table th {
  color: var(--muted);
  font-weight: 600;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.18);
}
.ar-table tr:last-child td {
  border-bottom: none;
}
.ar-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ar-table td.rank {
  font-weight: 800;
  color: #fbbf24;
}
.ar-table td.name {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ar-table td.ver em {
  font-style: normal;
  color: var(--muted);
  margin-left: 6px;
  font-size: 11px;
}
.ar-table tr.mine td {
  background: rgba(139, 92, 246, 0.1);
}
.ar-table tr.crit td {
  color: #fbbf24;
}
.ar-table tr.miss td {
  color: var(--muted-dark, #6b6b8a);
}
.ar-table td.pools {
  font-size: 11px;
  color: var(--muted);
}

/* ---------- 分页 ---------- */
.ar-pager {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.ar-btn.page {
  min-width: 30px;
}
.ar-btn.page.on {
  border-color: var(--accent);
  color: var(--text);
  background: rgba(139, 92, 246, 0.2);
}
/* 省略号占位（pageButtons 用 0 表示跳号）：纯文本，不参与翻页 */
.ar-dots {
  padding: 0 4px;
  color: var(--muted);
}
.ar-dim {
  color: var(--muted);
  font-size: 11px;
  margin-left: auto;
}

/* ---------- 战绩 ---------- */
.ar-match-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ar-match {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--bg2, #14102a);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.ar-result {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-weight: 800;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.05);
}
.ar-result.win { color: #4ade80; background: rgba(74, 222, 128, 0.14); }
.ar-result.lose { color: #f87171; background: rgba(248, 113, 113, 0.14); }
.ar-result.draw { color: var(--muted); }
/* 练手局：中性描边，明确不是成绩 */
.ar-result.practice { color: #9ca3af; background: rgba(156, 163, 175, 0.12); border: 1px dashed rgba(156, 163, 175, 0.5); }
.ar-match-main {
  flex: 1;
  min-width: 0;
}
.ar-match-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar-match-title em {
  font-style: normal;
  color: var(--muted);
  font-size: 11px;
  margin-left: 6px;
}
.ar-match-sub {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
/* 名次互换制的两种结局：换过位（打赢或被顶下去）值得着色，没动过就是常态 */
.ar-rank-move {
  color: #fbbf24;
}
.ar-rank-keep {
  color: var(--muted);
}
.ar-match-time {
  font-size: 11px;
  color: var(--muted-dark, #6b6b8a);
  flex-shrink: 0;
}

/* ---------- 赛季奖励 ---------- */
.ar-bands {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ar-band {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 10px;
  background: var(--bg2, #14102a);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.ar-band.part {
  border-style: dashed;
}
.ar-band-rank {
  width: 118px;
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1.5;
}
.ar-band-rank em {
  display: block;
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}
.ar-band-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.ar-chip {
  padding: 3px 8px;
  border-radius: 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.03);
}
.ar-chip.title { color: #fbbf24; border-color: rgba(251, 191, 36, 0.35); }
.ar-chip.frame { color: #a78bfa; border-color: rgba(167, 139, 250, 0.35); }
.ar-chip.priv { color: #4ade80; border-color: rgba(74, 222, 128, 0.35); }
.ar-chip.item { color: var(--text-secondary, #c8c8e0); }

/* ---------- 装扮 ---------- */
.ar-frames {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}
.ar-frame {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  background: var(--bg2, #14102a);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.ar-frame.on {
  border-color: var(--ar-tone, var(--accent));
}
.ar-frame-ring {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 头像框的呈现方式：外圈 2px 描边 + 同色光晕，不遮盖头像本体 */
  box-shadow: 0 0 0 2px var(--ar-tone, var(--accent)), 0 0 12px var(--ar-tone-soft, rgba(139, 92, 246, 0.45));
}
.ar-frame-av {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg4, #2a1f5e);
  font-weight: 700;
  font-size: 14px;
}
.ar-frame-main {
  flex: 1;
  min-width: 0;
}
.ar-frame-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar-frame-name em {
  font-style: normal;
  font-size: 11px;
  color: var(--ar-tone, var(--accent));
  margin-left: 6px;
}
.ar-frame-desc {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
  line-height: 1.5;
}
.ar-priv-head {
  margin: 12px 0 6px;
  font-weight: 700;
  font-size: 12px;
  color: var(--text-secondary, #c8c8e0);
}
.ar-privs {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ar-priv {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  background: var(--bg2, #14102a);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 12px;
}
.ar-priv-name {
  font-weight: 600;
}
.ar-priv-expire {
  margin-left: auto;
  color: #4ade80;
  font-size: 11px;
  white-space: nowrap;
}
.ar-priv-reason {
  color: var(--muted);
  font-size: 11px;
}

/* ---------- 空态 / 按钮 / 输入 ---------- */
.ar-empty {
  padding: 18px 10px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  background: var(--bg2, #14102a);
  border: 1px dashed var(--border);
  border-radius: 12px;
}
.ar-empty.slim {
  padding: 12px 10px;
}
.ar-btn {
  border: 1px solid var(--border);
  background: var(--bg3, #1e1a3a);
  color: var(--text, #f1f1f9);
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.15s ease;
}
.ar-btn:hover:not(:disabled) {
  filter: brightness(1.15);
}
.ar-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.ar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ar-btn.ghost {
  background: transparent;
}
.ar-btn.tiny {
  padding: 4px 9px;
  font-size: 12px;
  border-radius: 8px;
}
.ar-btn.primary {
  background: linear-gradient(135deg, #8b5cf6, #06b6d4);
  border-color: rgba(139, 92, 246, 0.6);
}
.ar-btn.danger {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  border-color: rgba(239, 68, 68, 0.6);
}
.ar-btn.danger.ghost {
  background: transparent;
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.45);
}
.ar-admin-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.ar-input {
  background: var(--bg2, #14102a);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text, #f1f1f9);
  padding: 6px 8px;
  font-size: 12px;
  min-width: 0;
  flex: 1;
}
.ar-input.short {
  flex: 0 0 92px;
  width: 92px;
}
.ar-admin-result {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-line;
}

/* ---------- 战报抽屉 ---------- */
.ar-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
  animation: ar-fade 0.2s ease;
}
.ar-drawer {
  width: min(880px, 100%);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg2, #14102a);
  border-left: 1px solid var(--border);
  box-shadow: -20px 0 50px rgba(0, 0, 0, 0.5);
  animation: ar-slide 0.22s ease;
}
.ar-drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg3, #1e1a3a);
  flex-shrink: 0;
}
.ar-drawer-head-main {
  flex: 1;
  min-width: 0;
}
.ar-drawer-title {
  font-size: 15px;
  font-weight: 700;
}
.ar-drawer-sub {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
/* 正文整体可滚：回合表可能上百行，再套一层表内滚动条在手机上很难用 */
.ar-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ar-sides {
  display: flex;
  gap: 10px;
  padding: 12px 14px 0;
}
.ar-side {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg3, #1e1a3a);
}
.ar-side.win {
  border-color: rgba(74, 222, 128, 0.5);
}
.ar-side.me {
  background: rgba(139, 92, 246, 0.12);
}
.ar-side-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar-side-sub,
.ar-side-taken {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.ar-side-pools {
  display: flex;
  gap: 8px;
  font-size: 11px;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.ar-table-wrap.round {
  margin: 12px 14px 0;
}
/* 正文：等宽块保住服务端文本的全角对齐与分隔线 */
.ar-lines {
  margin: 12px 14px 16px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.3);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}
.ar-empty + .ar-btn,
.ar-frames + .ar-btn {
  margin-top: 8px;
}

/* ---------- tone 色表（段位 + 头像框共用）----------
   --ar-tone 描边/文字色，--ar-tone-soft 同色低透明底（QQ 内置浏览器不支持 color-mix，
   这里老老实实写两遍 rgba，别指望运行时混色）。 */
.ar-tone-gold { --ar-tone: #fbbf24; --ar-tone-soft: rgba(251, 191, 36, 0.18); }
.ar-tone-purple { --ar-tone: #a78bfa; --ar-tone-soft: rgba(167, 139, 250, 0.18); }
.ar-tone-cyan { --ar-tone: #22d3ee; --ar-tone-soft: rgba(34, 211, 238, 0.18); }
.ar-tone-silverblue { --ar-tone: #93c5fd; --ar-tone-soft: rgba(147, 197, 253, 0.18); }
.ar-tone-bronzegold { --ar-tone: #d97706; --ar-tone-soft: rgba(217, 119, 6, 0.18); }
.ar-tone-silver { --ar-tone: #cbd5e1; --ar-tone-soft: rgba(203, 213, 225, 0.18); }
.ar-tone-brown { --ar-tone: #b45309; --ar-tone-soft: rgba(180, 83, 9, 0.2); }
.ar-tone-default { --ar-tone: #8b5cf6; --ar-tone-soft: rgba(139, 92, 246, 0.18); }

/* ---------- 窄屏（手机 / QQ 内置浏览器）---------- */
@media (max-width: 640px) {
  .ar-top {
    flex-wrap: wrap;
  }
  .ar-body {
    padding: 10px;
  }
  .ar-block-head {
    font-size: 13px;
  }
  .ar-b-note {
    margin-left: 0;
    width: 100%;
  }
  .ar-stat-row {
    gap: 6px;
  }
  .ar-stat-val {
    font-size: 17px;
  }
  .ar-mirror {
    flex-wrap: wrap;
  }
  .ar-mirror .ar-btn {
    width: 100%;
  }
  .ar-band {
    flex-direction: column;
    gap: 6px;
  }
  .ar-band-rank {
    width: 100%;
  }
  .ar-frames {
    grid-template-columns: 1fr;
  }
  .ar-sides {
    flex-direction: column;
  }
  /* 窄屏抽屉内缩统一到 10px：自带 padding 的块改 padding，表格与正文块改 margin（两者叠加会双倍留白） */
  .ar-table-wrap.round,
  .ar-lines {
    margin-left: 10px;
    margin-right: 10px;
  }
  .ar-drawer-head,
  .ar-sides {
    padding-left: 10px;
    padding-right: 10px;
  }
}
</style>
