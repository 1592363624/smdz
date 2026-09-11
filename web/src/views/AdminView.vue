<template>
  <div class="admin-page">
    <!-- 顶栏 -->
    <header class="admin-header">
      <h1>⚙️ 管理员后台</h1>
      <div class="header-actions">
        <button class="btn-ghost" @click="goChat">← 返回公屏</button>
        <button class="btn-ghost" @click="logout">退出</button>
      </div>
    </header>

    <!-- 标签页 -->
    <nav class="tabs">
      <button :class="['tab', tab === 'dashboard' && 'active']" @click="tab = 'dashboard'">📊 仪表盘</button>
      <button :class="['tab', tab === 'gamedata' && 'active']" @click="tab = 'gamedata'">🗃️ 数据管理</button>
      <button :class="['tab', tab === 'config' && 'active']" @click="tab = 'config'">⚙️ 系统配置</button>
      <button :class="['tab', tab === 'users' && 'active']" @click="tab = 'users'">👥 用户管理</button>
      <button :class="['tab', tab === 'gm' && 'active']" @click="tab = 'gm'">🔧 GM 工具</button>
      <button :class="['tab', tab === 'logs' && 'active']" @click="tab = 'logs'">📜 后台日志</button>
    </nav>

    <main class="admin-content">
      <!-- ===== 后台日志（只读） ===== -->
      <section v-if="tab === 'logs'" class="panel panel-wide">
        <div class="panel-head">
          <h2>后台日志</h2>
          <p class="hint">
            集中查看服务器标准输出/错误日志（pm2 落盘的 out.log / error.log）。支持关键字与级别过滤、尾部行数控制、3 秒增量跟随刷新。只读视图，不可修改或清理日志文件。
          </p>
        </div>
        <LogViewerPanel />
      </section>

      <!-- ===== 数据管理（模块化静态数据 CRUD） ===== -->
      <section v-if="tab === 'gamedata'" class="panel panel-wide">
        <div class="panel-head">
          <h2>数据管理</h2>
          <p class="hint">
            可视化管理物品、装备、怪物、地图、任务成就等静态游戏配置（JSON）。支持新增/编辑/复制/删除与全文搜索，保存后自动备份原文件并热生效，无需重启服务。
          </p>
        </div>
        <GameDataPanel />
      </section>

      <!-- ===== 仪表盘 ===== -->
      <section v-if="tab === 'dashboard'" class="panel">
        <div class="panel-head">
          <h2>服务器状态</h2>
        </div>

        <!-- 统计卡片 -->
        <div class="stat-cards">
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalUsers || '-' }}</div>
            <div class="stat-label">总用户数</div>
            <div class="stat-sub">注册用户总量</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalPlayers || '-' }}</div>
            <div class="stat-label">游戏角色</div>
            <div class="stat-sub">已创建角色</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalMaps || '-' }}</div>
            <div class="stat-label">地图数量</div>
            <div class="stat-sub">可探索区域</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalMonsters || '-' }}</div>
            <div class="stat-label">怪物总数</div>
            <div class="stat-sub">全服怪物</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalItems || '-' }}</div>
            <div class="stat-label">物品总数</div>
            <div class="stat-sub">装备/道具</div>
          </div>
        </div>

        <!-- 世界等级 -->
        <div class="world-level-display">
          <span class="wl-label">🌍 世界等级</span>
          <span class="wl-value">{{ worldLevel }}</span>
          <div class="wl-controls">
            <input v-model.number="newWorldLevel" type="number" min="1" max="999" />
            <button class="gm-btn" @click="setWorldLevel" :disabled="gmLoading">设置</button>
          </div>
        </div>
      </section>

      <!-- ===== 系统配置 ===== -->
      <section v-if="tab === 'config'" class="panel panel-wide">
        <div class="panel-head">
          <h2>系统配置中心</h2>
          <p class="hint">修改后立即生效，无需重启服务。可按分组管理指令、游戏等各类配置。</p>
        </div>

        <div class="config-groups">
          <div v-for="grp in configGroups" :key="grp.name" class="config-group">
            <h3>{{ grp.label }}</h3>
            <div class="config-grid">
              <template v-for="cfg in grp.items" :key="cfg.key">
                <!-- 全局熟练度：平铺卡片编辑器（对齐背包管理视觉；默认按点数从大到小） -->
                <div v-if="cfg.key === 'game.globalMarkers'" class="config-item config-item-wide">
                  <div class="config-info">
                    <span class="config-label">{{ cfg.label }}</span>
                    <span class="config-desc">{{ cfg.description }}</span>
                  </div>
                  <div class="prof-editor">
                    <div class="bk-toolbar">
                      <div class="bk-search">
                        <span class="bk-search-icon">⌕</span>
                        <input v-model="globalProfSearch" type="text" placeholder="搜索熟练度名称…" />
                      </div>
                      <span class="prof-world">世界等级 <strong>{{ globalProfWorldLevel }}</strong>（点数 {{ globalProfWorldPoints }}）· 请用 GM 工具修改</span>
                      <span class="bk-stat"><b>{{ globalProfVisible.length }}</b>/<b>{{ globalProfEditable.length }}</b> 项</span>
                      <button class="bk-toggle" type="button" @click="addGlobalProfRow">＋ 添加</button>
                      <button class="gm-btn success" type="button" @click="saveGlobalProf(cfg)">保存熟练度</button>
                      <span class="saved-tip" :class="{ show: savedKey === cfg.key }">✓ 已保存</span>
                    </div>
                    <div v-if="globalProfError" class="prof-error">{{ globalProfError }}</div>
                    <div class="bk-grid prof-grid">
                      <div
                        v-for="row in globalProfVisible"
                        :key="'prof-' + row.uid"
                        class="bk-card prof-card"
                      >
                        <div class="prof-card-row">
                          <input
                            v-model="row.name"
                            class="prof-card-name"
                            :size="nameInputSize(row.name)"
                            placeholder="名称"
                            title="名称（保存时自动补「熟练度」后缀）"
                          />
                          <input
                            v-model.number="row.points"
                            class="bk-qin prof-card-points"
                            type="number"
                            min="0"
                            step="1"
                            title="熟练度点数"
                          />
                          <span class="prof-lv-badge">Lv.{{ profLevel(row.points) }}</span>
                          <button class="bk-card-x" type="button" title="删除" @click="removeGlobalProfByUid(row.uid)">✕</button>
                        </div>
                      </div>
                      <div v-if="!globalProfVisible.length" class="bk-empty">
                        {{ globalProfEditable.length ? '没有匹配的熟练度' : '暂无怪物/物种熟练度' }}
                        <span v-if="globalProfEditable.length">换个关键词试试</span>
                        <span v-else>点「＋ 添加」新建条目；世界等级请用 GM 工具</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-else class="config-item">
                  <div class="config-info">
                    <span class="config-label">{{ cfg.label }}</span>
                    <span class="config-desc">{{ cfg.description }}</span>
                  </div>
                  <div class="config-editor">
                    <!-- 布尔类型 -->
                    <select v-if="cfg.type === 'boolean'" :value="cfg.value === 'true'" @change="saveConfig(cfg, $event.target.value === 'true')">
                      <option :value="true">是</option>
                      <option :value="false">否</option>
                    </select>
                    <!-- 字符串数组 -->
                    <input v-else-if="cfg.type === 'string-array'" :value="arrayValue(cfg.value)" @change="saveConfig(cfg, stringToArray($event.target.value))" placeholder="逗号分隔多个值" />
                    <!-- 数字 / 文本 -->
                    <input v-else :value="cfg.value" @change="saveConfig(cfg, cfg.type === 'number' ? Number($event.target.value) : $event.target.value)" />
                    <span class="saved-tip" :class="{ show: savedKey === cfg.key }">✓ 已保存</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </section>

      <!-- ===== 用户管理 ===== -->
      <section v-if="tab === 'users'" class="panel panel-wide">
        <div class="panel-head">
          <h2>用户管理</h2>
          <p class="hint">管理平台注册用户：默认在线优先，支持关键词搜索、每页条数切换与表头点击排序。</p>
        </div>

        <div class="user-toolbar">
          <div class="user-search">
            <input v-model="keyword" placeholder="搜索用户名/昵称/QQ" @keyup.enter="loadUsers(1)" />
            <button class="btn-primary" @click="loadUsers(1)">🔍 搜索</button>
            <button v-if="keyword" class="btn-ghost" @click="keyword = ''; loadUsers(1)">重置</button>
          </div>
          <div class="user-meta">
            <label class="page-size-label">
              每页
              <select v-model="pageSize" class="page-size-select" @change="loadUsers(1)">
                <option v-for="s in pageSizeOptions" :key="s" :value="s">{{ s }}</option>
              </select>
              条
            </label>
            <span class="total-count">共 {{ total }} 人</span>
          </div>
        </div>

        <!-- 批量操作栏：勾选行后出现 -->
        <div v-if="selectedIds.length > 0" class="batch-bar">
          <span class="batch-count">已选 <strong>{{ selectedIds.length }}</strong> 人</span>
          <button
            class="batch-btn warning"
            title="清空所选玩家的游戏进度(保留账号，可重新开局)"
            :disabled="batchLoading"
            @click="batchResetSelected"
          >🧹 清空所选数据</button>
          <button
            class="batch-btn danger"
            title="删除所选账号(级联删除其角色数据；自动跳过自己和超级管理员)"
            :disabled="batchLoading"
            @click="batchDeleteSelected"
          >🗑️ 删除所选账号</button>
          <button class="batch-btn ghost" :disabled="batchLoading" @click="selectedIds = []">取消选择</button>
          <span v-if="batchResult" class="batch-result">{{ batchResult }}</span>
        </div>

        <div class="table-wrap">
          <table class="user-table">
            <thead>
              <tr>
                <th class="check-cell">
                  <input
                    type="checkbox"
                    title="全选/取消全选本页"
                    :checked="isPageAllSelected"
                    @change="toggleSelectAll($event.target.checked)"
                  />
                </th>
                <th class="sortable" :class="sortClass('id')" @click="handleSort('id')">
                  <span>ID</span><i class="sort-icon"></i>
                </th>
                <th>
                  <span>头像</span>
                </th>
                <th class="sortable" :class="sortClass('nickname')" @click="handleSort('nickname')">
                  <span>昵称</span><i class="sort-icon"></i>
                </th>
                <th class="sortable" :class="sortClass('role')" @click="handleSort('role')">
                  <span>角色</span><i class="sort-icon"></i>
                </th>
                <th class="sortable" :class="sortClass('status')" @click="handleSort('status')">
                  <span>状态</span><i class="sort-icon"></i>
                </th>
                <th>
                  <span>玩家信息</span>
                </th>
                <th>
                  <span>在线</span>
                </th>
                <th class="sortable" :class="sortClass('level')" @click="handleSort('level')">
                  <span>等级</span><i class="sort-icon"></i>
                </th>
                <th class="sortable" :class="sortClass('location')" @click="handleSort('location')">
                  <span>位置</span><i class="sort-icon"></i>
                </th>
                <th>
                  <span>累计在线</span>
                </th>
                <th class="sortable" :class="sortClass('lastLoginAt')" @click="handleSort('lastLoginAt')">
                  <span>最后登录</span><i class="sort-icon"></i>
                </th>
                <th>
                  <span>操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td class="check-cell">
                  <input
                    type="checkbox"
                    :checked="selectedIds.includes(u.id)"
                    @change="toggleSelect(u, $event.target.checked)"
                  />
                </td>
                <td class="mono-cell">{{ u.id }}</td>
                <td>
                  <div class="avatar-cell" :title="u.username">
                    <img
                      v-if="u.avatar && !avatarFailed.has(u.id)"
                      class="user-avatar"
                      :src="u.avatar"
                      :alt="u.nickname || u.username"
                      @error="avatarFailed.add(u.id)"
                    />
                    <span v-else class="user-avatar fallback">{{ (u.nickname || u.username || '?').slice(0, 1) }}</span>
                  </div>
                  <div v-if="u.qqNumber" class="qq-ext">QQ: {{ u.qqNumber }}</div>
                </td>
                <td>
                  <input class="inline-input" :value="u.nickname" @change="updateUser(u, { nickname: $event.target.value })" />
                </td>
                <td>
                  <select class="role-select" :value="u.role" @change="updateUser(u, { role: $event.target.value })">
                    <option value="USER">USER</option>
                    <option value="ADMIN">ADMIN</option>
                    <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                  </select>
                </td>
                <td>
                  <select class="status-select" :value="u.status" @change="updateUser(u, { status: $event.target.value })">
                    <option value="ACTIVE">正常</option>
                    <option value="BANNED">封禁</option>
                  </select>
                </td>
                <td>
                  <template v-if="u.player">
                    <span v-if="u.player.name" class="player-tag">{{ u.player.name }}</span>
                    <span v-else class="muted">冒险者</span>
                  </template>
                  <span v-else class="muted">未创建角色</span>
                </td>
                <td>
                  <span :class="['online-dot', u.online ? 'on' : 'off']"></span>
                  {{ u.online ? '在线' : '离线' }}
                </td>
                <td>
                  <span v-if="u.player" class="player-tag lv">{{ u.player.level }}级</span>
                  <span v-else class="muted">-</span>
                </td>
                <td>
                  <span v-if="u.player?.location" class="player-tag loc">{{ u.player.location }}</span>
                  <span v-else class="muted">-</span>
                </td>
                <td class="time-cell">
                  <span>{{ formatDuration(u.playTimeSeconds) }}</span>
                </td>
                <td class="time-cell">
                  <div>{{ formatTime(u.lastLoginAt) || '从未' }}</div>
                  <div class="time-sub">{{ u.loginCount ?? 0 }} 次</div>
                </td>
                <td>
                  <div class="action-group">
                    <span v-if="savedUser === u.id" class="saved-badge">✓</span>
                    <button class="action-btn info" title="查看/编辑用户详细数据" @click="openUserDetail(u)">详情</button>
                    <button
                      class="action-btn warning"
                      title="清空该玩家的游戏进度(保留账号，可重新选使魔开局)"
                      @click="resetUserData(u)"
                    >清空</button>
                    <button class="action-btn danger" title="删除用户(级联删除其角色数据)" @click="deleteUser(u)" :disabled="u.id === user?.id">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pagination user-pagination">
          <div class="pagination-info">
            第 <strong>{{ page }}</strong> 页 / 共 <strong>{{ Math.ceil(total / pageSize) || 1 }}</strong> 页
          </div>
          <div class="pagination-actions">
            <button :disabled="page <= 1" @click="loadUsers(page - 1)">上一页</button>
            <button :disabled="page >= Math.ceil(total / pageSize)" @click="loadUsers(page + 1)">下一页</button>
            <button
              class="batch-btn danger reset-all-btn"
              title="清空全服所有玩家的游戏进度(保留所有账号)；人数多时耗时较长"
              :disabled="batchLoading"
              @click="resetAllData"
            >⚠️ 一键清空全部玩家数据</button>
          </div>
        </div>

        <!-- 用户详情 / 编辑弹窗 -->
        <div v-if="detailUser" class="modal-mask" @click.self="closeUserDetail">
          <div class="modal-box" :class="{ wide: detailTab === 'backpack' && editForm }">
            <div class="modal-head">
              <h3>
                用户详情
                <span :class="['online-dot', detailUser.online ? 'on' : 'off']"></span>
                <small class="muted">#{{ detailUser.id }} · {{ detailUser.username }}</small>
              </h3>
              <button class="modal-close" @click="closeUserDetail">×</button>
            </div>

            <div v-if="detailLoading" class="fb-empty">加载中...</div>
            <template v-else>
              <!-- 账号信息（只读 + 可改的绑定QQ） -->
              <div class="detail-grid">
                <div class="detail-item"><label>昵称</label><span>{{ detailUser.nickname || '-' }}</span></div>
                <div class="detail-item">
                  <label>QQ号（修改即保存，清空解绑）</label>
                  <input
                    class="qq-edit-input"
                    :value="detailUser.qqNumber || ''"
                    placeholder="未绑定"
                    @change="saveUserField({ qqNumber: $event.target.value.trim() })"
                  />
                </div>
                <div class="detail-item"><label>注册时间</label><span>{{ formatTime(detailUser.createdAt) || '-' }}</span></div>
                <div class="detail-item"><label>最后登录</label><span>{{ formatTime(detailUser.lastLoginAt) || '从未' }}（{{ detailUser.loginCount ?? 0 }} 次）</span></div>
                <div class="detail-item"><label>累计在线时长</label><span>{{ formatDuration(detailPlayer?.playTimeSeconds) }}</span></div>
                <div class="detail-item"><label>互联ID</label><span class="mono">{{ detailUser.externalId || '-' }}</span></div>
              </div>

              <template v-if="editForm">
                <!-- 详情弹窗内页签：游戏数据编辑 / 背包管理 -->
                <div class="detail-tabs">
                  <button class="dt-tab" :class="{ on: detailTab === 'data' }" @click="detailTab = 'data'">游戏数据</button>
                  <button class="dt-tab" :class="{ on: detailTab === 'backpack' }" @click="switchBackpackTab">背包管理</button>
                </div>

                <!-- 页签：游戏数据编辑 -->
                <template v-if="detailTab === 'data'">
                  <p class="hint" style="margin: 10px 0 6px;">游戏数据编辑（留空的字段不会被修改，保存后即时生效）：</p>
                  <div class="edit-grid">
                    <label v-for="f in editableFields" :key="f.field" class="edit-field">
                      <span>{{ f.label }}</span>
                      <input v-model="editForm[f.field]" :placeholder="'当前: ' + currentDisplay(f)" />
                    </label>
                  </div>

                  <div class="modal-foot">
                    <button class="gm-btn success" :disabled="editSaving" @click="savePlayerEdit">{{ editSaving ? '保存中...' : '保存修改' }}</button>
                    <span v-if="editResult" :class="['edit-result', editError && 'err']">{{ editResult }}</span>
                  </div>
                </template>

                <!-- 页签：背包管理（平铺卡片 + 背包内搜索 + 右侧目录添加） -->
                <template v-else>
                  <p class="hint" style="margin: 10px 0 6px;">
                    背包管理：编辑 <b>{{ gmBackpack.username }}</b> 背包中的物品数量，可增删。
                  </p>
                  <div v-if="gmBackpackLoading" class="fb-empty">背包加载中…</div>
                  <template v-else>
                    <div class="bk-toolbar">
                      <div class="bk-search">
                        <span class="bk-search-icon">⌕</span>
                        <input v-model="bkSearchQuery" type="text" placeholder="搜索背包物品…" />
                      </div>
                      <div class="bk-chips">
                        <button
                          v-for="t in bkTypeOptions"
                          :key="t"
                          class="bk-chip"
                          :class="{ on: bkFilterType === t }"
                          @click="bkFilterType = t"
                        >{{ t === 'all' ? '全部' : t }}</button>
                      </div>
                      <span class="bk-stat">
                        <b>{{ bkVisibleItems.length }}</b>/<b>{{ gmBackpack.items.length }}</b> 种
                      </span>
                      <button class="bk-toggle" :class="{ on: bkCatalogOpen }" @click="bkCatalogOpen = !bkCatalogOpen">＋ 添加</button>
                    </div>

                    <div class="bk-layout" :class="{ 'no-cat': !bkCatalogOpen }">
                      <div class="bk-grid">
                        <div
                          v-for="it in bkVisibleItems"
                          :key="it.name"
                          class="bk-card"
                          :class="bkTypeClass(it.type)"
                        >
                          <div class="bk-card-top">
                            <span class="bk-card-name" :title="it.name">
                              {{ it.name }}<i v-if="isCurrencyName(it.name)" class="bk-cur-badge">货币</i>
                            </span>
                            <button
                              class="bk-card-x"
                              :class="{ danger: isCurrencyName(it.name) }"
                              :title="isCurrencyName(it.name) ? '删除将清零该货币（会二次确认）' : '删除'"
                              @click="removeBackpackItem(it)"
                            >✕</button>
                          </div>
                          <div class="bk-qty">
                            <button class="bk-qbtn" title="−1" @click="bumpBackpackQty(it, -1)">−</button>
                            <input
                              v-model.number="it.quantity"
                              class="bk-qin"
                              type="number"
                              min="0"
                              step="any"
                              title="数量（0 表示删除，支持小数）"
                            />
                            <button class="bk-qbtn" title="+1" @click="bumpBackpackQty(it, 1)">＋</button>
                          </div>
                        </div>
                        <div v-if="!bkVisibleItems.length" class="bk-empty">
                          {{ gmBackpack.items.length ? '没有匹配的物品' : '背包为空' }}
                          <span v-if="gmBackpack.items.length">换个关键词，或从右侧目录添加</span>
                          <span v-else>可通过右侧目录添加物品</span>
                        </div>
                      </div>

                      <aside v-if="bkCatalogOpen" class="bk-catalog">
                        <div class="bk-catalog-head">
                          <h4>物品目录 <span>{{ bkCatalogList.length }} 项</span></h4>
                          <div class="bk-catalog-search">
                            <span class="bk-search-icon">⌕</span>
                            <input v-model="bkCatalogQuery" type="text" placeholder="筛选目录…" />
                          </div>
                        </div>
                        <div class="bk-catalog-list">
                          <div
                            v-for="c in bkCatalogList"
                            :key="c.category + c.name"
                            class="bk-cat-item"
                            :class="{ owned: bkIsOwned(c.name) }"
                            @click="addBackpackItem(c)"
                          >
                            <span class="bk-dot" :class="bkTypeClass(c.category)"></span>
                            <span class="bk-cat-name" :title="c.name">{{ c.name }}</span>
                            <span class="bk-plus">＋</span>
                          </div>
                          <div v-if="!bkCatalogList.length" class="bk-catalog-empty">
                            {{ itemCatalog.length ? '没有匹配的物品' : '物品目录加载中…' }}
                          </div>
                        </div>
                      </aside>
                    </div>

                    <div class="modal-foot">
                      <button class="gm-btn success" :disabled="gmBackpackSaving" @click="saveBackpack">{{ gmBackpackSaving ? '保存中…' : '保存背包' }}</button>
                      <span v-if="gmBackpack.result" class="gm-result">{{ gmBackpack.result }}</span>
                    </div>
                  </template>
                </template>
              </template>
              <p v-else class="muted" style="margin-top: 10px;">该用户尚未创建游戏角色。</p>
            </template>
          </div>
        </div>

      </section>

      <!-- ===== GM 工具 ===== -->
      <section v-if="tab === 'gm'" class="panel">
        <div class="panel-head">
          <h2>GM 工具</h2>
          <p class="hint">管理员专用工具，操作会即时生效。</p>
        </div>

        <div class="gm-tools">
          <!-- 发放物品/修改属性已并入「用户管理 → 详情」，此处只保留全局类工具 -->

          <!-- 设置世界等级 -->
          <div class="gm-tool-card">
            <h3>🌍 设置世界等级</h3>
            <div class="gm-field">
              <label>当前世界等级：<strong>{{ worldLevel }}</strong></label>
            </div>
            <div class="gm-field">
              <label>新世界等级</label>
              <input v-model.number="newWorldLevel" type="number" min="1" max="999" />
            </div>
            <button class="gm-btn" @click="setWorldLevel" :disabled="gmLoading">设置世界等级</button>
            <p v-if="worldLevelResult" class="gm-result">{{ worldLevelResult }}</p>
          </div>

          <!-- 发送全服公告：支持富文本（链接/图片/粗体等 Markdown 子集），发送前可实时预览 -->
          <div class="gm-tool-card">
            <h3>📢 发送全服公告</h3>
            <div class="gm-field">
              <label>公告内容</label>
              <textarea
                v-model="gmAnnouncement.content"
                placeholder="输入要发送给所有玩家的公告内容...&#10;&#10;支持直接 Ctrl+V 粘贴截图/图片&#10;支持格式：[文字](链接) 超链接、![说明](图片地址) 配图、**粗体**、*斜体*、`代码`"
                @paste="onAnnPaste"
              ></textarea>
              <div class="ann-editor-toolbar">
                <input ref="annImgInput" type="file" accept="image/*" multiple style="display: none" @change="onAnnImagesSelected" />
                <button class="btn-ghost" :disabled="annUploading" @click="pickAnnImages">
                  {{ annUploading ? '⏳ 上传中…' : '🖼️ 插入图片' }}
                </button>
                <span class="ann-editor-hint">支持 Ctrl+V 直接粘贴截图；也支持 [文字](链接)、**粗体** 等写法</span>
              </div>
            </div>
            <!-- 实时预览：与玩家端公告弹窗同一渲染组件 -->
            <div v-if="gmAnnouncement.content.trim()" class="ann-preview">
              <div class="ann-preview-title">👁️ 预览（玩家端效果）</div>
              <AnnRichText class="ann-preview-body" :content="gmAnnouncement.content" />
            </div>
            <button class="gm-btn danger" @click="doSendAnnouncement" :disabled="gmLoading || !gmAnnouncement.content.trim()">发送公告</button>
            <p v-if="gmAnnouncement.result" class="gm-result">{{ gmAnnouncement.result }}</p>
          </div>
        </div>
      </section>

    </main>
  </div>
</template>

<script setup>
/**
 * 管理员后台页面（增强版）
 * - 仪表盘：服务器状态统计、世界等级显示与控制
 * - 系统配置：在线修改指令前缀、游戏数值等配置项
 * - 用户管理：查看/修改用户角色、封禁状态、昵称
 * - GM 工具：设置世界等级、发送全服公告
 */
import { ref, computed, reactive, onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { adminApi } from '../api';
import { API_BASE } from '../config';
import AnnRichText from '../components/AnnRichText';
import GameDataPanel from '../components/admin/GameDataPanel.vue';
import LogViewerPanel from '../components/admin/LogViewerPanel.vue';

const router = useRouter();
const tab = ref('dashboard');
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));

// ---- 仪表盘 ----
const dashboardStats = ref({});
const worldLevel = ref(1);
const newWorldLevel = ref(1);
const worldLevelResult = ref('');

async function loadDashboard() {
  try {
    const res = await adminApi.dashboard();
    dashboardStats.value = res.data;
  } catch {
    // 仪表盘接口可能不存在，静默使用默认值
  }
}

async function loadWorldLevel() {
  try {
    const res = await adminApi.worldLevel();
    worldLevel.value = res.data.level;
    newWorldLevel.value = res.data.level;
  } catch {
    // 世界等级接口可能不存在
  }
}

async function setWorldLevel() {
  if (!newWorldLevel.value || newWorldLevel.value < 1) return;
  gmLoading.value = true;
  try {
    const res = await adminApi.setWorldLevel(newWorldLevel.value);
    // 设置接口只返回 { success, message }；等级需回读（写入的是「世界熟练度」点数，
    // 世界等级是 floor(√点数)+1 的换算结果，不回读会显示成 undefined）。
    await loadWorldLevel();
    worldLevelResult.value = res.message || `世界等级已设置为 ${worldLevel.value}`;
    setTimeout(() => (worldLevelResult.value = ''), 3000);
  } catch (e) {
    worldLevelResult.value = '设置失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
  }
}

// ---- 系统配置 ----
const configs = ref([]);
const savedKey = ref('');
const groupLabels = { command: '指令设置', game: '游戏数据', system: '系统', bot: '机器人', web: '网页界面', update: '部署更新', chat: '聊天' };

const configGroups = computed(() => {
  const groups = {};
  for (const cfg of configs.value) {
    const g = cfg.group || 'system';
    if (!groups[g]) groups[g] = { name: g, label: groupLabels[g] || g, items: [] };
    groups[g].items.push(cfg);
  }
  return Object.values(groups);
});

function arrayValue(v) {
  try { return JSON.parse(v).join(', '); } catch { return v; }
}
function stringToArray(s) {
  return s.split(/[,，、\s]+/).filter((x) => x);
}

async function saveConfig(cfg, value) {
  await adminApi.updateConfig(cfg.key, value);
  cfg.value = typeof value === 'object' ? JSON.stringify(value) : String(value);
  savedKey.value = cfg.key;
  setTimeout(() => (savedKey.value = ''), 1500);
}

// ---- 全局熟练度卡片编辑器（对齐背包管理：搜索 + 卡片 + 点数从大到小） ----
const PROF_SUFFIX = '熟练度';
const globalProfRows = ref([]); // [{ uid, name, points }]，name 不含「熟练度」后缀
const globalProfError = ref('');
const globalProfSearch = ref('');
let globalProfUidSeq = 0;

const globalProfWorldPoints = computed(() => {
  const row = globalProfRows.value.find((r) => r.name === '世界');
  return Number(row?.points) || 0;
});
const globalProfWorldLevel = computed(() => profLevel(globalProfWorldPoints.value));

/** 可编辑项：排除「世界」（世界等级走 GM 工具，避免误删/误改） */
const globalProfEditable = computed(() => globalProfRows.value.filter((r) => r.name !== '世界'));

/** 搜索过滤后的可编辑项；默认顺序 = 加载时按点数从大到小 */
const globalProfVisible = computed(() => {
  const kw = globalProfSearch.value.trim().toLowerCase();
  const list = globalProfEditable.value;
  if (!kw) return list;
  return list.filter((r) => String(r.name || '').toLowerCase().includes(kw));
});

/** 按熟练度点数从大到小排序（加载/初次展示用；编辑过程中不反复重排） */
function sortGlobalProfRows() {
  globalProfRows.value = [...globalProfRows.value].sort((a, b) => {
    const pa = Number(a.points) || 0;
    const pb = Number(b.points) || 0;
    if (pb !== pa) return pb - pa;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
  });
}

/** floor(√点数)+1，与服务端 显示熟练度等级 一致；点数≤0 时视为 0 级展示（实际游戏侧基线为 1） */
function profLevel(points) {
  const p = Number(points);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.floor(Math.sqrt(p)) + 1;
}

function makeGlobalProfRow(name = '', points = 0) {
  return { uid: ++globalProfUidSeq, name, points: Number(points) || 0 };
}

function parseGlobalProfRows(raw) {
  try {
    const obj = JSON.parse(raw || '{}');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj).map(([key, points]) => {
      const name = key.endsWith(PROF_SUFFIX) ? key.slice(0, -PROF_SUFFIX.length) : key;
      return makeGlobalProfRow(name, points);
    });
  } catch {
    return [];
  }
}

function hydrateGlobalProfFromConfigs(list) {
  const cfg = list.find((c) => c.key === 'game.globalMarkers');
  if (!cfg) {
    globalProfRows.value = [];
    return;
  }
  const rows = parseGlobalProfRows(cfg.value);
  if (!rows.length && cfg.value && cfg.value !== '{}') {
    globalProfError.value = 'JSON 解析失败，请检查格式（对象：名称 → 点数）';
  } else {
    globalProfError.value = '';
  }
  globalProfRows.value = rows;
  sortGlobalProfRows();
}

function addGlobalProfRow() {
  globalProfRows.value.push(makeGlobalProfRow('', 0));
  // 新条目默认点数 0 会排到列表末尾；清空搜索避免用户看不见
  globalProfSearch.value = '';
}
function removeGlobalProfByUid(uid) {
  const row = globalProfRows.value.find((r) => r.uid === uid);
  if (row?.name === '世界') return; // 世界不可在此删除
  globalProfRows.value = globalProfRows.value.filter((r) => r.uid !== uid);
}

/** 名称输入框宽度：按字符数（中文/全角按 2 宽）刚好放下名字 */
function nameInputSize(name) {
  const text = String(name || '名称');
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    const wide =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3000 && code <= 0x303f);
    w += wide ? 2 : 1;
  }
  return Math.max(5, Math.min(16, w + 1));
}

async function saveGlobalProf(cfg) {
  globalProfError.value = '';
  const obj = {};
  // 世界条目仍随整表落库（卡片里不展示，但不能丢）
  const rowsToSave = [
    ...globalProfEditable.value,
    ...globalProfRows.value.filter((r) => r.name === '世界'),
  ];
  for (const row of rowsToSave) {
    const rawName = String(row.name || '').trim();
    if (!rawName) continue;
    const points = Number(row.points);
    if (!Number.isFinite(points) || points < 0) {
      globalProfError.value = `「${rawName}」的点数无效，需为 ≥0 的数字`;
      return;
    }
    // 与服务端条目键一致：名称 + 「熟练度」
    const key = rawName.endsWith(PROF_SUFFIX) ? rawName : rawName + PROF_SUFFIX;
    if (obj[key] !== undefined) {
      globalProfError.value = `名称重复：${rawName}`;
      return;
    }
    obj[key] = Math.floor(points);
  }
  await saveConfig(cfg, obj);
}

// ---- 用户管理 ----
const users = ref([]);
const keyword = ref('');
const page = ref(1);
const pageSize = ref(50);
const pageSizeOptions = [20, 50, 100];
const total = ref(0);
const savedUser = ref(0);

// 排序状态：sortField 为空表示默认按 ID 升序
const sortField = ref('');
const sortOrder = ref('asc');

// 可点击排序的列定义
const sortableColumns = [
  { field: 'id', label: 'ID' },
  { field: 'nickname', label: '昵称' },
  { field: 'role', label: '角色' },
  { field: 'status', label: '状态' },
  { field: 'level', label: '等级' },
  { field: 'playerName', label: '角色名' },
  { field: 'location', label: '位置' },
  { field: 'lastLoginAt', label: '最后登录' },
];

async function loadUsers(p) {
  page.value = p;
  const params = {
    page: p,
    pageSize: pageSize.value,
    keyword: keyword.value,
  };
  // 仅在指定排序字段时传递，避免后端处理空字符串
  if (sortField.value) {
    params.sortField = sortField.value;
    params.sortOrder = sortOrder.value;
  }
  const res = await adminApi.listUsers(params);
  users.value = res.data.list;
  total.value = res.data.total;
}

// ---- 多选批量操作 ----
// 已勾选的用户ID（跨页保留，直到操作完成或手动取消）
const selectedIds = ref([]);
const batchLoading = ref(false);
const batchResult = ref('');

/** 本页用户是否已全部勾选 */
const isPageAllSelected = computed(
  () => users.value.length > 0 && users.value.every((u) => selectedIds.value.includes(u.id)),
);

/** 勾选/取消单个用户（跨页累积） */
function toggleSelect(u, checked) {
  const set = new Set(selectedIds.value);
  if (checked) set.add(u.id);
  else set.delete(u.id);
  selectedIds.value = [...set];
}

/** 全选/取消全选本页 */
function toggleSelectAll(checked) {
  const set = new Set(selectedIds.value);
  for (const u of users.value) {
    if (checked) set.add(u.id);
    else set.delete(u.id);
  }
  selectedIds.value = [...set];
}

/** 通用批量执行：确认 → 调接口 → 展示结果 → 刷新列表 */
async function runBatch(confirmText, apiCall, successTip) {
  if (!selectedIds.value.length) return;
  if (!confirm(confirmText)) return;
  batchLoading.value = true;
  batchResult.value = '';
  try {
    const res = await apiCall([...selectedIds.value]);
    batchResult.value = res.message || successTip;
    selectedIds.value = [];
    await loadUsers(page.value);
  } catch (e) {
    batchResult.value = '操作失败：' + (e.response?.data?.message || e.message);
  } finally {
    batchLoading.value = false;
  }
}

/** 批量清空所选玩家数据（保留账号） */
async function batchResetSelected() {
  await runBatch(
    `确定要清空所选 ${selectedIds.value.length} 个玩家的游戏数据吗？\n等级、背包、任务等进度将全部重置，账号保留，可重新开局。\n此操作不可恢复！`,
    (ids) => adminApi.batchResetUserData(ids),
    '已清空所选玩家数据',
  );
}

/** 批量删除所选账号（自动跳过自己和超级管理员） */
async function batchDeleteSelected() {
  await runBatch(
    `确定要删除所选 ${selectedIds.value.length} 个账号吗？\n将同时删除其游戏角色、绑定关系等数据，不可恢复！\n（你自己和超级管理员账号会被自动跳过）`,
    (ids) => adminApi.batchDeleteUsers(ids),
    '已删除所选账号',
  );
}

/** 一键清空全服所有玩家数据（保留所有账号） */
async function resetAllData() {
  const text = prompt(
    '即将清空全服所有玩家的游戏数据（所有账号保留，可重新开局）。\n此操作不可恢复！\n\n如确认，请输入 YES：',
  );
  if (text !== 'YES') return;
  batchLoading.value = true;
  batchResult.value = '正在清空全部玩家数据，人数多时可能需要一些时间...';
  try {
    const res = await adminApi.resetAllPlayerData();
    batchResult.value = res.message || '已清空全部玩家数据';
    selectedIds.value = [];
    await loadUsers(page.value);
  } catch (e) {
    batchResult.value = '操作失败：' + (e.response?.data?.message || e.message);
  } finally {
    batchLoading.value = false;
  }
}

/** 处理表头点击排序：升序 → 降序 → 取消 → 升序 */
function handleSort(field) {
  if (sortField.value === field) {
    if (sortOrder.value === 'asc') {
      sortOrder.value = 'desc';
    } else {
      sortField.value = '';
      sortOrder.value = 'asc';
    }
  } else {
    sortField.value = field;
    sortOrder.value = 'asc';
  }
  loadUsers(1);
}

/** 返回排序列的动态 class（用于显示高亮与方向图标） */
function sortClass(field) {
  return {
    active: sortField.value === field,
    asc: sortField.value === field && sortOrder.value === 'asc',
    desc: sortField.value === field && sortOrder.value === 'desc',
  };
}

async function updateUser(u, changes) {
  const res = await adminApi.updateUser({ id: u.id, ...changes });
  Object.assign(u, res.data);
  savedUser.value = u.id;
  setTimeout(() => (savedUser.value = 0), 1500);
}

async function deleteUser(u) {
  if (u.id === user.value?.id) return;
  // 关键操作，需二次确认
  const ok = confirm(`确定要删除用户「${u.username}」吗？\n将同时删除其游戏角色、绑定关系等数据，不可恢复！`);
  if (!ok) return;
  try {
    const res = await adminApi.deleteUser(u.id);
    alert(res.message || '删除成功');
    // 从当前列表移除，避免整页刷新
    users.value = users.value.filter((x) => x.id !== u.id);
    total.value -= 1;
    // 同步移除勾选状态
    selectedIds.value = selectedIds.value.filter((id) => id !== u.id);
  } catch (e) {
    alert('删除失败：' + (e.response?.data?.message || e.message));
  }
}

/** 清空玩家游戏数据（保留账号，重置为未开始游玩状态） */
async function resetUserData(u) {
  const ok = confirm(
    `确定要清空用户「${u.username}」的游戏数据吗？\n` +
    `等级、背包、装备、任务等进度将全部重置，账号保留，可重新开局。\n此操作不可恢复！`,
  );
  if (!ok) return;
  try {
    const res = await adminApi.resetUserData(u.id);
    alert(res.message || '已清空游戏数据');
  } catch (e) {
    alert('清空失败：' + (e.response?.data?.message || e.message));
  }
}

// ---- 用户详情 / 编辑弹窗 ----
const detailUser = ref(null);      // 详情弹窗当前用户（含完整档案）
const detailLoading = ref(false);
const detailTab = ref('data');     // 详情弹窗内页签：'data' 游戏数据 | 'backpack' 背包管理
const editForm = ref(null);        // 可编辑字段表单（仅收集有输入的字段提交）
const editSaving = ref(false);
const editResult = ref('');
const editError = ref(false);

// 可编辑的游戏字段（与后端 players/edit 白名单一致）
const editableFields = [
  { field: 'name', label: '角色名', numeric: false },
  { field: 'type', label: '使魔类型', numeric: false },
  { field: 'level', label: '等级', numeric: true },
  { field: 'exp', label: '经验', numeric: true },
  { field: 'upgradeExp', label: '升级所需经验', numeric: true },
  { field: 'hp', label: '当前HP', numeric: true },
  { field: 'maxHp', label: '最大HP', numeric: true },
  { field: 'shield', label: '当前护盾', numeric: true },
  { field: 'maxShield', label: '最大护盾', numeric: true },
  { field: 'armor', label: '当前装甲', numeric: true },
  { field: 'maxArmor', label: '最大装甲', numeric: true },
  { field: 'attack', label: '攻击', numeric: true },
  { field: 'defense', label: '防御', numeric: true },
  { field: 'speed', label: '速度', numeric: true },
  { field: 'dodge', label: '闪避', numeric: true },
  { field: 'hit', label: '命中', numeric: true },
  { field: 'crit', label: '暴击率(%)', numeric: true },
  { field: 'critDmg', label: '暴击伤害(%)', numeric: true },
  { field: 'regenHp', label: '生命回复', numeric: true },
  { field: 'regenShield', label: '护盾回复', numeric: true },
  { field: 'regenArmor', label: '装甲回复', numeric: true },
  { field: 'mapId', label: '地图ID', numeric: true },
  { field: 'location', label: '所在位置', numeric: false },
  { field: 'houseName', label: '家园名称', numeric: false },
  { field: 'affinity', label: '好感度', numeric: true },
  { field: 'vitality', label: '活力', numeric: true },
];

/** 详情弹窗中的玩家档案（detailUser.player） */
const detailPlayer = computed(() => detailUser.value?.player ?? null);

/** 字段当前值的展示文案 */
function currentDisplay(f) {
  const v = detailPlayer.value?.[f.field];
  return (v === null || v === undefined || v === '') ? '-' : String(v);
}

/** 打开用户详情弹窗并拉取完整档案 */
async function openUserDetail(u) {
  detailUser.value = u;
  detailLoading.value = true;
  editForm.value = null;
  editResult.value = '';
  editError.value = false;
  detailTab.value = 'data';                    // 每次打开默认"游戏数据"页签
  gmBackpack.value.userId = null;              // 重置背包上下文，避免串到上一个用户
  gmBackpack.value.items = [];
  gmBackpack.value.currencyBaseline = {};
  gmBackpack.value.result = '';
  try {
    const res = await adminApi.userDetail(u.id);
    detailUser.value = res.data;
    // 表单初始为全空：留空 = 不修改该字段
    if (res.data.player) {
      editForm.value = Object.fromEntries(editableFields.map((f) => [f.field, '']));
    }
  } catch (e) {
    alert('加载用户详情失败：' + (e.response?.data?.message || e.message));
    detailUser.value = null;
  } finally {
    detailLoading.value = false;
  }
}

function closeUserDetail() {
  detailUser.value = null;
  editForm.value = null;
  editResult.value = '';
  detailTab.value = 'data';
  gmBackpack.value.userId = null;
  gmBackpack.value.items = [];
  gmBackpack.value.currencyBaseline = {};
  gmBackpack.value.result = '';
}

/** 弹窗内保存账号字段（如绑定QQ号） */
async function saveUserField(changes) {
  const u = detailUser.value;
  if (!u) return;
  try {
    const res = await adminApi.updateUser({ id: u.id, ...changes });
    Object.assign(u, res.data);
    savedUser.value = u.id;
    setTimeout(() => (savedUser.value = 0), 1500);
    await loadUsers(page.value); // 同步列表中的QQ展示
  } catch (e) {
    alert('保存失败：' + (e.response?.data?.message || e.message));
  }
}

/** 提交玩家数据编辑：只提交有输入的字段 */
async function savePlayerEdit() {
  const form = editForm.value;
  if (!form || !detailUser.value) return;
  const changes = {};
  for (const f of editableFields) {
    const raw = `${form[f.field] ?? ''}`.trim();
    if (raw === '') continue; // 留空不修改
    changes[f.field] = f.numeric ? Number(raw) : raw;
    if (f.numeric && Number.isNaN(changes[f.field])) {
      editError.value = true;
      editResult.value = `「${f.label}」需要数字`;
      return;
    }
  }
  if (Object.keys(changes).length === 0) {
    editError.value = true;
    editResult.value = '请先填写要修改的字段';
    return;
  }
  editSaving.value = true;
  editError.value = false;
  try {
    const res = await adminApi.editPlayerData(detailUser.value.id, changes);
    editResult.value = res.message || '保存成功';
    await loadUsers(page.value); // 刷新列表中的等级/位置等展示
  } catch (e) {
    editError.value = true;
    editResult.value = '保存失败：' + (e.response?.data?.message || e.message);
  } finally {
    editSaving.value = false;
  }
}

/** 头像加载失败的用户 id（降级显示首字母） */
const avatarFailed = reactive(new Set());

/** 秒数 → "X天X小时X分" 展示 */
function formatDuration(seconds) {
  const s = Number(seconds ?? 0);
  if (!s || s <= 0) return '-';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${mins}分`;
  return `${mins}分钟`;
}

// ---- GM 工具 ----
const gmLoading = ref(false);

// 物品目录（背包管理「添加物品」选择器用）：[{ name, category }]
const itemCatalog = ref([]);
const itemCatalogLoaded = ref(false);

async function loadItemCatalog() {
  if (itemCatalogLoaded.value) return;
  try {
    const res = await adminApi.gmCatalog();
    // 响应拦截器已解包为响应体；兼容 { items } 与 { data: { items } } 两种返回形态
    itemCatalog.value = res?.items || res?.data?.items || [];
    itemCatalogLoaded.value = true;
  } catch (err) {
    console.warn('[GM] 物品目录加载失败，稍后切回 GM 页会自动重试', err);
    // 目录加载失败时保留空列表，下次切到 GM 页会重试
    itemCatalogLoaded.value = false;
  }
}

// ---- GM 背包管理 ----
// 绑定到"用户详情"弹窗：直接对当前用户(id/username)操作，无需再搜索目标玩家。
const gmBackpack = ref({
  userId: null,     // 目标用户ID（当前详情弹窗用户）
  username: '',     // 目标用户名（展示用）
  items: [],        // 背包物品 [{ name, quantity, type, ... }]
  result: '',       // 操作结果
  // 载入时的货币基准 { 钻石: n, ... }：仅用于「原本有值 → 保存后清零」的二次确认，
  // 避免每次保存都因为「本来就是 0」而弹确认
  currencyBaseline: {},
});
const gmBackpackLoading = ref(false);
const gmBackpackSaving = ref(false);

/** 切到详情弹窗的"背包管理"页签时，为当前用户加载背包（同一用户仅加载一次） */
async function switchBackpackTab() {
  detailTab.value = 'backpack';
  // 背包管理的"添加物品"选择器复用物品目录，必须确保已加载；
  // 否则未切过 GM 页签时 itemCatalog 为空，会一直显示"物品目录加载中…"。
  loadItemCatalog();
  if (!detailUser.value) return;
  const uid = detailUser.value.id;
  // 换了一个用户才重新拉取，避免反复加载
  if (gmBackpack.value.userId !== uid) {
    gmBackpack.value.userId = uid;
    gmBackpack.value.username = detailUser.value.username || '';
    await loadBackpack();
  }
}

async function loadBackpack() {
  const uid = gmBackpack.value.userId;
  if (!uid) return;
  gmBackpackLoading.value = true;
  gmBackpack.value.result = '';
  try {
    const res = await adminApi.getBackpack(uid);
    const list = res?.data || [];
    // 统一数量字段：既有 count 又有 quantity 时优先 count，缺省补 0，便于前端数字输入
    gmBackpack.value.items = (list || []).map((it) => ({
      ...it,
      quantity: Number(it.count ?? it.quantity ?? 0),
    }));
    // 记录货币基准：保存时据此判断「是否原本有值、现在会被清零」
    const baseline = {};
    for (const n of CURRENCY_ITEM_NAMES) {
      const hit = gmBackpack.value.items.find((it) => it.name === n);
      baseline[n] = Number(hit?.quantity ?? 0);
    }
    gmBackpack.value.currencyBaseline = baseline;
  } catch (e) {
    gmBackpack.value.result = '加载背包失败：' + (e.response?.data?.message || e.message);
    gmBackpack.value.items = [];
  } finally {
    gmBackpackLoading.value = false;
  }
}

// 添加物品：右侧常驻目录（复用物品目录数据）
const bkCatalogQuery = ref('');
const bkCatalogOpen = ref(true);
const bkSearchQuery = ref('');
const bkFilterType = ref('all');
const bkTypeOptions = ['all', '物品', '装备', '资源'];

/** 背包内搜索 + 类型筛选后的展示列表 */
const bkVisibleItems = computed(() => {
  const kw = bkSearchQuery.value.trim().toLowerCase();
  const t = bkFilterType.value;
  return gmBackpack.value.items.filter((it) => {
    if (t !== 'all' && (it.type || '物品') !== t) return false;
    if (kw && !(it.name || '').toLowerCase().includes(kw)) return false;
    return true;
  });
});

/** 右侧目录列表（关键词筛选，不限 30 条，面板内滚动） */
const bkCatalogList = computed(() => {
  const kw = bkCatalogQuery.value.trim().toLowerCase();
  if (!kw) return itemCatalog.value;
  return itemCatalog.value.filter((i) => i.name.toLowerCase().includes(kw));
});

/** 卡片/色点类型类名：紫=物品，粉=装备，青=资源 */
function bkTypeClass(t) {
  if (t === '装备') return 'equip';
  if (t === '资源') return 'res';
  return '';
}

function bkIsOwned(name) {
  return gmBackpack.value.items.some((it) => it.name === name);
}

/**
 * 货币条目（钻石/召唤券/数据核心）：落库时由服务端从背包 JSON 剥离进独立列，
 * 读取时再物化回来。删除条目 = 把列清零，需二次确认（见 removeBackpackItem）。
 */
const CURRENCY_ITEM_NAMES = ['钻石', '召唤券', '数据核心'];
function isCurrencyName(name) {
  return CURRENCY_ITEM_NAMES.includes(String(name ?? '').trim());
}

/** 点选目录物品加入背包；同名已有则累计数量 */
function addBackpackItem(it) {
  const existing = gmBackpack.value.items.find((s) => s.name === it.name);
  if (existing) {
    existing.quantity = Number(existing.quantity ?? 0) + 1;
  } else {
    gmBackpack.value.items.push({ name: it.name, type: it.category, quantity: 1 });
  }
}

/** 按对象删除（搜索/筛选后下标会偏，不能用 idx） */
function removeBackpackItem(it) {
  const idx = gmBackpack.value.items.indexOf(it);
  if (idx < 0) return;
  // ⚠️ 货币（钻石/召唤券/数据核心）真相源是 Player 的独立列：背包里删掉该条目后保存，
  // 服务端按「权威快照」判定为「已花光」→ 直接把列清零（player.service 货币提取分支）。
  // 这是不可撤销操作，必须二次确认，避免误点 ✕ 清空玩家货币。
  if (isCurrencyName(it?.name)) {
    const ok = window.confirm(
      `「${it.name}」是货币，删除该条目并保存会把玩家该货币**清零**（不可撤销）。\n`
      + `若只是想调数值，请直接把数量改成目标值。\n\n确定要清零吗？`,
    );
    if (!ok) return;
  }
  gmBackpack.value.items.splice(idx, 1);
}

/** 卡片 ± 步进 */
function bumpBackpackQty(it, delta) {
  it.quantity = Math.max(0, Number(it.quantity ?? 0) + delta);
}

/** 保存背包：数量=0 的条目视为删除，其余整体提交 */
async function saveBackpack() {
  const uid = gmBackpack.value.userId;
  if (!uid) return;
  // 货币清零二次确认：货币条目「载入时有值、保存时缺失或 <=0」→ 服务端按权威快照把列清零。
  // 这是不可撤销操作，必须显式确认（数量改为 0 与直接删除 ✕ 都会命中）。
  const baseline = gmBackpack.value.currencyBaseline || {};
  const zeroed = CURRENCY_ITEM_NAMES.filter((n) => {
    const before = Number(baseline[n] ?? 0);
    if (before <= 0) return false; // 本来就是 0，不算清零
    const hit = gmBackpack.value.items.find((it) => it.name === n);
    return !hit || Number(hit.quantity ?? 0) <= 0;
  });
  if (zeroed.length > 0) {
    const ok = window.confirm(
      `以下货币将被清零：${zeroed.join('、')}\n保存后不可撤销，确定继续？`,
    );
    if (!ok) return;
  }
  gmBackpackSaving.value = true;
  gmBackpack.value.result = '';
  try {
    const items = gmBackpack.value.items
      .filter((it) => Number(it.quantity) > 0)
      .map((it) => ({
        name: it.name,
        quantity: Number(it.quantity),
        type: it.type,
        durability: it.durability,
        data: it.data,
      }));
    const res = await adminApi.saveBackpack({ userId: uid, items });
    gmBackpack.value.result = res?.data?.message || res?.message || '保存成功';
    await loadBackpack(); // 保存后回读最新数据，与后端合并归一化结果一致
    setTimeout(() => (gmBackpack.value.result = ''), 5000);
  } catch (e) {
    gmBackpack.value.result = '保存失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmBackpackSaving.value = false;
  }
}

const gmAnnouncement = ref({
  content: '',
  result: '',
});

// ---- 公告配图上传：选图后立即上传，以 Markdown 图片语法插入正文 ----
const annImgInput = ref(null);
const annUploading = ref(false);

/** 触发隐藏的图片选择器 */
function pickAnnImages() {
  annImgInput.value?.click();
}

/**
 * 把若干图片地址以 Markdown 图片语法插入公告正文
 * - 优先插入到 textarea 光标处（保持编辑体验），无光标则追加到末尾
 * - Markdown 图片语法括号内不能有空格，否则玩家端解析器不识别
 */
function insertAnnImages(urls) {
  if (!urls.length) return;
  const ta = gmAnnouncement.value.content;
  const snippet = urls.map((u) => `![](${u})`).join('\n');
  const textareaEl = document.querySelector('.gm-tool-card .gm-field textarea');
  let pos = textareaEl && textareaEl.selectionStart != null ? textareaEl.selectionStart : -1;
  if (pos < 0 || pos > ta.length) pos = ta.length;
  const before = ta.slice(0, pos);
  const after = ta.slice(pos);
  const pad1 = before && !before.endsWith('\n') ? '\n' : '';
  const pad2 = after && !after.startsWith('\n') ? '\n' : '';
  gmAnnouncement.value.content = before + pad1 + snippet + pad2 + after;
  // 插入后把光标移到图片语法之后，方便继续输入文字
  nextTick(() => {
    const el = document.querySelector('.gm-tool-card .gm-field textarea');
    if (!el) return;
    const caret = before.length + pad1.length + snippet.length;
    el.setSelectionRange(caret, caret);
    el.focus();
  });
}

/** 上传若干图片文件并把返回地址插入正文（「插入图片」按钮与「剪贴板粘贴」共用同一实现） */
async function uploadAnnImages(files) {
  if (!files || !files.length) return false;
  annUploading.value = true;
  try {
    const res = await adminApi.uploadAnnouncementImage(files);
    const urls = res.data || [];
    if (!urls.length) throw new Error('未返回图片地址');
    insertAnnImages(urls);
    return true;
  } catch (err) {
    alert('上传公告配图失败：' + (err.response?.data?.message || err.message));
    return false;
  } finally {
    annUploading.value = false;
  }
}

/** 「插入图片」按钮：选择本地文件后上传 */
async function onAnnImagesSelected(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // 清空 input 值，允许重复选择同一文件
  await uploadAnnImages(files);
}

// 剪贴板图片按 MIME 兜底扩展名，保证落盘文件名带后缀（静态服务据此后置 Content-Type）
const PASTE_EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/**
 * 剪贴板粘贴：支持直接 Ctrl+V 粘贴截图/复制的图片
 * - 剪贴板中没有图片时直接放行，走浏览器默认的文本粘贴
 * - 有图片时阻止默认行为，先上传再以 Markdown 图片语法插入光标处
 */
async function onAnnPaste(e) {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items
    .filter((it) => it.kind === 'file' && (it.type || '').startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return; // 纯文本粘贴交回浏览器处理
  e.preventDefault();
  // 剪贴板截图通常没有文件名/扩展名，补一个带正确扩展名的 File，避免落盘后丢失后缀
  const named = files.map((f, i) => {
    const ext = PASTE_EXT_BY_MIME[(f.type || '').toLowerCase()] || 'png';
    const base = f.name && /\.[a-z0-9]+$/i.test(f.name) ? f.name : `paste_${Date.now()}_${i}.${ext}`;
    return new File([f], base, { type: f.type || 'image/png' });
  });
  await uploadAnnImages(named);
}

async function doSendAnnouncement() {
  if (!gmAnnouncement.value.content) return;
  gmLoading.value = true;
  try {
    const res = await adminApi.sendAnnouncement(gmAnnouncement.value.content);
    gmAnnouncement.value.result = res.message || '公告已发送！';
    gmAnnouncement.value.content = '';
    setTimeout(() => (gmAnnouncement.value.result = ''), 3000);
  } catch (e) {
    gmAnnouncement.value.result = '发送失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
  }
}

/** 时间格式化：YYYY-MM-DD HH:mm */
function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- 通用 ----
function goChat() { router.push('/chat'); }
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  router.push('/login');
}

onMounted(async () => {
  // 校验是否为管理员；开发登录开启时（DEV_LOGIN_ENABLED=1）放行任意账号，方便本地调试
  const isAdminAccount = ['ADMIN', 'SUPER_ADMIN'].includes(user.value?.role);
  if (!isAdminAccount) {
    try {
      const res = await fetch(`${API_BASE}/auth/dev/status`);
      const data = await res.json();
      if (data?.data?.enabled !== true) {
        alert('没有管理员权限');
        router.push('/chat');
        return;
      }
    } catch {
      // 状态查询失败视为未开启开发登录
      alert('没有管理员权限');
      router.push('/chat');
      return;
    }
  }
  // 并行加载所有数据
  await Promise.allSettled([
    loadDashboard(),
    loadWorldLevel(),
    adminApi.listConfig().then((res) => {
      configs.value = res.data;
      hydrateGlobalProfFromConfigs(res.data || []);
    }),
    loadUsers(1),
  ]);
});
</script>

<style scoped>
/* ===== 用户管理增强：在线状态点 / 玩家信息标签 / 时间列 ===== */
.online-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.online-dot.on {
  background: #4ade80;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.8);
}
.online-dot.off {
  background: var(--muted-dark, #666);
}
.player-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: rgba(139, 92, 246, 0.12);
  border: 1px solid rgba(139, 92, 246, 0.35);
  color: var(--text);
  margin: 1px 3px 1px 0;
  white-space: nowrap;
}
.player-tag.lv {
  color: var(--accent2);
  font-weight: 700;
}
.player-tag.loc {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(59, 130, 246, 0.35);
}
.role-select,
.status-select {
  max-width: 110px;
}
.status-select option[value='BANNED'] {
  color: #f87171;
}
.time-cell {
  font-size: 12px;
  white-space: nowrap;
}
.time-sub {
  color: var(--muted);
  font-size: 11px;
  opacity: 0.85;
}
.avatar-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
}
.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid rgba(139, 92, 246, 0.45);
  background: rgba(139, 92, 246, 0.12);
  display: block;
}
.user-avatar.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  color: var(--accent2, #a78bfa);
}

/* ===== 多选批量操作 ===== */
.check-cell {
  width: 36px;
  text-align: center;
}
.check-cell input[type='checkbox'] {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--accent, #8b5cf6);
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 10px 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(139, 92, 246, 0.08);
  border: 1px solid rgba(139, 92, 246, 0.35);
}
.batch-count {
  font-size: 13px;
  color: var(--text);
}
.batch-count strong {
  color: var(--accent2, #fbbf24);
}
.batch-btn {
  padding: 5px 14px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: filter 0.15s;
}
.batch-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.batch-btn:hover:not(:disabled) {
  filter: brightness(1.15);
}
.batch-btn.warning {
  background: rgba(245, 158, 11, 0.18);
  border-color: rgba(245, 158, 11, 0.5);
  color: #fbbf24;
}
.batch-btn.danger {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.5);
  color: #f87171;
}
.batch-btn.ghost {
  background: transparent;
  border-color: var(--border, rgba(255, 255, 255, 0.15));
  color: var(--muted, #9ca3af);
}
.batch-result {
  font-size: 12px;
  color: #4ade80;
  white-space: pre-line;
  max-width: 100%;
  word-break: break-all;
}
.reset-all-btn {
  margin-left: 12px;
}

/* ===== GM 背包管理 ===== */
.modal-box.wide {
  width: min(980px, calc(100vw - 48px));
}
.bk-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin: 8px 0;
}
.bk-search {
  flex: 1 1 180px;
  min-width: 140px;
  display: flex;
  align-items: center;
  gap: 5px;
  background: rgba(10, 8, 26, 0.7);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  padding: 6px 9px;
}
.bk-search:focus-within {
  border-color: var(--accent, #8b5cf6);
}
.bk-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text, #e5e7eb);
  font-size: 12px;
  padding: 0;
}
.bk-search input::placeholder {
  color: var(--muted-dark, #6b6b8a);
}
.bk-search-icon {
  color: var(--muted-dark, #6b6b8a);
  font-size: 12px;
  line-height: 1;
}
.bk-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.bk-chip {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: rgba(255, 255, 255, 0.03);
  color: var(--muted, #9ca3af);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 999px;
  cursor: pointer;
}
.bk-chip:hover {
  color: var(--text, #e5e7eb);
  border-color: rgba(139, 92, 246, 0.35);
}
.bk-chip.on {
  color: #fff;
  background: rgba(139, 92, 246, 0.25);
  border-color: var(--accent, #8b5cf6);
}
.bk-stat {
  font-size: 11px;
  color: var(--muted, #9ca3af);
  white-space: nowrap;
}
.bk-stat b {
  color: var(--text, #e5e7eb);
  font-weight: 600;
}
.bk-toggle {
  border: 1px solid rgba(139, 92, 246, 0.5);
  background: rgba(139, 92, 246, 0.18);
  color: #d4c4ff;
  font-size: 12px;
  padding: 6px 11px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.bk-toggle:hover {
  background: rgba(139, 92, 246, 0.28);
}
.bk-toggle.on {
  background: var(--accent, #8b5cf6);
  color: #fff;
  border-color: var(--accent, #8b5cf6);
}

.bk-layout {
  display: grid;
  grid-template-columns: 1fr 240px;
  gap: 8px;
  align-items: start;
}
.bk-layout.no-cat {
  grid-template-columns: 1fr;
}

.bk-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-content: flex-start;
  max-height: 420px;
  overflow-y: auto;
  padding-right: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--border, rgba(255, 255, 255, 0.12)) transparent;
}
.bk-grid::-webkit-scrollbar {
  width: 5px;
}
.bk-grid::-webkit-scrollbar-thumb {
  background: var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 3px;
}

.bk-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-left: 3px solid var(--accent, #8b5cf6);
  border-radius: 8px;
  padding: 6px 8px 5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
  width: max-content;
  min-width: 96px;
  max-width: 100%;
  transition: border-color 0.15s;
}
.bk-card:hover {
  border-color: rgba(139, 92, 246, 0.35);
  border-left-color: var(--accent, #8b5cf6);
}
.bk-card.equip {
  border-left-color: #ec4899;
}
.bk-card.equip:hover {
  border-color: rgba(139, 92, 246, 0.35);
  border-left-color: #ec4899;
}
.bk-card.res {
  border-left-color: #06b6d4;
}
.bk-card.res:hover {
  border-color: rgba(139, 92, 246, 0.35);
  border-left-color: #06b6d4;
}
.bk-card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.bk-card-name {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--text, #e5e7eb);
  white-space: nowrap;
}
.bk-card-x {
  border: none;
  background: transparent;
  color: var(--muted-dark, #6b6b8a);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0 1px;
  flex-shrink: 0;
}
.bk-card-x:hover {
  color: #f87171;
}
/* 货币条目：危险删除（删除+保存=清零货币列），常显提示色 */
.bk-card-x.danger {
  color: #fbbf24;
}
.bk-cur-badge {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 6px;
  font-size: 10px;
  font-style: normal;
  line-height: 14px;
  background: rgba(251, 191, 36, 0.18);
  color: #fbbf24;
  vertical-align: middle;
}
.bk-qty {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 88px;
}
.bk-qbtn {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  flex-shrink: 0;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: rgba(255, 255, 255, 0.04);
  color: var(--text, #e5e7eb);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  padding: 0;
}
.bk-qbtn:hover {
  border-color: var(--accent, #8b5cf6);
  background: rgba(139, 92, 246, 0.15);
}
.bk-qin {
  flex: 1;
  min-width: 42px;
  width: 52px;
  text-align: center;
  background: rgba(10, 8, 26, 0.65);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 5px;
  color: var(--text, #e5e7eb);
  font-size: 12px;
  padding: 2px 0;
  outline: none;
  font-variant-numeric: tabular-nums;
}
.bk-qin:focus {
  border-color: var(--accent, #8b5cf6);
}
.bk-qin::-webkit-outer-spin-button,
.bk-qin::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.bk-qin[type='number'] {
  -moz-appearance: textfield;
  appearance: textfield;
}
.bk-empty {
  width: 100%;
  text-align: center;
  color: var(--muted-dark, #6b6b8a);
  padding: 32px 10px;
  font-size: 12px;
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bk-empty span {
  font-size: 11px;
}

/* ===== 全局熟练度卡片（单行：− 名称 点数 Lv ± ✕） ===== */
.prof-grid {
  max-height: 360px;
}
.prof-card {
  min-width: 0;
  width: max-content;
  max-width: 100%;
  padding: 5px 7px;
  align-self: flex-start;
}
.prof-card-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: max-content;
  max-width: 100%;
  min-width: 0;
}
.prof-card-name {
  flex: 0 1 auto;
  width: auto;
  min-width: 0;
  max-width: 140px;
  box-sizing: content-box;
  background: transparent;
  border: 1px solid transparent;
  outline: none;
  color: var(--text, #e5e7eb);
  font-size: 12px;
  font-weight: 500;
  padding: 2px 4px;
  border-radius: 5px;
  text-overflow: ellipsis;
}
.prof-card-name:hover,
.prof-card-name:focus {
  border-color: var(--border, rgba(255, 255, 255, 0.12));
  background: rgba(10, 8, 26, 0.55);
}
.prof-card-points {
  flex: 0 0 auto;
  width: 40px;
  min-width: 36px;
}
.prof-lv-badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 999px;
  background: rgba(139, 92, 246, 0.18);
  color: #d4c4ff;
  font-variant-numeric: tabular-nums;
}

.bk-catalog {
  background: rgba(10, 8, 26, 0.4);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  max-height: 460px;
  position: sticky;
  top: 8px;
}
.bk-catalog-head {
  padding: 8px 8px 6px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.bk-catalog-head h4 {
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 6px;
  color: var(--text, #e5e7eb);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.bk-catalog-head h4 span {
  font-size: 10px;
  color: var(--muted-dark, #6b6b8a);
  font-weight: 400;
}
.bk-catalog-search {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(10, 8, 26, 0.8);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  padding: 4px 7px;
}
.bk-catalog-search:focus-within {
  border-color: var(--accent, #8b5cf6);
}
.bk-catalog-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text, #e5e7eb);
  font-size: 11px;
  padding: 0;
}
.bk-catalog-search input::placeholder {
  color: var(--muted-dark, #6b6b8a);
}
.bk-catalog-list {
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  scrollbar-width: thin;
  scrollbar-color: var(--border, rgba(255, 255, 255, 0.12)) transparent;
}
.bk-catalog-list::-webkit-scrollbar {
  width: 4px;
}
.bk-catalog-list::-webkit-scrollbar-thumb {
  background: var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 2px;
}
.bk-cat-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
}
.bk-cat-item:hover {
  background: rgba(139, 92, 246, 0.14);
  border-color: rgba(139, 92, 246, 0.3);
}
.bk-cat-item.owned .bk-plus {
  background: rgba(74, 222, 128, 0.15);
  border-color: rgba(74, 222, 128, 0.4);
  color: #4ade80;
}
.bk-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--accent, #8b5cf6);
}
.bk-dot.equip {
  background: #ec4899;
}
.bk-dot.res {
  background: #06b6d4;
}
.bk-cat-name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text, #e5e7eb);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bk-plus {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted, #9ca3af);
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bk-catalog-empty {
  text-align: center;
  color: var(--muted-dark, #6b6b8a);
  font-size: 11px;
  padding: 16px 6px;
}

/* ===== 详情 / 编辑弹窗 ===== */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fadeInUp 0.2s ease-out;
}
.modal-box {
  width: min(760px, calc(100vw - 48px));
  max-height: 84vh;
  overflow-y: auto;
  background: var(--card, rgba(16, 16, 32, 0.96));
  border: 1px solid var(--glass-border, var(--border));
  border-radius: 14px;
  padding: 18px 20px;
  box-shadow: var(--glass-shadow, 0 8px 32px rgba(0, 0, 0, 0.45));
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.modal-head h3 {
  font-size: 16px;
  color: var(--text);
}
.modal-head small {
  font-weight: 400;
  margin-left: 6px;
}
.modal-close {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 22px;
  cursor: pointer;
  line-height: 1;
}
.modal-close:hover {
  color: var(--text);
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px;
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
}
.detail-item label {
  font-size: 11px;
  color: var(--muted);
}
.detail-item span {
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
}
.qq-edit-input {
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  padding: 4px 8px;
  font-size: 13px;
  width: 100%;
}
.qq-edit-input:focus {
  outline: none;
  border-color: var(--accent);
}
.mono {
  font-family: monospace;
}
.muted {
  color: var(--muted);
}
.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px 12px;
}
.edit-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
.edit-field input {
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 6px 9px;
  font-size: 13px;
}
.edit-field input:focus {
  outline: none;
  border-color: var(--accent);
}
.modal-foot {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
}
/* 详情弹窗内页签条 */
.detail-tabs {
  display: flex;
  gap: 6px;
  margin: 12px 0 2px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.dt-tab {
  border: none;
  background: transparent;
  color: var(--muted, #9ca3af);
  font-size: 13px;
  padding: 6px 14px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.dt-tab.on {
  color: var(--accent, #7aa2ff);
  border-bottom-color: var(--accent, #7aa2ff);
}
.edit-result {
  font-size: 13px;
  color: #4ade80;
}
.edit-result.err {
  color: #f87171;
}

/* ===== 公告编辑器：工具栏与实时预览 ===== */
.ann-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.ann-editor-hint {
  font-size: 12px;
  color: var(--muted, #9ca3af);
}
.ann-preview {
  margin-top: 12px;
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 10px;
  overflow: hidden;
}
.ann-preview-title {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--muted, #9ca3af);
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px dashed var(--border, rgba(255, 255, 255, 0.15));
}
/* 预览正文复用玩家端公告弹窗的渲染组件 */
.ann-preview-body {
  padding: 12px;
  font-size: 14px;
  line-height: 1.7;
  max-height: 260px;
  overflow-y: auto;
}
.ann-preview-body p {
  margin: 0 0 8px;
}
.ann-preview-body p:last-child {
  margin-bottom: 0;
}
.ann-preview-body .ann-link {
  color: #fbbf24;
  text-decoration: underline;
  word-break: break-all;
}
.ann-preview-body .ann-img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  vertical-align: middle;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
}

/* ===== 移动端适配 ===== */
@media (max-width: 768px) {
  .bk-layout {
    grid-template-columns: 1fr;
  }
  .bk-catalog {
    position: static;
    max-height: 280px;
  }
  .modal-box.wide {
    width: calc(100vw - 24px);
  }
}
</style>