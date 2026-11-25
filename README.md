# ASHEN SKYLINE — 灰の摩天楼

灰に沈んだ摩天楼を武装車両で走り抜けるオープンワールド・カーアクション（Three.js / TypeScript / Vite）。
[threejs-game-skills](https://github.com/majidmanzarpour/threejs-game-skills) の `threejs-game-director` の手順で制作。第1章（最初のイベントとバトル）まで遊べます。

## 流れ

1. 自由走行：光柱を目印に第7中継塔へ（約 890 m）。斥候・巡回部隊との遭遇、補給キャッシュ3か所（任意）、物資回収。
2. イベント：中継塔を再起動（カメラ演出＋無線）。Enter でスキップ可。
3. バトル：WAVE 1 → WAVE 2 → ウォーリグ《ジャガーノート》。
4. 大破した場合は Enter でウェーブ先頭からリトライ。
5. クリア後は「フリーローム続行」でエンドレス（懸賞ウェーブ）へ。

## 遊びの要素

- 副武装の誘導ミサイル（前方の敵を捉え続けるとロックオン）
- 物資：スクラップ（40個でミサイル1発を製造）、修理キット、ブースト缶、ミサイル箱
- 爆発ドラム缶：撃つ／高速で体当たりすると誘爆。敵を巻き込める
- スコアとコンボ（×1〜×5）。ドリフト、ニアミス、体当たり撃破、同時撃破などにボーナス
- 強化選択：ウェーブクリア時と補給キャッシュ開封時に3択（徹甲弾、冷却フィン、過給器、増加装甲、ミサイルラック、衝角、回収磁石、応急キット）
- 結果画面のランク（S〜D）

## 操作

| 操作 | キーボード／マウス | タッチ |
| --- | --- | --- |
| アクセル／ブレーキ・後退 | W / S または ↑ / ↓ | 左スティック上下 |
| ステアリング | A / D または ← / → | 左スティック左右 |
| 機関砲（自動照準） | Space / 左クリック | FIRE |
| 誘導ミサイル | E / Q / 右クリック | MISSILE |
| ブースト | Shift | BOOST |
| ハンドブレーキ（ドリフト） | X | DRIFT |
| ポーズ／ミュート | Esc・P ／ M | 画面右上のボタン |
| 強化の選択 | 1 / 2 / 3（または ←→＋Enter） | カードをタップ |
| 決定・リトライ・イベントスキップ | Enter | 画面のボタン |

## 開発

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

- 開発サーバー: `http://127.0.0.1:5188`、本番プレビュー: `npm run preview`（`http://127.0.0.1:4188`）
- URL パラメータ `?quality=low` / `?quality=high` で描画品質を固定（指定なしは端末種別で自動選択＋フレーム時間に応じた自動解像度調整）
- `main` への push で `.github/workflows/pages.yml` が GitHub Pages へデプロイ

## 構成

| パス | 役割 |
| --- | --- |
| `src/game/Game.ts` | 進行管理（走行／イベント／バトル）、戦闘、テストフック |
| `src/game/contracts.ts` | 車両モデル・HUD・音響の共有インターフェース |
| `src/world/` | 都市レイアウト生成、インスタンス化メッシュ、外壁・路面シェーダー、中継塔 |
| `src/entities/` | 車両物理、敵 AI |
| `src/systems/` | 空と光、レンダーパイプライン、VFX、カメラ、降灰、音響（Web Audio 合成） |
| `src/assets/modelFactories/` | 主人公車・バギー・ウォーリグ・残骸のプロシージャルモデル |
| `src/ui/` | HUD、ミニマップ、タッチ操作、各種画面 |
| `docs/` | 設計メモ、検証記録、スクリーンショット |

## アプリとしてインストール（Claude Desktop）

Claude のアーティファクトとして公開済み: https://claude.ai/artifact/EuFAem98TywjVrT9JqT8wK （非公開。所有者と共有相手のみ）

Claude Desktop（Mac / Windows、6.28899.0 以降、ベータ機能）でアーティファクトを開き、タイトルメニュー（または右クリック）→「アプリとしてインストール」→「インストール」。
手順の出典: https://support.claude.com/ja/articles/18516354

アーティファクト用ファイルの再生成:

```bash
npm run build:artifact
```

`artifact-build/ashen-skyline.html`（ページ本体）と `artifact-build/game.js`（ゲーム本体）が出力されます。

## テスト用フック

`window.__THREE_GAME_TEST_HOOKS__` に `seed` / `setState` / `setPausedForScreenshot` / `setReducedMotion` / `advance` を公開。
`setState` の状態名: `title` `active-play` `event` `battle` `boss` `boss-final` `failed` `complete` `pickups` `drums` `missile` `cache` `cache-clear` `upgrade` `endless` `endless-rig`。

```bash
node scripts/inspect-threejs-canvas.mjs --manifest artifacts/evidence.json --url http://127.0.0.1:4188 --seed 42
```

外部アセット生成サービスは使用していません。モデル・テクスチャ・効果音・音楽は全て実行時にコードで生成しています。
