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
      <button :class="['tab', tab === 'config' && 'active']" @click="tab = 'config'">⚙️ 系统配置</button>
      <button :class="['tab', tab === 'users' && 'active']" @click="tab = 'users'">👥 用户管理</button>
      <button :class="['tab', tab === 'gm' && 'active']" @click="tab = 'gm'">🔧 GM 工具</button>
    </nav>

    <main class="admin-content">
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
              <div v-for="cfg in grp.items" :key="cfg.key" class="config-item">
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
            </div>
          </div>
        </div>
      </section>

      <!-- ===== 用户管理 ===== -->
      <section v-if="tab === 'users'" class="panel panel-wide">
        <div class="panel-head">
          <h2>用户管理</h2>
          <p class="hint">管理平台注册用户：支持关键词搜索、每页条数切换与表头点击排序。</p>
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
                <th class="sortable" :class="sortClass('username')" @click="handleSort('username')">
                  <span>用户名</span><i class="sort-icon"></i>
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
                <th class="sortable" :class="sortClass('lastLoginAt')" @click="handleSort('lastLoginAt')">
                  <span>最后登录</span><i class="sort-icon"></i>
                </th>
                <th class="sortable" :class="sortClass('loginCount')" @click="handleSort('loginCount')">
                  <span>登录次数</span><i class="sort-icon"></i>
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
                  <div class="user-name">{{ u.username }}</div>
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
                  <div>{{ formatTime(u.lastLoginAt) || '从未' }}</div>
                  <div class="time-sub">{{ u.loginCount ?? 0 }} 次</div>
                </td>
                <td>{{ u.loginCount ?? 0 }}</td>
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
          <div class="modal-box">
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

                <!-- 页签：背包管理（解析当前用户背包，可编辑数量/增删） -->
                <template v-else>
                  <p class="hint" style="margin: 10px 0 6px;">
                    背包管理：编辑 <b>{{ gmBackpack.username }}</b> 背包中的物品数量，可增删。
                  </p>
                  <div v-if="gmBackpackLoading" class="fb-empty">背包加载中…</div>
                  <template v-else>
                    <div class="gm-field">
                      <label>添加物品（输入名称筛选，点选加入；同名自动累计数量）</label>
                      <div class="picker-box">
                        <input v-model="bkItemQuery" placeholder="输入物品/装备名称筛选" @focus="bkItemMenuOpen = true" @blur="bkItemMenuOpen = false" />
                        <ul v-if="bkItemMenuOpen" class="picker-menu">
                          <li v-for="it in bkFilteredCatalog" :key="it.category + it.name" @mousedown.prevent="addBackpackItem(it)">
                            <span class="picker-menu-name">{{ it.name }}</span>
                            <span class="picker-menu-sub">{{ it.category }}</span>
                          </li>
                          <li v-if="!bkFilteredCatalog.length" class="picker-empty">{{ itemCatalog.length ? '没有匹配的物品' : '物品目录加载中…' }}</li>
                        </ul>
                      </div>
                    </div>

                    <div v-if="gmBackpack.items.length" class="bk-list">
                      <div v-for="(it, idx) in gmBackpack.items" :key="it.name + idx" class="bk-item">
                        <span class="bk-item-name" :title="it.type || '物品'">{{ it.name }}<i v-if="it.type" class="bk-item-type">{{ it.type }}</i></span>
                        <input v-model.number="it.quantity" class="bk-item-qty" type="number" min="0" step="any" title="数量（0 表示删除，支持小数）" />
                        <button class="picked-remove" title="删除" @click="removeBackpackItem(idx)">✕</button>
                      </div>
                    </div>
                    <p v-else class="muted" style="margin: 6px 0;">背包为空，可通过上方选择物品添加。</p>

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
          <!-- 发放物品：目标玩家搜索点选 + 物品目录多选（带数量），避免手输名称出错 -->
          <div class="gm-tool-card">
            <h3>🎁 发放物品</h3>
            <div class="gm-field">
              <label>目标玩家（输入关键词搜索后点选）</label>
              <div v-if="gmGiveItem.player" class="picker-chip">
                <span class="picker-chip-name">
                  {{ gmGiveItem.player.nickname || gmGiveItem.player.username }}
                  <i class="picker-chip-sub">#{{ gmGiveItem.player.id }}<template v-if="gmGiveItem.player.player?.name"> · {{ gmGiveItem.player.player.name }}</template></i>
                </span>
                <button class="picker-chip-x" title="重新选择" @click="gmGiveItem.player = null">✕</button>
              </div>
              <div v-else class="picker-box">
                <input v-model="playerQuery" placeholder="输入用户名/昵称/QQ号筛选" @input="searchPlayers" @focus="playerDropdown = true" @blur="playerDropdown = false" />
                <ul v-if="playerDropdown" class="picker-menu">
                  <li v-for="p in playerOptions" :key="p.id" @mousedown.prevent="choosePlayer(p)">
                    <span class="picker-menu-name">{{ p.nickname || p.username }}</span>
                    <span class="picker-menu-sub">{{ p.username }}<template v-if="p.player?.name"> · {{ p.player.name }}</template> · #{{ p.id }}</span>
                  </li>
                  <li v-if="playerSearched && !playerOptions.length" class="picker-empty">未找到匹配玩家</li>
                  <li v-else-if="!playerSearched" class="picker-empty">输入关键词开始搜索</li>
                </ul>
              </div>
            </div>
            <div class="gm-field">
              <label>选择物品（输入关键词筛选，可连续添加多个）</label>
              <div class="picker-box">
                <input v-model="itemQuery" placeholder="输入物品或装备名称筛选" @focus="itemMenuOpen = true" @blur="itemMenuOpen = false" />
                <ul v-if="itemMenuOpen" class="picker-menu">
                  <li v-for="it in filteredCatalog" :key="it.category + it.name" @mousedown.prevent="addGiveItem(it)">
                    <span class="picker-menu-name">{{ it.name }}</span>
                    <span class="picker-menu-sub">{{ it.category }}</span>
                  </li>
                  <li v-if="!filteredCatalog.length" class="picker-empty">{{ itemCatalog.length ? '没有匹配的物品' : '物品目录加载中…' }}</li>
                </ul>
              </div>
              <div v-if="gmGiveItem.items.length" class="picked-list">
                <div v-for="(sel, idx) in gmGiveItem.items" :key="sel.name" class="picked-item">
                  <span class="picked-name">{{ sel.name }}<i class="picked-cat">{{ sel.category }}</i></span>
                  <input v-model.number="sel.count" class="picked-qty" type="number" min="1" title="数量" />
                  <button class="picked-remove" title="移除" @click="gmGiveItem.items.splice(idx, 1)">✕</button>
                </div>
              </div>
            </div>
            <button class="gm-btn success" :disabled="gmLoading || !canGiveItems" @click="doGiveItem">发放物品</button>
            <p v-if="gmGiveItem.result" class="gm-result">{{ gmGiveItem.result }}</p>
          </div>

          <!-- 修改玩家属性 -->
          <div class="gm-tool-card">
            <h3>🔧 修改玩家属性</h3>
            <div class="gm-field">
              <label>目标玩家（用户名/昵称/QQ号/ID）</label>
              <input v-model="gmModify.target" placeholder="输入玩家用户名、昵称、QQ号或ID" />
            </div>
            <div class="gm-field">
              <label>属性字段</label>
              <select v-model="gmModify.field">
                <option v-for="f in modifyFields" :key="f.value" :value="f.value">{{ f.label }}</option>
              </select>
            </div>
            <div class="gm-field">
              <label>新值{{ modifyFieldValueIsNumber ? '（数字）' : '' }}</label>
              <input v-model="gmModify.value" :placeholder="modifyFieldValueIsNumber ? '如：10' : '如：新手村'" />
            </div>
            <button class="gm-btn" @click="doModifyPlayer" :disabled="gmLoading">修改属性</button>
            <p v-if="gmModify.result" class="gm-result">{{ gmModify.result }}</p>
          </div>

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
              <textarea v-model="gmAnnouncement.content" placeholder="输入要发送给所有玩家的公告内容...&#10;&#10;支持格式：[文字](链接) 超链接、![说明](图片地址) 配图、**粗体**、*斜体*、`代码`"></textarea>
              <div class="ann-editor-toolbar">
                <input ref="annImgInput" type="file" accept="image/*" multiple style="display: none" @change="onAnnImagesSelected" />
                <button class="btn-ghost" :disabled="annUploading" @click="pickAnnImages">
                  {{ annUploading ? '⏳ 上传中…' : '🖼️ 插入图片' }}
                </button>
                <span class="ann-editor-hint">支持 [文字](链接)、**粗体** 等写法，玩家端链接可直接点击</span>
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
 * - GM 工具：发放物品、设置世界等级、发送全服公告
 */
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { adminApi } from '../api';
import { API_BASE } from '../config';
import AnnRichText from '../components/AnnRichText';

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
    worldLevel.value = res.data.level;
    worldLevelResult.value = `世界等级已设置为 ${res.data.level}`;
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
const groupLabels = { command: '指令设置', game: '游戏数据', system: '系统', bot: '机器人', web: '网页界面', update: '部署更新' };

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
  { field: 'username', label: '用户名' },
  { field: 'nickname', label: '昵称' },
  { field: 'role', label: '角色' },
  { field: 'status', label: '状态' },
  { field: 'level', label: '等级' },
  { field: 'playerName', label: '角色名' },
  { field: 'location', label: '位置' },
  { field: 'lastLoginAt', label: '最后登录' },
  { field: 'loginCount', label: '登录次数' },
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

// ---- GM 发放物品：玩家搜索点选 + 物品目录多选 ----
const gmGiveItem = ref({
  player: null, // 选中的目标用户 { id, username, nickname, player }
  items: [], // 已选物品 [{ name, category, count }]
  result: '',
});

// 目标玩家搜索（复用用户列表接口，输入即搜、点选即定）
const playerQuery = ref('');
const playerOptions = ref([]);
const playerDropdown = ref(false);
const playerSearched = ref(false);
let playerSearchTimer = null;

/** 玩家关键词防抖搜索 */
function searchPlayers() {
  clearTimeout(playerSearchTimer);
  const kw = playerQuery.value.trim();
  if (!kw) {
    playerOptions.value = [];
    playerSearched.value = false;
    return;
  }
  playerSearchTimer = setTimeout(async () => {
    try {
      const res = await adminApi.listUsers({ page: 1, pageSize: 10, keyword: kw });
      playerOptions.value = res.data.list || [];
      playerSearched.value = true;
      playerDropdown.value = true;
    } catch {
      playerOptions.value = [];
      playerSearched.value = true;
    }
  }, 250);
}

/** 点选目标玩家后收起候选列表 */
function choosePlayer(p) {
  gmGiveItem.value.player = p;
  playerQuery.value = '';
  playerOptions.value = [];
  playerSearched.value = false;
  playerDropdown.value = false;
}

// 物品目录（进入 GM 页时懒加载一次）：[{ name, category }]
const itemCatalog = ref([]);
const itemCatalogLoaded = ref(false);
const itemQuery = ref('');
const itemMenuOpen = ref(false);

/** 按关键词筛选目录，最多展示 30 条避免列表过长 */
const filteredCatalog = computed(() => {
  const kw = itemQuery.value.trim().toLowerCase();
  const pool = kw
    ? itemCatalog.value.filter((i) => i.name.toLowerCase().includes(kw))
    : itemCatalog.value;
  return pool.slice(0, 30);
});

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

// 进入 GM 工具页时懒加载物品目录
watch(tab, (t) => {
  if (t === 'gm') loadItemCatalog();
});

/** 点选物品加入已选列表（重复添加只追加数量） */
function addGiveItem(it) {
  const existing = gmGiveItem.value.items.find((s) => s.name === it.name);
  if (existing) {
    existing.count += 1;
  } else {
    gmGiveItem.value.items.push({ name: it.name, category: it.category, count: 1 });
  }
  itemQuery.value = '';
}

/** 是否可提交发放：已选目标玩家且至少一个物品、数量均有效 */
const canGiveItems = computed(
  () =>
    !!gmGiveItem.value.player &&
    gmGiveItem.value.items.length > 0 &&
    gmGiveItem.value.items.every((s) => Number(s.count) >= 1),
);

async function doGiveItem() {
  const g = gmGiveItem.value;
  if (!g.player || !g.items.length) return;
  gmLoading.value = true;
  try {
    const res = await adminApi.giveItem({
      userId: g.player.id,
      items: g.items.map((s) => ({ itemName: s.name, count: Math.max(1, Math.floor(Number(s.count) || 1)) })),
    });
    g.result = res.data?.message || res.message || '发放成功！';
    g.items = [];
    setTimeout(() => (g.result = ''), 5000);
  } catch (e) {
    g.result = '发放失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
  }
}

// ---- GM 背包管理 ----
// 绑定到"用户详情"弹窗：直接对当前用户(id/username)操作，无需再搜索目标玩家。
const gmBackpack = ref({
  userId: null,     // 目标用户ID（当前详情弹窗用户）
  username: '',     // 目标用户名（展示用）
  items: [],        // 背包物品 [{ name, quantity, type, ... }]
  result: '',       // 操作结果
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
  } catch (e) {
    gmBackpack.value.result = '加载背包失败：' + (e.response?.data?.message || e.message);
    gmBackpack.value.items = [];
  } finally {
    gmBackpackLoading.value = false;
  }
}

// 添加物品：下拉目录筛选（复用物品目录数据）
const bkItemQuery = ref('');
const bkItemMenuOpen = ref(false);

const bkFilteredCatalog = computed(() => {
  const kw = bkItemQuery.value.trim().toLowerCase();
  const pool = kw
    ? itemCatalog.value.filter((i) => i.name.toLowerCase().includes(kw))
    : itemCatalog.value;
  return pool.slice(0, 30);
});

/** 点选目录物品加入背包；同名已有则累计数量 */
function addBackpackItem(it) {
  const existing = gmBackpack.value.items.find((s) => s.name === it.name);
  if (existing) {
    existing.quantity = Number(existing.quantity ?? 0) + 1;
  } else {
    gmBackpack.value.items.push({ name: it.name, type: it.category, quantity: 1 });
  }
  bkItemQuery.value = '';
}

/** 删除某条物品（直接移出数组） */
function removeBackpackItem(idx) {
  gmBackpack.value.items.splice(idx, 1);
}

/** 保存背包：数量=0 的条目视为删除，其余整体提交 */
async function saveBackpack() {
  const uid = gmBackpack.value.userId;
  if (!uid) return;
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

// ---- GM 修改玩家属性 ----
// 可修改字段（与后端白名单一致）
const modifyFields = [
  { value: 'level', label: '等级 (level)' },
  { value: 'exp', label: '经验 (exp)' },
  { value: 'name', label: '角色名 (name)' },
  { value: 'hp', label: '当前HP (hp)' },
  { value: 'maxHp', label: '最大HP (maxHp)' },
  { value: 'shield', label: '当前护盾 (shield)' },
  { value: 'maxShield', label: '最大护盾 (maxShield)' },
  { value: 'armor', label: '当前护甲 (armor)' },
  { value: 'maxArmor', label: '最大护甲 (maxArmor)' },
  { value: 'attack', label: '攻击 (attack)' },
  { value: 'defense', label: '防御 (defense)' },
  { value: 'speed', label: '速度 (speed)' },
  { value: 'dodge', label: '闪避 (dodge)' },
  { value: 'hit', label: '命中 (hit)' },
  { value: 'crit', label: '暴击率 (crit)' },
  { value: 'critDmg', label: '暴击伤害 (critDmg)' },
  { value: 'affinity', label: '好感度 (affinity)' },
  { value: 'mapId', label: '地图ID (mapId)' },
  { value: 'location', label: '所在位置 (location)' },
];
const modifyNumericFields = [
  'level', 'exp', 'hp', 'maxHp', 'shield', 'maxShield',
  'armor', 'maxArmor', 'attack', 'defense', 'speed', 'dodge',
  'hit', 'crit', 'critDmg', 'affinity', 'mapId',
];

const gmModify = ref({
  target: '',
  field: 'level',
  value: '',
  result: '',
});

/** 当前选中字段是否为数值型（用于输入提示） */
const modifyFieldValueIsNumber = computed(() => modifyNumericFields.includes(gmModify.value.field));

async function doModifyPlayer() {
  if (!gmModify.value.target || !gmModify.value.value) return;
  gmLoading.value = true;
  try {
    // 后端支持按用户名/昵称/QQ号/ID 解析目标玩家
    const res = await adminApi.modifyPlayer({
      target: String(gmModify.value.target).trim(),
      field: gmModify.value.field,
      value: String(gmModify.value.value),
    });
    gmModify.value.result = res.message || res.data || '修改成功！';
    setTimeout(() => (gmModify.value.result = ''), 3000);
  } catch (e) {
    gmModify.value.result = '修改失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
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

/** 选择图片后上传，成功后把 ![](url) 追加到公告正文光标处（无光标则追加到末尾） */
async function onAnnImagesSelected(e) {
  const files = Array.from(e.target.files || []);
  // 清空 input 值，允许重复选择同一文件
  e.target.value = '';
  if (!files.length) return;
  annUploading.value = true;
  try {
    const res = await adminApi.uploadAnnouncementImage(files);
    const urls = res.data || [];
    if (!urls.length) throw new Error('未返回图片地址');
    const ta = gmAnnouncement.value.content;
    // Markdown 图片语法：括号内不能有空格，否则玩家端解析器不识别
    const snippet = urls.map((u) => `![](${u})`).join('\n');
    // 优先插入到 textarea 光标处，保持编辑体验
    const textareaEl = document.querySelector('.gm-tool-card .gm-field textarea');
    let pos = textareaEl && textareaEl.selectionStart != null ? textareaEl.selectionStart : -1;
    if (pos < 0 || pos > ta.length) pos = ta.length;
    const before = ta.slice(0, pos);
    const after = ta.slice(pos);
    const pad1 = before && !before.endsWith('\n') ? '\n' : '';
    const pad2 = after && !after.startsWith('\n') ? '\n' : '';
    gmAnnouncement.value.content = before + pad1 + snippet + pad2 + after;
  } catch (err) {
    alert('上传公告配图失败：' + (err.response?.data?.message || err.message));
  } finally {
    annUploading.value = false;
  }
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
    adminApi.listConfig().then((res) => { configs.value = res.data; }),
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

/* ===== GM 发放物品：搜索选择器与已选物品列表 ===== */
.picker-box {
  position: relative;
}
.picker-menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--card, rgba(16, 16, 32, 0.98));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.picker-menu li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text, #e5e7eb);
}
.picker-menu li:hover {
  background: rgba(139, 92, 246, 0.18);
}
.picker-menu-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.picker-menu-sub {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted, #9ca3af);
}
.picker-empty {
  justify-content: center;
  color: var(--muted, #9ca3af);
  cursor: default;
}
.picker-empty:hover {
  background: transparent;
}
.picker-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 18px;
  background: rgba(139, 92, 246, 0.12);
  border: 1px solid rgba(139, 92, 246, 0.4);
  color: var(--text, #e5e7eb);
  font-size: 13px;
}
.picker-chip-sub {
  font-style: normal;
  font-size: 11px;
  color: var(--muted, #9ca3af);
}
.picker-chip-x {
  border: none;
  background: transparent;
  color: var(--muted, #9ca3af);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.picker-chip-x:hover {
  color: #f87171;
}
.picked-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.picked-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.picked-name {
  flex: 1;
  font-size: 13px;
  color: var(--text, #e5e7eb);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.picked-cat {
  font-style: normal;
  font-size: 11px;
  color: var(--muted, #9ca3af);
  margin-left: 6px;
}
.picked-qty {
  width: 70px;
  padding: 2px 6px;
  font-size: 13px;
}
.picked-remove {
  border: none;
  background: transparent;
  color: var(--muted, #9ca3af);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.picked-remove:hover {
  color: #f87171;
}

/* ===== GM 背包管理 ===== */
.bk-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  max-height: 320px;
  overflow-y: auto;
  padding-right: 2px;
}
.bk-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.bk-item-name {
  flex: 1;
  font-size: 13px;
  color: var(--text, #e5e7eb);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bk-item-type {
  font-style: normal;
  font-size: 11px;
  color: var(--muted, #9ca3af);
  margin-left: 6px;
}
.bk-item-qty {
  width: 78px;
  padding: 2px 6px;
  font-size: 13px;
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
}
</style>