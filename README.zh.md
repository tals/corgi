# Corgi <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-dark.svg"><img src="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-light.svg" alt="摇着尾巴的 Corgi 柯基犬"></picture>

[English](README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md)

为人类（和智能体）打造的终端复用器。 基于
[Ghostty](https://github.com/ghostty-org/ghostty)，灵感来自
[herdr](https://github.com/herdrdev/herdr)。

[![Corgi 中并排运行的 Claude Code 和 Codex](https://corgi.computer/images/hero.gif)](https://corgi.computer/zh/)

## 安装

支持 macOS（Apple Silicon）和 Linux（amd64 或 arm64）：

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

在项目目录中运行 `corgi`，选择快捷键预设，然后点击**新建**启动智能体。

先按前缀键（默认为 Ctrl+B），再按 `?` 查看快捷键。
在菜单中选择**断开连接**可退出界面，让智能体继续运行；再次运行 `corgi` 即可重新连接。

有关设置、工作区和故障排查，请参阅[文档](docs/reference.md)（英文）。

Corgi 及其安装脚本支持 English、简体中文、日本語、한국어 和 русский。
可在 **Corgi 设置 → 语言**中切换语言。

## 智能体

在任意窗格中运行 `claude`、`codex`、`pi`、`opencode` 或 `omp`。
Corgi 会自动识别它们，并为 Claude Code 和 Codex 安装钩子，为 Pi 和 Oh My Pi 安装扩展。
OpenCode 无需额外设置。Codex 会在 `/hooks` 中要求你信任这些钩子，只需确认一次。

| 功能                               | Claude Code | Codex | Pi  | OpenCode | Oh My Pi |
| ---------------------------------- | :---------: | :---: | :-: | :------: | :------: |
| 状态：▶ 工作中 ● 等待处理 ● 已完成 |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 活动摘要                           |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 子智能体                           |      ✓      |   ✓   |     |    ✓     |    ✓     |
| 上下文、Token 用量和速率限制       |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 重命名和派生会话                   |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 崩溃或重启后恢复会话               |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 多账号                             |      ✓      |   ✓   |  ✓  |          |          |

## 脚本控制

可从任意 shell 控制正在运行的会话。使用 `--json` 输出 JSON，
使用 `corgi list` 返回的 ID 指定窗格，或用 `current` 指定当前所在的窗格。

```sh
corgi list
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --lines 50
```

`corgi --help` 列出可用命令；`corgi --skill` 输出供智能体使用的操作说明。

## 卸载

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## 开发

安装 [Bun](https://bun.sh)，然后运行：

```sh
./go.ts
```

`go.ts` 会下载[固定版本的 Zig 工具链](AGENTS.md#zig-toolchain)，构建并启动 Corgi。
之后再次运行时，会重新加载更新后的构建，并保留现有窗格。
开发流程和架构说明见 [HACKING.md](HACKING.md)（英文）。

## 致谢

- [Ghostty](https://ghostty.org) 和 [Kitty](https://sw.kovidgoyal.net/kitty/)：
  感谢它们在终端模拟和图形显示方面的工作。
- [herdr](https://github.com/herdrdev/herdr)：Corgi 的主要灵感来源，
  我们借鉴了其中的许多设计。
- [Pi](https://github.com/earendil-works/pi)：我们使用了它的
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) 库。
- [Bun](https://bun.sh)：Corgi 的 TypeScript 运行时。

感谢早期测试者提出的建议和反馈：
[Max Bittker](https://x.com/MaxBittker)、
[Aaron Blakeman](https://github.com/ablakeman)、
[Kai Johnson](https://github.com/sirkaiserkai)、
[Luke Alonso](https://github.com/lukealonso)、
[Keith Adams](https://pebblebed.com/team/keith-adams) 和
[Roland Huß](https://ro14nd.de)。

## 许可证

Corgi 采用 [MIT 许可证](LICENSE)。

[`assets/sounds/`](assets/sounds/) 中的通知音效未经修改，来自 herdr，
仍采用 herdr 的 [Apache License 2.0](assets/sounds/LICENSE)；
详情见[音效说明](assets/sounds/README.md)（英文）。

`corgi licenses` 会输出上述许可证，以及 Corgi 所包含的其他软件的许可证。
完整列表见 [`assets/licenses.txt`](assets/licenses.txt)。
