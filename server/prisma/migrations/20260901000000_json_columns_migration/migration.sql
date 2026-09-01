-- AlterTable
ALTER TABLE `channel` MODIFY `description` TEXT NOT NULL DEFAULT ('');

-- AlterTable
ALTER TABLE `command` MODIFY `alias` TEXT NOT NULL DEFAULT (''),
    MODIFY `description` TEXT NOT NULL DEFAULT (''),
    MODIFY `argsSchema` TEXT NOT NULL DEFAULT ('[]');

-- AlterTable
ALTER TABLE `delayedtask` MODIFY `payload` JSON NOT NULL DEFAULT ('{}');

-- AlterTable
ALTER TABLE `feedback` MODIFY `userLastReadAt` DATETIME(3) NOT NULL DEFAULT ('1970-01-01 00:00:00');

-- AlterTable
ALTER TABLE `feedbackmessage` MODIFY `attachments` JSON NOT NULL DEFAULT ('[]');

-- AlterTable
ALTER TABLE `gamemap` MODIFY `description` TEXT NOT NULL DEFAULT (''),
    MODIFY `monsters` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `summons` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `resources` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `resources2` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `connections` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `npcs` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `items` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `buildings` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `vehicles` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `markers` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `markers2` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `mapBuffs` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `requireMarkers` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `failHint` TEXT NOT NULL DEFAULT (''),
    MODIFY `clearMarkers` TEXT NOT NULL DEFAULT (''),
    MODIFY `spawnMonsters` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `tempMonsters` JSON NOT NULL DEFAULT ('[]');

-- AlterTable
ALTER TABLE `gamemonster` MODIFY `bonus` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `baseBonus` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `extraBonus` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `equipments` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `weapons` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `equipmentPresets` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `markers` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `markers2` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `buffs` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `achievements` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `set` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `backpack` JSON NOT NULL DEFAULT ('[]');

-- AlterTable
ALTER TABLE `gamevehicle` MODIFY `bonus` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `parts` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `markers` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `markers2` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `recipes` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `builtinParts` JSON NOT NULL DEFAULT ('[]');

-- AlterTable
ALTER TABLE `player` MODIFY `backpack` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `equipment` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `weapons` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `markers` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `markers2` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `buffs` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `tasks` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `titles` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `skills` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `sets` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `bonus` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `baseBonus` JSON NOT NULL DEFAULT ('{}'),
    MODIFY `safeBox` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `equipmentPresets` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `reverse` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `recipes` JSON NOT NULL DEFAULT ('[]'),
    MODIFY `stats` JSON NOT NULL DEFAULT ('{}');

-- AlterTable
ALTER TABLE `systemconfig` MODIFY `value` LONGTEXT NOT NULL DEFAULT (''),
    MODIFY `label` TEXT NOT NULL DEFAULT (''),
    MODIFY `description` TEXT NOT NULL DEFAULT (''),
    MODIFY `options` TEXT NOT NULL DEFAULT ('[]');

-- AlterTable
ALTER TABLE `user` MODIFY `favoriteCommands` JSON NOT NULL DEFAULT ('[]');
