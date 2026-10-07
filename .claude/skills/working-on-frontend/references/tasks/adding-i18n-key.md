# i18n キーを追加・改修する

UI 文言の追加・変更を行う際の手順。**キーは `locales/ja-JP.yml`、`ko-KR.yml`、`en-US.yml` の 3 ファイルに揃えて入れる**。

## 大前提

- この fork は **Crowdin を使わない** (upstream の `crowdin.yml` は merge を楽にするために残してあるだけ)。他言語ファイルを自動で埋めるものは無いので、キーの追加・変更・削除は `ja-JP.yml` (型生成の原本) と `ko-KR.yml`、`en-US.yml` を **同じ commit で** 揃える ([locales/README.md](../../../../../locales/README.md))
- それ以外の locale (`zh-CN.yml` 等) は必要なときだけ手で直す。欠けたキーは実行時に ja-JP へフォールバックする
- 文字列リテラルを SFC に直書きしない (`<span>こんにちは</span>` 等)。必ず `i18n.ts.<key>` を経由する
- 既存キーのリネームは、参照箇所の置換と 3 ファイルのキー名変更を同じ commit で行う。残りの locale に旧キーが残っていても害は無い (未参照になるだけ)。詳細は [knowledge/i18n-usage.md §locale ファイルの運用](../knowledge/i18n-usage.md)

## ステップ 1: ja-JP.yml / ko-KR.yml / en-US.yml にキーを追加

[locales/ja-JP.yml](../../../../../locales/ja-JP.yml) を編集し、同じキーを同じ位置に `ko-KR.yml` と `en-US.yml` にも追加する。YAML の階層構造を維持し、関連するセクションに配置する:

```yaml
# トップレベル単純キー
save: "保存"

# ネストしたカテゴリ (アンダースコア接頭辞は内部カテゴリ)
_settings:
  general: "全般"
  appearance: "外観"

# パラメータ付き (単純なプレースホルダ置換)
# 受け付けるのは {name} 形式のみ。ICU MessageFormat (plural/select) は非対応
greeting: "こんにちは、{name}さん"
```

### 命名のお作法

- 単純キー: lowerCamelCase (例: `saveChanges`, `confirmDelete`)
- カテゴリ: アンダースコア接頭辞 (例: `_settings`, `_abuseUserReport`)
- 既存セクション内に追加する場合は **周辺の既存配置・意味グループに合わせる** (例えば `_settings` は機能ブロック順に並んでおりアルファベット順ではない)。新セクション全体を末尾に追加するのは可
- **HTML タグ (`<b>` `<br>` `<strong>` 等) や `:` `'` `&` を含む値は必ずダブルクォートで囲む** (未クォートだと YAML パース失敗)

**詳細:** ICU 非対応の代替戦略・予約キー `_lang_`・Storybook での挙動は → [knowledge/i18n-usage.md §制約と補足](../knowledge/i18n-usage.md)

## ステップ 2: 型定義の自動再生成

`packages/i18n/build.ts` が `ja-JP.yml` を解析し、TypeScript インターフェースを [packages/i18n/src/autogen/locale.ts](../../../../../packages/i18n/src/autogen/locale.ts) に出力する。

### 自動 (推奨)

`pnpm dev` 実行中なら、`packages/i18n` の watch スクリプト (`nodemon ... tsx ./build.ts --watch`) が yml の変更を検知して自動再生成する。

### 手動

```bash
pnpm --filter i18n generate
```

実体は `tsx scripts/generateLocaleInterface.ts`。

### 失敗パターン

これを実行せずに frontend 側で `i18n.ts.<newKey>` を参照すると、`Locale` インターフェースに追加されていないため typecheck で `Property '<newKey>' does not exist on type 'Locale'` というエラーになる (`pnpm --filter frontend lint` で発覚)。型エラー・実行時警告 (`Unexpected locale key`, `Missing locale parameters`) と対処は → [knowledge/i18n-usage.md §トラブルシュート](../knowledge/i18n-usage.md)。

## ステップ 3: frontend での参照

```ts
import { i18n } from '@/i18n.js';
```

| 用途 | 書き方 |
|---|---|
| 単純文字列 | `i18n.ts.save` |
| ネスト | `i18n.ts._settings.general` |
| パラメータ付き | `i18n.tsx.greeting({ name: userName })` |
| Vue テンプレート内 | `{{ i18n.ts.save }}` / `{{ i18n.tsx.greeting({ name }) }}` |

`i18n.ts` は型付き文字列、`i18n.tsx` は `{name}` プレースホルダを埋め込む関数 (パラメータ付きキーのみ存在。ICU MessageFormat ではなく単純な文字列置換)。

**詳細:** HTML タグ埋め込み・computed によるリアクティブ参照・動的キー切替・ブラケット記法 (`i18n.ts['2fa']`) などの実装パターンは → [knowledge/i18n-usage.md §実装パターン](../knowledge/i18n-usage.md)

## ステップ 4: 検証

```bash
# i18n の型再生成 → typecheck + eslint (lint は generate を呼ばないので順番が必須)
pnpm --filter i18n generate
pnpm --filter i18n lint

# frontend で新キー参照箇所の型チェック
pnpm --filter frontend lint

# ja-JP.yml / ko-KR.yml / en-US.yml の 3 つが揃って出ることを確認
git diff --name-only develop -- 'locales/*.yml'
```

`node scripts/check-shipping.mjs` も同じ検査 (ja-JP.yml を変えたのに ko-KR.yml / en-US.yml が無ければ FAIL) を行う。

## 例: 「ノートを削除しますか？」確認ダイアログを追加する

1. `locales/ja-JP.yml`、`locales/ko-KR.yml`、`locales/en-US.yml` の同じ位置に:
   ```yaml
   # ja-JP.yml
   _notes:
     deleteConfirm: "このノートを削除しますか？"
   # ko-KR.yml
   _notes:
     deleteConfirm: "이 노트를 삭제하시겠습니까?"
   # en-US.yml
   _notes:
     deleteConfirm: "Delete this note?"
   ```
2. `pnpm --filter i18n generate` (または `pnpm dev` で watch 中)
3. SFC:
   ```vue
   <script setup lang="ts">
   import { i18n } from '@/i18n.js';
   import * as os from '@/os.js';

   async function onDelete() {
     const { canceled } = await os.confirm({
       type: 'warning',
       text: i18n.ts._notes.deleteConfirm,
     });
     if (canceled) return;
     // 削除処理
   }
   </script>
   ```

## 参照ファイル

- [locales/README.md (★ 編集ポリシー根拠)](../../../../../locales/README.md)
- [locales/ja-JP.yml](../../../../../locales/ja-JP.yml) / [ko-KR.yml](../../../../../locales/ko-KR.yml) / [en-US.yml](../../../../../locales/en-US.yml)
- [packages/i18n/build.ts](../../../../../packages/i18n/build.ts)
- [packages/i18n/src/autogen/locale.ts (生成物)](../../../../../packages/i18n/src/autogen/locale.ts)
- [packages/frontend/src/i18n.ts](../../../../../packages/frontend/src/i18n.ts)
