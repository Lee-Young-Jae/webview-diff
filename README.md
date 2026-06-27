# webview-diff

웹뷰에 띄우는 웹앱이 환경마다 다르게 보이는지, 디자인대로 됐는지 검사하는 CLI.

같은 화면을 Android WebView(Blink) / iOS WKWebView(WebKit) / dev 브라우저로 각각 렌더해서 비교한다.
픽셀 비교에 더해 인셋에 가려진 버튼(occlusion), Web Vitals, Figma 대조(conformance)도 같이 본다.
검사 대상은 URL이면 된다. 프레임워크는 안 가린다.

## 빠른 시작

```bash
npm i -D github:Lee-Young-Jae/webview-diff
npx playwright install chromium webkit
npx webview-diff init --base http://localhost:3000   # webview-diff.config.json 생성
npx webview-diff                                      # 검사
```

결과는 `.out/report.html`, `.out/result.json`, exit code(CI 게이트)로 나온다.

## 명령어

`npx webview-diff <명령> [옵션]`. 브라우저가 필요한 명령은 검사 대상 앱이 떠 있어야 한다.

### `webview-diff` — 전체 검사 (기본)

캡처 → 비주얼 diff → occlusion → perf(config에서 켠 경우) → 리포트를 한 번에 한다.
출력은 `.out/report.html`(사람용), `.out/result.json`(머신용), 그리고 종료 코드. PR마다 돌리는 기본 명령.

### `webview-diff capture`

라우트 × 프로파일을 스크린샷해 `.out/captures/`에 저장만 한다(비교·리포트는 안 함).

### `webview-diff diff`

이미 찍힌 `.out/captures/`로 비교·리포트만 다시 만든다(캡처 생략, 빠름). 임계·마스크를 바꿔 재평가할 때 쓴다.

### `webview-diff conformance --spec <file>`

구현 DOM과 Figma 디자인 토큰을 구조 비교한다(픽셀 아님). 결과는 `.out/conformance.json`(속성 단위 findings).
spec에 `figma` 블록과 환경변수 `FIGMA_TOKEN`이 있으면 Figma에서 토큰을 자동으로 끌어온다. 형식·배경은 [DESIGN-CONFORMANCE.md](./DESIGN-CONFORMANCE.md).

### `webview-diff perf`

Web Vitals(FCP/LCP/CLS/TBT)와 전송량·요청 수만 측정한다. CPU·네트워크 스로틀 + N회 median. Vitals는 Chromium에서만 신뢰(WebKit은 n/a).

### `webview-diff approve`

지금 `.out/captures/`를 `baselines/`로 복사해 regression 기준선으로 승인한다. 변경이 의도된 것일 때.

### `webview-diff init [--base <url>] [--ci]`

`webview-diff.config.json`을 만든다. `--ci`면 GitHub Actions 워크플로도 함께 깐다. 설치 직후 한 번.

### `webview-diff selftest`

검출기 자체를 합성 데이터로 검증한다(브라우저 불필요, 빠름). exit 0이면 신뢰 가능. CI 첫 단계로 권장.

### `webview-diff clear`

생성물(`.out/`)을 지운다.

### 전역 플래그

| 플래그 | 의미 | 기본 |
|---|---|---|
| `--base <url>` | 검사 대상 URL (config의 `baseUrl`을 덮어씀) | config 값 |
| `--fail-on warn\|fail` | 어느 등급부터 게이트를 실패로 볼지 | `fail` |
| `--out <dir>` | 산출물 디렉토리 | `.out` |

### 종료 코드

`0` 통과 · `1` 게이트 실패(차단) · `2` 캡처 실패.

## 비주얼 diff가 보는 것

한 번에 한 가지만 바꿔서 비교한다. 그래야 빨갛게 뜨면 원인이 하나로 잡힌다.

| 축 | baseline ↔ | 잡는 것 |
|---|---|---|
| engine | WebKit | 엔진별 렌더 차이 (폼 컨트롤·폰트·flex) |
| platform | ios 분기 | platform 분기 코드가 갈라지는 곳 |
| safe-area | iOS 인셋 | 인셋에 따른 레이아웃 변화 |
| regression | 승인된 기준선 | 내 변경이 화면을 바꿨는지 |

occlusion은 픽셀이 아니라 DOM을 봐서, 노치·홈인디케이터에 가려진 탭 타깃을 잡는다(픽셀로는 안 보임).

동작 원리·구조·신뢰성(self-test, AA 무시, shift-tolerance, cluster)은 [DESIGN.md](./DESIGN.md)에 정리해 뒀다.

## 설정 (`webview-diff.config.json`)

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "routes": ["/", "/login"],
  "masks": ["[data-testid=now]"],     // 날짜·아바타 같은 동적 영역 제외
  "perf": { "enabled": false }
}
```

웹뷰 브릿지(`window.NativeBridge` 같은)에 의존하는 앱이면 mock을 끼운다. 안 쓰면 생략:

```jsonc
"bridge": { "globalName": "NativeBridge", "api": { "getAuthToken": "mock.token" } }
```

`platform`과 safe-area 인셋은 프로파일에서 자동으로 넣는다.

## Figma 대조

`getComputedStyle`로 실제 색·간격·반경 등을 읽어 Figma 토큰과 비교한다(픽셀 아님). 자세한 건
[DESIGN-CONFORMANCE.md](./DESIGN-CONFORMANCE.md).

```bash
npx webview-diff conformance --spec my.conformance.json
```

## Claude Code 플러그인 (선택)

```
/plugin marketplace add Lee-Young-Jae/webview-diff
/webview-diff:design-check
```

## 데모

번들 예제에 엔진·플랫폼·인셋·occlusion·성능 문제를 심어 뒀다.

```bash
npx webview-diff fixtures &   # localhost:4321
npx webview-diff
```

MIT
