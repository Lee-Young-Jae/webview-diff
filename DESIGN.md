# DESIGN — webview-diff

동작 원리, 신뢰성 처리, 충실도의 한계, 설계 결정의 이유를 적어 둔다.
(원래 건반 웹뷰 프로젝트에서 시작했지만 임의의 웹뷰 웹앱에 쓰도록 일반화했다.)

## 문제

웹뷰에 띄우는 웹은 같은 코드라도 환경에 따라 다르게 보인다. 차이의 출처는 셋이다.

- 렌더 엔진: Android WebView=Blink, iOS WKWebView=WebKit. 폼 컨트롤·폰트 메트릭·기본 스타일·`100vh`·sticky·flex/grid 세부가 다르다.
- 플랫폼 분기: `bridge.platform`/`data-platform`으로 가른 CSS·JS가 의도와 다르게 발산한다.
- OS safe-area: 노치·홈 인디케이터 인셋. 인셋을 무시하면 콘텐츠가 시스템 UI에 가린다.

## 핵심 결정: 한 비교에 변수 하나

처음엔 `android-webview`(Blink, DPR 2.625, 인셋 없음)와 `ios-wkwebview`(WebKit, DPR 3, iOS 인셋)를 통째로 비교했다.
모든 페이지가 FAIL이었고 같은 Blink끼리도 60%가 나왔다. DPR로 출력 해상도가 달라 이미지 크기 자체가 안 맞았고, 인셋으로 전체가 수직 이동했기 때문이다. 여러 변수를 섞으면 "어딘가 다름"밖에 안 나오고 원인을 못 짚는다.

그래서:

1. 출력 정규화 — `screenshot({ scale: 'css' })`로 DPR을 출력 크기에서 분리하고, 비교쌍은 같은 뷰포트(393×852)를 쓴다.
2. 축 분리 — baseline에서 한 축만 바꾼 프로파일을 만든다: `engine-webkit`(엔진만), `platform-ios`(플랫폼 분기만), `insets-ios`(인셋만). 그러면 FAIL의 원인이 하나로 잡힌다.

내장 fixture 실측:

| 비교 | 결과 | 해석 |
|---|---|---|
| `forms` engine | FAIL 3.08% | WebKit가 date/select/radio를 Blink와 다르게 렌더 |
| `drift` platform | FAIL 5.54% | iOS 분기 CSS가 버튼 색·패딩을 어긋나게 함 |
| `home` safe-area | FAIL 13.9% | top 인셋만큼 헤더가 밀림 |
| `drift`/`forms` platform | PASS 0% | 분기 없는 페이지는 동일 |

## 충실도와 한계 (에뮬레이션 ≠ 실기기)

도구는 Playwright의 Chromium/WebKit으로 "실제 WebView처럼" 띄우지만, 픽셀까지 같지는 않다. 정직하게:

- 엔진 계열은 같고 빌드는 다르다. Playwright Chromium은 핀고정된 Chrome for Testing 빌드, 실제 Android WebView는 구글이 따로 배포하는 빌드(버전·WebView 전용 동작 차이). Playwright WebKit은 upstream webkit.org 빌드이고 **애플의 iOS WebKit이 아니다.** 레이아웃 엔진 동작은 비슷하지만 같은 바이너리는 아니다.
- 텍스트·폰트 래스터화는 엔진이 아니라 호스트 OS가 한다. macOS에서 띄우면 CoreText+맥 폰트로, Linux에서 띄우면 fontconfig+설치 폰트로 그린다. 그래서 같은 엔진이라도 Mac/Windows/Linux에서 스크린샷이 다를 수 있다(AA·이모지·폴백·Skia 래스터). 로드된 웹폰트는 일관되지만 system-ui·이모지·폴백은 호스트마다 다르다.

운영상 결론:

- 한 번의 실행 안에서 baseline ↔ engine-webkit는 같은 호스트·같은 시점에 찍으므로 호스트가 상수이고 엔진만 변수다. within-run 크로스엔진 비교는 공정하다(호스트 폰트 차이는 양쪽에 똑같이 적용돼 상쇄된다). 잡는 대상은 "WebKit에서 레이아웃이 다르게 깨지나" 같은 구조 차이다.
- 머신을 건너뛰는 regression(예: Mac 기준선 ↔ Linux CI 후보)은 호스트 폰트 차이가 거짓 diff로 뜬다. 비주얼 테스트는 고정된 호스트(Docker/동일 CI 이미지)에서 돌려야 한다.
- 픽셀 단위 실기기 충실도가 필요하면 BrowserStack 실기기나, 실제 WebView 원격 디버깅(Android `chrome://inspect` CDP, iOS web-inspector-proxy)이 보완 경로다.

즉 이 도구는 구조·레이아웃 차이를 잡는 프록시다. AA 무시·shift-tolerance·지각 거리로 호스트 렌더 노이즈를 걷어내고 구조 차이에 집중하는 것도 같은 이유다.

## 신뢰성

오탐이 나면 아무도 결과를 안 본다. 그래서 신뢰성에 다음을 둔다.

- 검출기 자가검증(`selftest.mjs`): 합성 UI로 ground truth를 만들어 정밀도/재현율/오탐을 잰다. 현재 1.0 / 1.0 / 0 (tp=9, fp=0, tn=16, fn=0, stability 20/20). 초기엔 미세 색조 드리프트(#fff→#f3f4f6)를 놓쳐 recall 0.75였고, regression 임계를 0.035로 조정해 회복했다.
- 캡처 결정성(`determinism.mjs`): 시간·난수 freeze, 애니·트랜지션·캐럿 정지, `fonts.ready`·이미지 `decode()`·lazy 스크롤 대기, 스크롤바 숨김. 같은 입력이면 같은 픽셀.
- 지각 거리 + AA 무시: pixelmatch 알고리즘(YIQ) 포팅. 엣지 AA는 이웃 대비로 판별해 카운트에서 뺀다.
- shift-tolerance(`matchRadius`): 임계 초과 픽셀이라도 반경 R 안에 상대 이미지에 매칭이 있으면 국소 이동(렌더 노이즈)으로 보고 제외. home engine 노이즈가 1.64%→0.06%로 떨어졌다. regression R=0, cross-engine R=2.
- cluster(연결 성분): 진짜 diff 픽셀을 8-연결로 묶어 area/density를 본다. 밀집 블록은 전체 비율이 게이트 아래여도 승격(작은 국소 변화 재현율↑), 채움률 낮은 텍스트 띠는 무시(false positive 회피). density 게이트 regression 0.4 / cross-engine 0.7.
- 2단 임계: regression은 pixel 0.035·R=0·엄격, cross-engine은 pixel 0.1·R=2·pass<0.3%/warn<2%(솔리드 엣지 AA의 노이즈 바닥 1~2% 인정).

## 성능 측정 (`perf.mjs`)

성능 지표는 시끄러우므로 재현성을 둔다.

- CDP로 CPU 4×·네트워크 스로틀(없으면 빠른 개발 머신에서만 통과하다 CI에서 깨진다).
- 같은 측정을 N회 반복해 median, min/max도 남김.
- 늦은 CLS(페인트 후 삽입되는 배너 등)는 load 이후 넉넉히 settle해야 잡힌다.
- Vitals(FCP/LCP/CLS/TBT)는 Chromium에서만 신뢰(WebKit observer 미지원 → n/a). WebKit은 로드·바이트만 비교.

`/heavy` fixture(의도적 long task·지연 배너)에서 TBT 651ms·CLS 0.18·LCP 772ms를 검출, 건강한 페이지는 PASS.

## Safe-area occlusion (`safe-area-audit.mjs`)

픽셀 diff는 "버튼이 가려져 못 누르게 됐다"를 못 잡는다(가려진 픽셀과 정상 픽셀이 같게 보임). 그래서 DOM을 본다.

- 프로파일 인셋 기준으로, 인터랙티브/텍스트 요소의 박스가 불안전 밴드(top=상태바/노치, bottom=홈 인디케이터)에 드는지 검사.
- 인터랙티브가 밴드에 들면 FAIL(탭 불가/숨김). 일반 텍스트는 bottom 밴드에서만 WARN(상단 텍스트가 상태바 아래로 스크롤되는 건 흔한 패턴이라 무시).

`/occlusion` fixture에서 인셋 무시한 뒤로가기·결제 버튼 2개를 검출, 올바른 페이지는 무결.

## 브릿지 mock (`bridge-mock.mjs`)

웹이 JS 브릿지(`window.<name>`)에 의존하면 브라우저엔 그게 없어 화면이 안 그려진다. 설정으로 mock을 앱 코드보다 먼저 주입한다(`globalName`+`api`+`props`). `platform`과 safe-area 인셋은 프로파일에서 자동으로 넣는다. 브릿지가 필요 없는 앱은 생략한다.

## 의존성 철학

판정 엔진(`src/engine/*`)은 의존성이 0이다(node `zlib`만). pass/fail을 정하는 코드가 설치 실패·네이티브 addon·공급망에 흔들리면 안 되기 때문이다. 무거운 Playwright는 캡처에만 필요하고, PNG만 있으면 엔진은 어디서든 돈다.

## 성능 수치

- 캡처: 4라우트×4프로파일 ~6초(엔진별 브라우저 1회 기동·재사용, scale:css).
- diff+리포트: 의존성 0 순수 JS, 12비교 < 1초.
- self-test: < 1초(브라우저 불필요).

## 파일

| 파일 | 역할 |
|---|---|
| `src/engine/diff.mjs` | 지각 diff (YIQ·AA·shift-tolerance·cluster·크기불일치·마스크) |
| `src/engine/png.mjs` | 의존성 0 PNG 코덱 |
| `src/engine/metrics.mjs` | 판정 + 혼동행렬 |
| `src/engine/perf-budget.mjs` | Web Vitals 예산 판정 |
| `src/engine/report.mjs` | HTML 리포트 |
| `src/capture/profiles.mjs` | 1변수 격리 프로파일 |
| `src/capture/capture.mjs` | 멀티엔진 캡처 + occlusion 훅 |
| `src/capture/determinism.mjs` | flake 제거 |
| `src/capture/perf.mjs` | 성능 측정 |
| `src/capture/safe-area-audit.mjs` | DOM occlusion 감사 |
| `src/capture/bridge-mock.mjs` | 브릿지 mock |
| `src/run.mjs` | 오케스트레이터 + CI 게이트 |
| `src/selftest.mjs` | 검출기 자가검증 |

## 남은 일

- Figma 대조는 [DESIGN-CONFORMANCE.md](./DESIGN-CONFORMANCE.md) 참고. 자동 추출(`fetchFigmaSpec`)은 실제 토큰으로 검증 전.
- 실 디바이스 캡처 경로(BrowserStack / 원격 디버깅).
- CI 워크플로 실연(`ci/github-actions.yml` 템플릿 제공).
- 반응형 축(디바이스별 실 뷰포트).
