import type { UpgradeOption } from './contracts';

export type UpgradeId = 'ap' | 'cooling' | 'turbo' | 'plating' | 'rack' | 'ram' | 'magnet' | 'medkit';

type UpgradeDef = {
  id: UpgradeId;
  name: string;
  icon: UpgradeOption['icon'];
  maxLevel: number;
  describe(nextLevel: number): string;
};

export const UPGRADE_DEFS: UpgradeDef[] = [
  { id: 'ap', name: '徹甲弾', icon: 'cannon', maxLevel: 4, describe: (n) => `機関砲ダメージ +25%（計 +${n * 25}%）` },
  { id: 'cooling', name: '冷却フィン', icon: 'cooling', maxLevel: 3, describe: (n) => `砲身の発熱 −25%（計 −${Math.round((1 - 0.75 ** n) * 100)}%）` },
  { id: 'turbo', name: '過給器', icon: 'boost', maxLevel: 3, describe: (n) => `ブースト容量・回復 +30%（計 +${n * 30}%）` },
  { id: 'plating', name: '増加装甲', icon: 'armor', maxLevel: 4, describe: (n) => `最大装甲 +25（計 ${100 + n * 25}）＋同量を修理` },
  { id: 'rack', name: 'ミサイルラック', icon: 'missile', maxLevel: 2, describe: (n) => `ミサイル最大数 +1（計 ${4 + n}）＋全弾補充` },
  { id: 'ram', name: '衝角', icon: 'ram', maxLevel: 3, describe: (n) => `体当たりダメージ +50%（計 +${n * 50}%）／被ダメージ −40%` },
  { id: 'magnet', name: '回収磁石', icon: 'magnet', maxLevel: 3, describe: (n) => `アイテム吸引範囲 +60%（計 +${n * 60}%）` },
  { id: 'medkit', name: '応急キット', icon: 'repair', maxLevel: 99, describe: () => '装甲を即時 +50 修理' },
];

export const BASE_MISSILE_MAX = 4;
export const BASE_ARMOR = 100;
export const BASE_MAGNET_RADIUS = 9;

/** Owned upgrade levels plus every derived stat the game reads. */
export class Upgrades {
  private readonly levels: Record<UpgradeId, number> = { ap: 0, cooling: 0, turbo: 0, plating: 0, rack: 0, ram: 0, magnet: 0, medkit: 0 };
  private readonly options: UpgradeOption[] = [];

  level(id: UpgradeId): number {
    return this.levels[id];
  }

  reset(): void {
    for (const def of UPGRADE_DEFS) this.levels[def.id] = 0;
  }

  /** Permanent upgrades owned (the instant repair kit does not count). */
  get owned(): number {
    let total = 0;
    for (const def of UPGRADE_DEFS) if (def.id !== 'medkit') total += this.levels[def.id];
    return total;
  }

  snapshot(): Record<UpgradeId, number> {
    return { ...this.levels };
  }

  restore(levels: Record<UpgradeId, number>): void {
    for (const def of UPGRADE_DEFS) this.levels[def.id] = levels[def.id] ?? 0;
  }

  get cannonDamage(): number { return 10 * (1 + 0.25 * this.levels.ap); }
  get heatPerShot(): number { return 0.052 * 0.75 ** this.levels.cooling; }
  get boostFactor(): number { return 1 + 0.3 * this.levels.turbo; }
  get maxArmor(): number { return BASE_ARMOR + 25 * this.levels.plating; }
  get missileMax(): number { return BASE_MISSILE_MAX + this.levels.rack; }
  get ramDamage(): number { return 1 + 0.5 * this.levels.ram; }
  get ramSelfDamage(): number { return 0.6 ** this.levels.ram; }
  get magnetRadius(): number { return BASE_MAGNET_RADIUS * (1 + 0.6 * this.levels.magnet); }
  /** Light enemy health scaling so a stacked build does not trivialise the fights. */
  get enemyHealthScale(): number { return 1 + 0.08 * Math.min(6, Math.max(0, this.owned - 2)); }

  /** Draw three distinct options. `needsRepair` makes the repair kit more likely to show up. */
  draw(rng: () => number, needsRepair: boolean): UpgradeOption[] {
    const pool: UpgradeDef[] = [];
    for (const def of UPGRADE_DEFS) {
      if (this.levels[def.id] >= def.maxLevel) continue;
      if (def.id === 'medkit' && !needsRepair) continue;
      pool.push(def);
    }
    this.options.length = 0;
    if (needsRepair) {
      // guarantee the heal when the player is hurting
      const index = pool.findIndex((def) => def.id === 'medkit');
      if (index >= 0) pool.splice(index, 1);
    }
    while (this.options.length < (needsRepair ? 2 : 3) && pool.length > 0) {
      const def = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      this.options.push(this.option(def));
    }
    if (needsRepair) this.options.push(this.option(UPGRADE_DEFS[UPGRADE_DEFS.length - 1]));
    return this.options;
  }

  private option(def: UpgradeDef): UpgradeOption {
    const level = this.levels[def.id];
    return { id: def.id, name: def.name, description: def.describe(level + 1), icon: def.icon, level };
  }

  /** Raise a level; returns false for an unknown or maxed id. */
  apply(id: string): UpgradeId | null {
    const def = UPGRADE_DEFS.find((entry) => entry.id === id);
    if (!def || this.levels[def.id] >= def.maxLevel) return null;
    this.levels[def.id] += 1;
    return def.id;
  }
}
