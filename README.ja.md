# Corgi <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-dark.svg"><img src="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-light.svg" alt="しっぽを振る Corgi のコーギー"></picture>

[English](README.md) · [简体中文](README.zh.md) · **日本語** · [한국어](README.ko.md) · [Русский](README.ru.md)

人とエージェントのためのターミナルマルチプレクサ。
[Ghostty](https://github.com/ghostty-org/ghostty) を基盤とし、
[herdr](https://github.com/herdrdev/herdr) に着想を得ています。

[![Corgi で並べて実行している Claude Code と Codex](https://corgi.computer/images/hero.gif)](https://corgi.computer/ja/)

## インストール

macOS（Apple Silicon）または Linux（amd64 / arm64）に対応しています。

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

プロジェクトのディレクトリで `corgi` を実行し、キーバインドのプリセットを選んで、
**新規**をクリックするとエージェントを起動できます。

プレフィックスキー（既定は Ctrl+B）に続けて `?` を押すと、ショートカットが表示されます。
メニューの**デタッチ**を選ぶと、エージェントを動かしたまま接続を切れます。
もう一度 `corgi` を実行すると再接続できます。

設定、ワークスペース、トラブルシューティングについては[ドキュメント](docs/reference.md)（英語）を参照してください。

Corgi とインストーラーは English、简体中文、日本語、한국어、русский に対応しています。
**Corgi設定 → 言語**から表示言語を変更できます。

## エージェント

任意のペインで `claude`、`codex`、`pi`、`opencode`、`omp` を実行できます。
Corgi はこれらを自動で検出し、Claude Code と Codex にはフックを、
Pi と Oh My Pi には拡張機能をインストールします。OpenCode には追加の設定は不要です。
Codex では、初回のみ `/hooks` でフックを信頼する操作が必要です。

| 機能                               | Claude Code | Codex | Pi  | OpenCode | Oh My Pi |
| ---------------------------------- | :---------: | :---: | :-: | :------: | :------: |
| 状態：▶ 作業中 ● 確認待ち ● 完了   |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| アクティビティの要約               |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| サブエージェント                   |      ✓      |   ✓   |     |    ✓     |    ✓     |
| コンテキスト、トークン、レート制限 |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 名前の変更とフォーク               |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| クラッシュや再起動後の復元         |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 複数アカウント                     |      ✓      |   ✓   |  ✓  |          |          |

## スクリプトからの操作

任意のシェルから、実行中のセッションを操作できます。JSON 出力には `--json` を使います。
ペインの指定には `corgi list` で確認できる ID を、現在のペインには `current` を使います。

```sh
corgi list
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --lines 50
```

`corgi --help` でコマンド一覧を、`corgi --skill` でエージェント向けの操作手順を表示できます。

## アンインストール

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## 開発

[Bun](https://bun.sh) をインストールし、次を実行します。

```sh
./go.ts
```

`go.ts` は[指定バージョンの Zig ツールチェーン](AGENTS.md#zig-toolchain)をダウンロードし、
Corgi をビルドして起動します。次回以降は、ペインを維持したまま変更後のビルドを読み込みます。
開発手順とアーキテクチャについては [HACKING.md](HACKING.md)（英語）を参照してください。

## 謝辞

- [Ghostty](https://ghostty.org) と [Kitty](https://sw.kovidgoyal.net/kitty/)：
  ターミナルエミュレーションとグラフィックスに関する取り組みに感謝します。
- [herdr](https://github.com/herdrdev/herdr)：Corgi の主な着想源であり、
  多くのアイデアを参考にしています。
- [Pi](https://github.com/earendil-works/pi)：
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) ライブラリを使用しています。
- [Bun](https://bun.sh)：Corgi の TypeScript ランタイムです。

提案やフィードバックを寄せてくださった初期のテスターの皆さんにも感謝します。
[Max Bittker](https://x.com/MaxBittker)、
[Aaron Blakeman](https://github.com/ablakeman)、
[Kai Johnson](https://github.com/sirkaiserkai)、
[Luke Alonso](https://github.com/lukealonso)、
[Keith Adams](https://pebblebed.com/team/keith-adams)、
[Roland Huß](https://ro14nd.de)。

## ライセンス

Corgi は [MIT ライセンス](LICENSE)で公開されています。

[`assets/sounds/`](assets/sounds/) の通知音は herdr から変更せずに取り込んだもので、
引き続き herdr の [Apache License 2.0](assets/sounds/LICENSE) が適用されます。
詳しくは[通知音の README](assets/sounds/README.md)（英語）を参照してください。

`corgi licenses` は、これらのライセンスに加え、Corgi に含まれる他のソフトウェアのライセンスも表示します。
一覧は [`assets/licenses.txt`](assets/licenses.txt) にあります。
