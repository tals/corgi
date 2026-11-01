# Corgi <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-dark.svg"><img src="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-light.svg" alt="꼬리를 흔드는 Corgi의 코기"></picture>

[English](README.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · **한국어** · [Русский](README.ru.md)

사람과 에이전트를 위한 터미널 멀티플렉서.
[Ghostty](https://github.com/ghostty-org/ghostty)를 기반으로 하며,
[herdr](https://github.com/herdrdev/herdr)에서 영감을 받았습니다.

[![Corgi에서 나란히 실행 중인 Claude Code와 Codex](https://corgi.computer/images/hero.gif)](https://corgi.computer/ko/)

## 설치

macOS(Apple Silicon)와 Linux(amd64 또는 arm64)를 지원합니다.

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

프로젝트 디렉터리에서 `corgi`를 실행하고 단축키 프리셋을 선택한 다음,
**새로 만들기**를 클릭해 에이전트를 시작하세요.

접두 키(기본값: Ctrl+B)를 누른 뒤 `?`를 누르면 단축키를 볼 수 있습니다.
메뉴에서 **연결 끊기**를 선택하면 에이전트는 계속 실행됩니다.
다시 연결하려면 `corgi`를 실행하세요.

설정, 작업 공간, 문제 해결 방법은 [문서](docs/reference.md)(영문)를 참고하세요.

Corgi와 설치 스크립트는 English, 简体中文, 日本語, 한국어, русский를 지원합니다.
**Corgi 설정 → 언어**에서 표시 언어를 바꿀 수 있습니다.

## 에이전트

아무 패널에서나 `claude`, `codex`, `pi`, `opencode`, `omp`를 실행하세요.
Corgi가 자동으로 감지해 Claude Code와 Codex에는 훅을,
Pi와 Oh My Pi에는 확장 프로그램을 설치합니다. OpenCode는 별도 설정이 필요 없습니다.
Codex에서는 `/hooks`에서 한 번만 훅을 신뢰하도록 승인하면 됩니다.

| 기능                               | Claude Code | Codex | Pi  | OpenCode | Oh My Pi |
| ---------------------------------- | :---------: | :---: | :-: | :------: | :------: |
| 상태: ▶ 작업 중 ● 확인 필요 ● 완료 |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 활동 요약                          |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 하위 에이전트                      |      ✓      |   ✓   |     |    ✓     |    ✓     |
| 컨텍스트, 토큰, 사용량 제한        |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 이름 변경 및 세션 분기             |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 비정상 종료나 재부팅 후 세션 복원  |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| 여러 계정                          |      ✓      |   ✓   |  ✓  |          |          |

## 스크립트로 제어하기

어느 셸에서든 실행 중인 세션을 제어할 수 있습니다. JSON 출력에는 `--json`을 사용하세요.
패널을 지정하려면 `corgi list`에 표시되는 ID를, 현재 패널을 지정하려면 `current`를 사용하세요.

```sh
corgi list
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --lines 50
```

`corgi --help`는 명령어 목록을, `corgi --skill`은 에이전트용 사용 지침을 출력합니다.

## 제거

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## 개발

[Bun](https://bun.sh)을 설치한 뒤 다음을 실행하세요.

```sh
./go.ts
```

`go.ts`가 [지정된 버전의 Zig 도구 모음](AGENTS.md#zig-toolchain)을 다운로드하고 Corgi를 빌드한 뒤 실행합니다.
이후에는 패널을 유지하면서 변경된 빌드를 다시 불러옵니다.
개발 절차와 아키텍처는 [HACKING.md](HACKING.md)(영문)를 참고하세요.

## 감사의 말

- [Ghostty](https://ghostty.org)와 [Kitty](https://sw.kovidgoyal.net/kitty/):
  터미널 에뮬레이션과 그래픽 기능에 기울인 노력에 감사드립니다.
- [herdr](https://github.com/herdrdev/herdr): Corgi의 주요 영감이며,
  많은 아이디어를 참고했습니다.
- [Pi](https://github.com/earendil-works/pi):
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) 라이브러리를 사용합니다.
- [Bun](https://bun.sh): Corgi의 TypeScript 런타임입니다.

제안과 피드백을 보내 주신 초기 테스터 여러분께도 감사드립니다.
[Max Bittker](https://x.com/MaxBittker),
[Aaron Blakeman](https://github.com/ablakeman),
[Kai Johnson](https://github.com/sirkaiserkai),
[Luke Alonso](https://github.com/lukealonso),
[Keith Adams](https://pebblebed.com/team/keith-adams),
[Roland Huß](https://ro14nd.de).

## 라이선스

Corgi는 [MIT 라이선스](LICENSE)로 배포됩니다.

[`assets/sounds/`](assets/sounds/)의 알림 소리는 herdr에서 수정 없이 가져온 것으로,
herdr의 [Apache License 2.0](assets/sounds/LICENSE)이 계속 적용됩니다.
자세한 내용은 [알림 소리 README](assets/sounds/README.md)(영문)를 참고하세요.

`corgi licenses`는 이 라이선스들과 Corgi에 포함된 다른 소프트웨어의 라이선스를 함께 출력합니다.
전체 목록은 [`assets/licenses.txt`](assets/licenses.txt)에 있습니다.
