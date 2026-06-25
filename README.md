# webview-diff

**웹뷰에 올라가는 웹앱의 디자인 차이를 검출하는 시스템.**

같은 웹 콘텐츠가 **Android System WebView(Blink)** 와 **iOS WKWebView(WebKit)**, 그리고 개발자가
매일 보는 dev 브라우저에서 **서로 다르게 그려지는 지점**을 자동으로 찾아낸다. 픽셀 비주얼 회귀에
더해, **인셋에 가려져 못 누르는 버튼(occlusion)** 과 **성능 회귀(Web Vitals)** 까지 같은 게이트로 잡는다.

특정 프레임워크에 묶이지 않는다 — 검사 대상은 **임의의 URL**이고, 브릿지 mock은 설정으로 끼운다.

---

## 설치 (간단)

```bash
# 1) 패키지 (레지스트리 불필요 — GitHub에서 바로)
pnpm add -D github:Lee-Young-Jae/webview-diff

# 2) 셋업: config 스캐폴드 + 다음 단계 안내
pnpm exec webview-diff init --base http://localhost:3000

# 3) 브라우저 바이너리 (최초 1회)
pnpm exec playwright install chromium webkit
```

이후:

```bash
pnpm exec webview-diff selftest                       # 검출기 자체 신뢰성 검증(브라우저 X)
pnpm exec webview-diff --base http://localhost:3000   # 검사 → .out/report.html + exit code
```

> 모노레포 내부 앱이면 `workspace:*`로, 정식 배포면 npm publish로도 동일하게 쓸 수 있다.

---

## 무엇을, 어떻게 검출하나 — "1 비교 = 1 변수"

순수 픽셀 비교는 엔진·플랫폼·인셋 차이가 **뒤섞여** "어딘가 다름"밖에 못 말한다. 비교쌍마다
**딱 한 축만** 다르게 둬서, 실패하면 **원인이 하나로 특정**된다.

| 축(axis) | 비교 | 무엇을 잡나 |
|---|---|---|
| **engine** | Blink ↔ WebKit | 엔진별 렌더 차이 (네이티브 폼 컨트롤, 폰트 메트릭, flex/grid) |
| **platform** | android ↔ ios 분기 | `bridge.platform`/`data-platform` 분기 CSS·JS의 의도치 않은 발산 |
| **safe-area** | inset 0 ↔ notch/home-indicator | OS 인셋에 따른 레이아웃 변화 |
| **regression** | baseline ↔ 현재 | 내 변경이 디자인을 바꿨는지 (동일 엔진, 정밀 비교) |
| **occlusion** | DOM 감사 (인셋 프로파일) | 인셋에 가려져 **못 누르는 버튼/숨은 요소** (픽셀 diff가 못 잡음) |
| **perf** | Web Vitals | FCP/LCP/CLS/TBT + 바이트/요청 수 예산 초과 |

작은 변화는 **cluster-density**(연결 성분)로 잡는다 — 밀집 블록(잘못 칠해진 배지)은 전체 비율이
게이트 아래여도 승격하고, 채움률 낮은 텍스트 띠(엔진 폰트 노이즈)는 무시한다. occlusion은 **DOM을
감사**해 인터랙티브 요소가 노치/홈 인디케이터에 들어가면 FAIL로 짚는다.

---

## 신뢰성이 이 도구의 전부

비주얼 회귀 도구는 **오탐(flake) 한 번이면 아무도 안 본다.**

- **검출기 자체를 테스트** (`webview-diff selftest`, 브라우저 불필요): 합성 UI에 알려진 변화/동일+노이즈를
  주입해 `precision / recall / flake`를 측정. 현재 **1.0 / 1.0 / 0.0**.
- **결정성 하네스**: 시간·난수 freeze, 애니·캐럿 정지, 폰트/이미지/lazy 대기 → 같은 입력은 같은 픽셀.
- **shift-tolerance**: cross-engine 글리프 래스터 노이즈를 억제(진짜 이동/리사이즈만 남김).
- **성능 재현성**: CPU·네트워크 스로틀 + median-of-N.

---

## 명령

```bash
webview-diff init [--base <url>] [--ci]   # config 스캐폴드 (+ GitHub Actions 워크플로)
webview-diff                              # 전체: capture → diff(+occlusion) → report → exit code
webview-diff capture | diff               # 캡처만 / 기존 캡처로 빠른 재계산
webview-diff perf                         # 성능(Web Vitals)만
webview-diff approve                      # 현재 캡처를 regression 기준선으로 승인
webview-diff selftest                     # 검출기 신뢰성 검증
# 플래그: --base <url>  --fail-on warn|fail  --out <dir>
```

산출물: `.out/report.html`(사람용), `.out/result.json`(머신용), **exit code**(CI 게이트).

---

## 설정 (`webview-diff.config.json`)

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "routes": ["/", "/login", "/profile"],          // 문자열 단축형 허용
  "masks": ["[data-testid=now]", ".avatar"],       // 동적 영역 무시(전 라우트 공통)
  "bridge": {                                       // 선택: 웹이 JS 브릿지에 의존할 때만
    "globalName": "NativeBridge",                   // window.<이름> 으로 mock 주입
    "api": { "getAuthToken": "mock.token", "getUser": { "id": "u1" } },
    "props": { "version": "1.0.0" }
  },
  "perf": { "enabled": false, "profiles": ["baseline", "engine-webkit"] }
}
```

- **브릿지 mock**: 많은 웹뷰 앱은 `window.NativeBridge` 같은 JS 브릿지에 의존한다. 일반 브라우저엔
  없어서 인증/네이티브 의존 화면이 안 그려지므로, mock을 **설정으로** 끼운다. `globalName`을 주면
  그 이름으로 주입하고, `api`(메서드→반환값)·`props`를 단다. `platform`·safe-area 인셋은 프로파일에서
  **자동** 제공된다. 브릿지가 필요 없는 앱은 `bridge`를 생략하면 된다. 완전 커스텀이 필요하면
  `bridge.initScript`에 직접 작성한 JS 파일 경로를 줄 수 있다.
- **임계/프로파일**: 모드별 민감도·디바이스 프로파일은 `thresholds`/`profiles`로 오버라이드.

---

## Claude 스킬로 쓰기 (선택)

검출 + **AI 해석**을 한 번에. 같은 저장소가 Claude Code 플러그인도 겸한다.

```text
/plugin marketplace add Lee-Young-Jae/webview-diff
/plugin install webview-diff
/webview-diff:design-check        # 검출 실행 + 원인 축별 해석 + 고치기/baseline/마스크 제안
```

엔진을 그대로 호출하므로(로직 중복 0) **개선은 한 곳만 고치면** CLI·CI·스킬 사용자에게 함께 전파된다.

---

## 데모

번들 fixture로 즉시 체험(엔진/플랫폼/safe-area/occlusion/perf 실패를 의도적으로 심어 둠):

```bash
pnpm exec webview-diff fixtures &     # http://localhost:4321
pnpm exec webview-diff                # 결과는 .out/report.html
```

설계 근거·신뢰성 모델·로드맵은 [`DESIGN.md`](./DESIGN.md) 참조.

---

MIT · author Lee-Young-Jae
