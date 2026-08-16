-- 玩家私聊与反馈系统
-- 新增：
--   PrivateMessage  玩家一对一的私聊消息
--   Feedback        反馈工单（用户提交，管理员处理）
--   FeedbackMessage 反馈工单内的聊天式消息（支持附件 JSON）
-- User 表补充对应的反向关系字段（外键由新表侧维护）

CREATE TABLE "PrivateMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "senderId" INTEGER NOT NULL,
    "receiverId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrivateMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PrivateMessage_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PrivateMessage_senderId_createdAt_idx" ON "PrivateMessage"("senderId", "createdAt");
CREATE INDEX "PrivateMessage_receiverId_createdAt_idx" ON "PrivateMessage"("receiverId", "createdAt");

CREATE TABLE "Feedback" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Feedback_userId_createdAt_idx" ON "Feedback"("userId", "createdAt");
CREATE INDEX "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt");

CREATE TABLE "FeedbackMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "feedbackId" INTEGER NOT NULL,
    "senderId" INTEGER,
    "senderType" TEXT NOT NULL DEFAULT 'user',
    "content" TEXT NOT NULL,
    "attachments" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackMessage_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "FeedbackMessage_feedbackId_createdAt_idx" ON "FeedbackMessage"("feedbackId", "createdAt");
