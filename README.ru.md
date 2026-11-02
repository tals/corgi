# Corgi <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-dark.svg"><img src="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-light.svg" alt="Корги Corgi виляет хвостом"></picture>

[English](README.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Русский**

Терминальный мультиплексор для людей (и агентов).
Работает на базе [Ghostty](https://github.com/ghostty-org/ghostty),
вдохновлён [herdr](https://github.com/herdrdev/herdr).

[![Claude Code и Codex работают рядом в Corgi](https://corgi.computer/images/hero.gif)](https://corgi.computer/ru/)

## Установка

Поддерживаются macOS (Apple Silicon) и Linux (amd64 или arm64):

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

Запустите `corgi` в каталоге проекта, выберите набор сочетаний клавиш
и нажмите **Создать**, чтобы запустить агента.

Нажмите префиксную клавишу (по умолчанию Ctrl+B), затем `?`, чтобы открыть список сочетаний клавиш.
Пункт **Отключиться** в этом меню закрывает подключение, оставляя агентов работать.
Чтобы подключиться снова, запустите `corgi`.

О настройке, рабочих пространствах и решении проблем читайте в [документации](docs/reference.md) (на английском).

Corgi и установщик поддерживают English, 简体中文, 日本語, 한국어 и русский.
Язык можно изменить в **Настройка Corgi → Язык**.

## Агенты

Запустите `claude`, `codex`, `pi`, `opencode` или `omp` в любой панели.
Corgi автоматически обнаружит их и установит хуки для Claude Code и Codex
или расширение для Pi и Oh My Pi. OpenCode не требует настройки.
В Codex нужно один раз разрешить использование хуков в `/hooks`.

| Возможность                                | Claude Code | Codex | Pi  | OpenCode | Oh My Pi |
| ------------------------------------------ | :---------: | :---: | :-: | :------: | :------: |
| Статус: ▶ работает ● ждёт вас ● готово     |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Сводки активности                          |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Субагенты                                  |      ✓      |   ✓   |     |    ✓     |    ✓     |
| Контекст, токены и лимиты запросов         |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Переименование и ответвление сеанса        |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Восстановление после сбоя или перезагрузки |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Несколько аккаунтов                        |      ✓      |   ✓   |  ✓  |          |          |

## Управление из скриптов

Управляйте запущенным сеансом из любой оболочки. Для вывода в JSON используйте `--json`.
Чтобы указать панель, возьмите её ID из `corgi list`; `current` обозначает текущую панель.

```sh
corgi list
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --lines 50
```

`corgi --help` выводит список команд, а `corgi --skill` — инструкции для агентов.

## Удаление

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## Разработка

Установите [Bun](https://bun.sh), затем выполните:

```sh
./go.ts
```

`go.ts` скачивает [закреплённую версию инструментов Zig](AGENTS.md#zig-toolchain),
собирает и запускает Corgi. При последующих запусках он загружает обновлённую сборку, сохраняя панели.
Процесс разработки и архитектура описаны в [HACKING.md](HACKING.md) (на английском).

## Благодарности

- [Ghostty](https://ghostty.org) и [Kitty](https://sw.kovidgoyal.net/kitty/) —
  за работу над эмуляцией терминала и графикой.
- [herdr](https://github.com/herdrdev/herdr) — главный источник вдохновения для Corgi.
  Многие идеи позаимствованы оттуда.
- [Pi](https://github.com/earendil-works/pi) — мы используем библиотеку
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui).
- [Bun](https://bun.sh) — среда выполнения TypeScript, на которой работает Corgi.

Спасибо первым тестировщикам за предложения и отзывы:
[Max Bittker](https://x.com/MaxBittker),
[Aaron Blakeman](https://github.com/ablakeman),
[Kai Johnson](https://github.com/sirkaiserkai),
[Luke Alonso](https://github.com/lukealonso),
[Keith Adams](https://pebblebed.com/team/keith-adams) и
[Roland Huß](https://ro14nd.de).

## Лицензия

Corgi распространяется под [лицензией MIT](LICENSE).

Звуки уведомлений в [`assets/sounds/`](assets/sounds/) взяты из herdr без изменений
и по-прежнему распространяются под [Apache License 2.0](assets/sounds/LICENSE).
Подробности — в [README звуков](assets/sounds/README.md) (на английском).

`corgi licenses` выводит эти лицензии вместе с лицензиями другого ПО, входящего в Corgi.
Их список находится в [`assets/licenses.txt`](assets/licenses.txt).
