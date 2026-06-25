# webview-diff

웹뷰 안에서 도는 웹앱의 디자인 차이를 잡는 도구.

같은 웹 화면이 Android WebView(Blink)와 iOS WKWebView(WebKit), 그리고 개발용 브라우저에서
다르게 그려지는 곳을 찾는다. 픽셀 비교만 하는 게 아니라, 인셋에 가려진 버튼(occlusion)이나
성능 회귀(Web Vitals)도 같은 실행에서 같이 본다.

프레임워크에 묶이지 않는다. 검사 대상은 그냥 URL이고, 웹뷰 브릿지가 필요하면 설정으로 mock을 끼운다.

## 설치

레지스트리 없이 GitHub에서 바로 받는다.

```bash
pnpm add -D github:Lee-Young-Jae/webview-diff
pnpm exec webview-diff init --base http://localhost:3000
pnpm exec playwright install chromium webkit
```

`init`이 `webview-diff.config.json`을 만들어 준다. 라우트만 채우면 된다.

```bash
pnpm exec webview-diff selftest                       # 검출기 동작 확인 (브라우저 불필요)
pnpm exec webview-diff --base http://localhost:3000   # 검사 실행
```

결과는 `.out/report.html`(보는 용), `.out/result.json`(CI용), 그리고 종료 코드로 나온다.

## 무엇을 검출하나

비교는 한 번에 한 가지만 바꿔서 한다. 그래야 실패했을 때 원인이 하나로 좁혀진다.

| 축 | 비교 | 잡는 것 |
|---|---|---|
| engine | Blink vs WebKit | 엔진별 렌더 차이 (폼 컨트롤, 폰트, flex/grid) |
| platform | android vs ios 분기 | `bridge.platform`/`data-platform` 분기 코드가 갈라지는 곳 |
| safe-area | inset 없음 vs 노치/홈 인디케이터 | OS 인셋에 따른 레이아웃 변화 |
| regression | 기준선 vs 현재 | 내 변경이 화면을 바꿨는지 (같은 엔진, 정밀 비교) |
| occlusion | DOM 검사 | 인셋에 가려져 못 누르는 버튼/숨은 요소 |
| perf | Web Vitals | FCP/LCP/CLS/TBT, 전송량/요청 수 예산 |

작은 색 변화처럼 전체 픽셀 비율로는 묻히는 차이는 연결 성분(cluster) 크기로 따로 본다.
occlusion은 픽셀이 아니라 DOM을 보고, 버튼이 노치나 홈 인디케이터 영역에 들어가 있으면 잡는다.
픽셀 비교로는 알 수 없는 부분이다.

## 신뢰성

비주얼 회귀 도구는 오탐이 한 번 나오면 아무도 안 본다. 그래서 몇 가지를 한다.

- `selftest`가 검출기 자체의 정밀도/재현율/오탐률을 잰다. 합성 화면에 알려진 변화와 노이즈를
  섞어 넣고 측정한다. 지금 값은 1.0 / 1.0 / 0.
- 캡처 전에 시간과 난수를 고정하고, 애니메이션을 멈추고, 폰트와 이미지와 lazy 로딩을 기다린다.
  같은 입력이면 같은 픽셀이 나온다.
- 엔진 간 폰트 렌더 차이는 주변 픽셀 매칭으로 걸러서, 진짜 레이아웃 변화만 남긴다.
- 성능 수치는 CPU와 네트워크를 스로틀하고 여러 번 재서 중앙값을 쓴다.

## 명령

```
webview-diff init [--base <url>] [--ci]   config 생성 (+ GitHub Actions 워크플로)
webview-diff                              전체: 캡처 → diff(+occlusion) → 리포트 → 종료코드
webview-diff capture | diff               캡처만 / 기존 캡처로 재계산
webview-diff perf                         성능(Web Vitals)만
webview-diff approve                      현재 캡처를 회귀 기준선으로 저장
webview-diff selftest                     검출기 점검
```

플래그: `--base <url>`, `--fail-on warn|fail`, `--out <dir>`.

## 설정

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "routes": ["/", "/login", "/profile"],
  "masks": ["[data-testid=now]", ".avatar"],   // 날짜·아바타 같은 동적 영역은 빼고 비교
  "bridge": {                                   // 브릿지가 필요한 앱만
    "globalName": "NativeBridge",
    "api": { "getAuthToken": "mock.token", "getUser": { "id": "u1" } }
  },
  "perf": { "enabled": false, "profiles": ["baseline", "engine-webkit"] }
}
```

브릿지가 필요 없는 앱이면 `bridge`는 빼면 된다. `globalName`을 주면 그 이름으로 `window`에 mock을
붙이고, `api`에 적은 메서드는 적은 값을 그대로 돌려준다. `platform`과 safe-area 인셋은 프로파일에서
자동으로 넣는다. 더 복잡한 브릿지가 필요하면 `bridge.initScript`에 직접 작성한 JS 파일 경로를 주면 된다.

## Claude 스킬 (선택)

같은 저장소가 Claude Code 플러그인도 겸한다. 설치하면 검출 결과를 원인별로 정리하고,
고칠지 / 기준선으로 받을지 / 마스크할지 물어본다.

```
/plugin marketplace add Lee-Young-Jae/webview-diff
/plugin install webview-diff
/webview-diff:design-check
```

스킬은 엔진을 그대로 호출한다. 그래서 고칠 게 생기면 한 군데만 바꾸면 CLI·CI·스킬에 같이 반영된다.

## 데모

번들된 예제 페이지에 엔진·플랫폼·인셋·occlusion·성능 문제를 일부러 심어 뒀다.

```bash
pnpm exec webview-diff fixtures &     # localhost:4321
pnpm exec webview-diff
```

설계 배경과 한계는 [DESIGN.md](./DESIGN.md) 참고.

MIT
