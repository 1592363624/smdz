"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = require("dotenv");
const path = require("path");
const client_1 = require("@prisma/client");
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const APPLY = process.argv.includes('--apply');
function calcUpgradeExp(level) {
    return (level * level + 5) * (1 + 0 / 100) * (1 - 0 / 100);
}
function getTutorialRequirements() {
    try {
        const fs = require('fs');
        const raw = fs.readFileSync(path.resolve(process.cwd(), 'prisma/data/tasks.json'), 'utf8');
        const t = JSON.parse(raw);
        const arr = Array.isArray(t) ? t : (t.tasks || []);
        const tutorial = arr.find((o) => o.name === '新手教程');
        if (!tutorial)
            return [];
        const reqs = typeof tutorial.requirements === 'string'
            ? JSON.parse(tutorial.requirements)
            : (tutorial.requirements || []);
        return Array.isArray(reqs) ? reqs : [];
    }
    catch {
        return [];
    }
}
async function main() {
    const prisma = new client_1.PrismaClient();
    await prisma.$connect();
    console.log(`[reset] mode=${APPLY ? 'APPLY (will write DB)' : 'DRY-RUN (no writes)'} env DATABASE_URL=${process.env.DATABASE_URL ? 'set' : 'MISSING'}`);
    const users = await prisma.user.findMany({ select: { id: true, qqNumber: true } });
    const qqByUserId = {};
    for (const u of users)
        qqByUserId[u.id] = u.qqNumber || '';
    const startMap = (await prisma.gameMap.findFirst({ where: { name: '新手村' } })) ||
        (await prisma.gameMap.findFirst({ where: { name: '医疗室' } })) ||
        (await prisma.gameMap.findFirst({ orderBy: { id: 'asc' } }));
    const startMapId = startMap?.id ?? 0;
    const startMapName = startMap?.name ?? '新手村';
    console.log(`[reset] startMap: id=${startMapId} name=${startMapName}`);
    const tutorialReqs = getTutorialRequirements();
    console.log(`[reset] tutorial requirements count=${tutorialReqs.length}`);
    const initialBackpack = [
        { name: '石斧', type: '装备', quantity: 1, durability: 0, data: 'e' },
        { name: '皮帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
        { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
        { name: '新手补给', type: '消耗品', quantity: 1, durability: 0, data: '' },
        { name: '面包', type: '消耗品', quantity: 3, durability: 0, data: '' },
    ];
    const initialWeapons = [{ name: '石斧', type: '武器', slot: 1, quantity: 1, durability: 0, data: 'e' }];
    const initialEquipment = [{ name: '布衣', type: '装备', slot: '身体', quantity: 1, durability: 0, data: 'e' }];
    const initialTasks = tutorialReqs.length > 0 ? [{ name: '新手教程', requirements: JSON.parse(JSON.stringify(tutorialReqs)) }] : [];
    const players = await prisma.player.findMany();
    const toReset = players.filter((p) => p.type && p.type !== '');
    console.log(`[reset] total players=${players.length}, to reset (type!='')=${toReset.length}`);
    for (const p of toReset) {
        const qq = qqByUserId[p.userId] || '';
        const updateData = {
            level: 1,
            exp: 0,
            upgradeExp: calcUpgradeExp(1),
            name: '冒险者',
            type: '',
            hp: 100, maxHp: 100,
            shield: 0, maxShield: 0,
            armor: 0, maxArmor: 0,
            attack: 10, defense: 0, speed: 100, dodge: 0, hit: 100, crit: 5, critDmg: 150,
            regenHp: 0, regenShield: 0, regenArmor: 0,
            mapId: startMapId, location: startMapName,
            houseName: '',
            backpack: JSON.stringify(initialBackpack),
            equipment: JSON.stringify(initialEquipment),
            weapons: JSON.stringify(initialWeapons),
            currentWeapon: 0,
            markers: JSON.stringify({ 指引: 0 }),
            markers2: '[]',
            buffs: '[]',
            tasks: JSON.stringify(initialTasks),
            titles: JSON.stringify(['新人']),
            skills: '{}',
            sets: '{}',
            bonus: '{}',
            baseBonus: '{}',
            vehicle: '',
            safeBox: '[]',
            equipmentPresets: '[]',
            reverse: '[]',
            recipes: '[]',
            stats: '{}',
            affinity: 0,
            masterQQ: '',
            vitality: 0,
            lastOpTime: 0,
            readTime: 0,
        };
        console.log(`[reset] userId=${p.userId} qq=${qq || '(unknown)'} name=${p.name} type=${p.type} level=${p.level} -> newgame`);
        if (APPLY) {
            await prisma.player.update({ where: { id: p.id }, data: updateData });
            if (qq) {
                const maps = await prisma.gameMap.findMany({ select: { id: true, summons: true } });
                for (const m of maps) {
                    let arr = [];
                    try {
                        arr = JSON.parse(m.summons || '[]');
                    }
                    catch {
                        arr = [];
                    }
                    const filtered = arr.filter((s) => String(s.QQ) !== String(qq));
                    if (filtered.length !== arr.length) {
                        await prisma.gameMap.update({ where: { id: m.id }, data: { summons: JSON.stringify(filtered) } });
                        console.log(`[reset]   cleaned summons on map ${m.id}: ${arr.length} -> ${filtered.length}`);
                    }
                }
            }
        }
    }
    console.log(`[reset] ${APPLY ? 'APPLIED' : 'DRY-RUN only'}: ${toReset.length} players reset.`);
    await prisma.$disconnect();
}
main().catch((e) => {
    console.error('[reset] FATAL', e);
    process.exit(1);
});
//# sourceMappingURL=reset-players-to-newgame.js.map