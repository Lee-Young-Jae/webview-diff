# DESIGN — webview-diff (웹뷰 디자인 차이 검출 시스템)

> 최초 동기는 건반(Gunban) 웹뷰 프로젝트지만, 도구는 임의의 웹뷰 웹앱에 쓰도록 범용화됨.

설계 근거와 신뢰성 모델, 내린 결정의 *이유*, 성능 수치, 다음 로드맵.
(이 문서는 진행 추적도 겸한다 — `/loop`로 이어서 개선하는 중.)

---

## 0. 문제 재정의

요구: "웹뷰인 웹과 flutter에서 오는 디자인 차이를 검출". 레포는 아직 구성 전.

분석 결과 **"flutter에서 오는 차이"의 실체**는 Flutter 자체가 아니라, *Flutter가 띄우는 WebView 환경*이
dev 브라우저와 다르다는 데서 온다.

- **렌더 엔진**: Android System WebView = Blink, iOS WKWebView = WebKit. 두 엔진은 폼 컨트롤·폰트
  메트릭·기본 스타일·`100vh`·sticky·flex/grid 세부가 다르다.
- **플랫폼 분기**: 웹이 `bridge.platform`(android/ios)으로 분기한 CSS/JS가 의도치 않게 발산.
- **OS safe-area**: 노치/홈 인디케이터 인셋. 실 WebView는 `env(safe-area-inset-*)`를 OS가 주입,
  dev 크롬은 0. 인셋 처리 실수 = 콘텐츠가 시스템 UI에 가려지는 버그.

→ 따라서 만들 것은 **크로스 엔진 비주얼 회귀 + 환경 격리 검출 시스템**.

---

## 1. 가장 큰 설계 결정: "1 비교 = 1 변수"

순수 픽셀 비교의 함정을 실측으로 확인했다. 초기에 `android-webview`(Blink, DPR 2.625, ios 인셋 없음)
vs `ios-wkwebview`(WebKit, DPR 3, ios 인셋)을 통째로 비교하니 **모든 페이지가 FAIL**, 같은 Blink끼리도
60%. 원인: DPR로 출력 해상도가 달라 이미지 크기 자체가 불일치 + 인셋으로 전체가 수직 이동.

교훈: 여러 변수를 한꺼번에 비교하면 "어딘가 다름"밖에 안 나오고 **원인 특정 불가 = 행동 불가**.

해결:

1. **출력 정규화** — `screenshot({ scale: 'css' })`로 DPR을 출력 크기에서 분리(DPR은 media query/srcset엔
   여전히 영향), 비교쌍은 **공유 뷰포트(393×852)**.
2. **축 분리** — 프로파일을 baseline에서 *딱 한 축*만 다르게 설계: `engine-webkit`(엔진만),
   `platform-ios`(플랫폼 분기만), `insets-ios`(인셋만). 실패하면 원인이 하나.

실측(내장 fixture):

| 비교 | 결과 | 해석 |
|---|---|---|
| `forms` engine | FAIL 3.08% | WebKit가 date/select/radio를 Blink와 다르게 렌더 (진짜 엔진 차이) |
| `drift` platform | FAIL 5.54% | iOS 분기 CSS가 버튼 색/패딩 어긋남 (주입한 버그를 정확히 검출) |
| `home` safe-area | FAIL 13.9% | top-inset만큼 헤더가 밀림 (인셋 처리에 정확히 귀인) |
| `drift`/`forms` platform | PASS 0.000% | 분기 없는 페이지는 완전 동일 (정밀도 입증) |

실 디바이스의 "엔진+플랫폼+인셋+DPR 전부 다름"은 **cross-diff가 아니라 regression(자기 기준선 대비)**로
다룬다 — 그래야 "환경이 원래 다른 것"과 "내 변경이 깬 것"이 안 섞인다.

---

## 2. 신뢰성 모델 (이 도구의 핵심 가치)

비주얼 회귀 도구는 **오탐(flake) 한 번이면 아무도 안 본다.** 그래서 신뢰성을 1순위로 설계했다.

### 2.1 검출기 자체를 검증 — `selftest.mjs`

브라우저 없이 합성 UI를 그려 ground truth를 안다. 측정값(현재):

```text
precision=1.000  recall=1.000  f1=1.000  flake=0.000  miss=0.000
confusion: tp=9 fp=0 tn=16 fn=0   stability: 20/20 PASS
```

- 동일 렌더+노이즈 16쌍 → 전부 PASS (오탐 0)
- 주입한 디자인 변화 9종(색/위치/패딩/요소누락/크기불일치/미세색조/작은점recolor) → 전부 검출 (놓침 0)

이 self-test가 **실제로 결함을 잡았다**: 초기엔 균일한 미세 색조 드리프트(헤더 #fff→#f3f4f6)를
놓쳐 recall 0.75였다. 원인은 pixelmatch 기본 threshold(0.1)가 너무 관대. → regression threshold를
0.035로 조정. recall 1.0 회복.

### 2.2 캡처 flake 제거 — `determinism.mjs`

시간/난수 freeze, 애니·트랜지션·캐럿 정지, `document.fonts.ready`·이미지 `decode()`·lazy 스크롤 대기,
스크롤바 숨김, `reducedMotion:'reduce'`, `networkidle` 폴백. → 같은 입력은 항상 같은 픽셀.

### 2.3 cross-engine 노이즈 억제 — shift-tolerance

WebKit↔Blink는 글리프를 1~2px 다르게 래스터한다(수정 불가·예상됨). diff 이미지로 확인하니
engine 축 home의 빨강이 **전부 텍스트**였다. → `matchRadius`(이웃 매칭 반경) 도입: 임계 초과 픽셀이라도
반경 R 내 상대 이미지에 매칭이 있으면(국소 이동) 카운트 제외. 진짜 이동/리사이즈는 R보다 크게 움직여 남음.
효과: home engine **1.64% → 0.06%**(텍스트 노이즈 붕괴), forms 구조 차이는 그대로.
regression은 R=0(정밀), cross-engine은 R=2.

### 2.4 anti-aliasing 검출

pixelmatch 알고리즘 충실 포팅(YIQ + AA 검출). 엣지 AA를 노이즈로 분류해 별색(노랑) 표기·미카운트.

### 2.5 모드별 2단 임계

- **regression**: pixel 0.035, R=0, pass<0.08% / warn<0.5% / fail. (동일 엔진은 결정적이라 엄격)
- **cross-engine**: pixel 0.1, R=2, pass<0.3% / warn<2% / fail. (솔리드 셰이프 엣지 AA의 불가피한
  노이즈 바닥 ~1-2%를 인정 → 확산 노이즈는 WARN, 구조 차이는 FAIL)

### 2.6 연결 성분(cluster-density) 분석

글로벌 비율만으론 "확산 엣지 노이즈 1.5%(양성)" vs "집중된 실제 차이 0.4%(의미 있음)"를 못 가른다.
→ 실제 diff 픽셀 마스크에 **8-연결 connected-components**를 돌려 클러스터별 `area / bbox / density(=채움률)`를
구한다. 두 가지로 정밀도를 한 단계 올렸다.

- **작은 국소 변화의 재현율 ↑**: 밀집 클러스터는 전체 비율이 게이트 아래여도 승격. 예: 14×14 점 recolor는
  비율 0.066%(PASS 게이트 아래)지만 cluster로 FAIL 검출. self-test가 이를 단언한다.
- **텍스트 false-positive 회피**: cross-engine 텍스트는 *넓고 채움률 ~60%인 띠*로 나타난다. density 게이트를
  regression 0.4 / cross-engine **0.7**로 둬, 솔리드 블록(채움률 ~95-100%)만 승격하고 글자 띠는 무시.
  실측: drift engine의 "321×11, 63% fill" 버튼 라벨 띠 → 승격 안 됨(올바르게 WARN 유지).

리포트는 최대 클러스터의 bbox를 **시안색 박스**로 diff 위에 그려 눈이 진짜 변화로 바로 가게 한다.

### 2.7 성능 측정의 신뢰성 — `perf.mjs`

성능 지표는 본질적으로 시끄럽다(CPU 경합·GC·네트워크). 그래서 두 가지로 재현성을 확보했다.

- **스로틀로 환경 고정**: CDP로 CPU 4× + 네트워크(4G) 스로틀. 없으면 빠른 개발 머신에서 늘 통과하다 CI에서
  깨지는 식이 된다(Lighthouse가 스로틀하는 이유와 동일). Chromium 전용이라 Vitals 게이트는 `baseline`에서 돈다.
- **median-of-N + 분산 보고**: 같은 측정을 N회 반복해 median을 취하고 min/max도 같이 남긴다.
- **늦은 CLS 포착**: 배너/광고는 페인트 후 삽입돼 시프트를 만든다. CPU 스로틀 하에선 그 프레임이 느려, load 이후
  넉넉히(2s) settle해야 안정적으로 잡힌다. (이 타이밍 버그를 `/heavy` fixture로 발견·수정했다.)
- WebKit은 layout-shift/longtask/LCP observer를 지원하지 않아 Vitals를 `n/a`로 표기하고, 로드/바이트만 비교한다.

검증: 의도적으로 long task(700ms)·지연 배너를 심은 `/heavy`에서 **TBT 651ms(FAIL)·CLS 0.18(WARN)·LCP 772ms**를
정확히 검출, 건강한 페이지는 모두 PASS.

### 2.8 Safe-area occlusion 감사 — `safe-area-audit.mjs`

픽셀 diff는 "인셋이 레이아웃을 바꿨다"까지만 안다. 정작 위험한 버그 — **탭 버튼이 홈 인디케이터/노치 아래로
가려져 누를 수 없게 된 것** — 은 픽셀로 못 잡는다(가려진 픽셀과 정상 픽셀이 똑같이 보인다). 그래서 DOM을 감사한다.

- 프로파일의 실제 인셋을 적용한 상태에서, 인터랙티브/텍스트 요소의 박스가 **불안전 밴드**(top=상태바/노치,
  bottom=홈 인디케이터)에 들어가는지 검사.
- **신호 대 잡음**: 인터랙티브 요소가 밴드에 들어가면 **FAIL**(탭 불가/숨김 = 명백한 버그). 일반 텍스트는
  **bottom 밴드에서만 WARN** — 상단 텍스트가 상태바 아래로 스크롤되는 건 흔히 허용되는 패턴이라 무시한다.
- 캡처 시 인셋 프로파일에서만 같이 돌고(추가 비용 ≈ DOM eval 1회), 리포트·게이트에 합쳐진다.

검증: 인셋을 무시한 상단바/하단 CTA를 심은 `/occlusion`에서 **뒤로가기 버튼(top)·결제 버튼(bottom) 2개를
정확히 검출(FAIL)**, 인셋을 올바로 처리한 페이지는 무결.

---

## 3. 브릿지 mock (`bridge-mock.mjs`)

웹은 `window.NativeBridge`에만 의존하므로(아키텍처), mock이 없으면 인증/네이티브 의존 화면이 안 그려진다.
앱 스크립트보다 먼저(`addInitScript`) 주입하고, **프로파일의 실제 platform·safe-area를 반영**해서
플랫폼 조건부 렌더까지 충실히 재현한다(가짜 단일 플랫폼으로 숨기지 않음). 이 mock은 fe-web의 dev용
mock 브릿지와 그대로 공유 가능(아키텍처상 어차피 필요한 것 = 중복 제거).

---

## 4. 성능

- 캡처: **16장(4라우트×4프로파일) ~6초** (엔진별 브라우저 1회 기동·재사용, 동시성 4, scale:css로 경량).
  → 라우트당 ~0.37초. 라우트·프로파일은 선형 확장, 동시성·샤딩으로 단축 가능.
- diff/리포트(cluster 포함): 12비교 < 1초 (순수 JS, 의존성 0).
- self-test: < 1초 (브라우저 불필요) → PR마다 부담 없이 게이트.

---

## 5. 의존성 철학

**판정 엔진(`src/engine/*`)은 의존성 0** (node 내장 `zlib`만). 이유: CI의 pass/fail을 결정하는 코드가
설치 실패/네이티브 addon/공급망에 흔들리면 안 된다. 무거운 Playwright는 *캡처*에만 필요하고, 캡처 산출물
(PNG)만 있으면 엔진은 어디서든(바 node, 잠긴 샌드박스) 돌아간다.

---

## 6. 로드맵 (우선순위순)

- [x] **연결 성분(cluster-density) 분석** — §2.6. 완료(2026-06-25, iteration 2).
- [x] **성능 예산 게이트** — §2.7. Web Vitals(FCP/LCP/CLS/TBT)+바이트/요청, 스로틀+median, 통합 리포트/게이트.
      완료(2026-06-25, iteration 3).
- [x] **safe-area occlusion 검출** — §2.8. DOM 감사로 인셋에 가려지는 인터랙티브 요소 검출.
      완료(2026-06-25, iteration 4).
- [ ] **Figma 디자인 대조**: `mcp__figma__get_figma_data`로 디자인 프레임을 받아 구현과 대조(디자인↔웹 계약).
      *실제 Figma 파일/토큰이 있어야 end-to-end 검증 가능 → 사용자 입력 필요.*
- [ ] **실 디바이스 캡처 경로**: 에뮬레이션의 한계(WebKit≠실제 WKWebView 100%)를 보완 —
      Flutter `integration_test` 스크린샷 또는 BrowserStack/Appium 경로 문서화·연동.
- [ ] **CI 워크플로 실연**: `ci/github-actions.yml`(템플릿 제공됨)을 실제 PR에 연결,
      report.html을 아티팩트 업로드 + PR 코멘트.
- [ ] **베이스라인 거버넌스**: regression 기준선 변경 시 리뷰 필수(공용 컴포넌트 거버넌스와 동일 원칙).
- [ ] **반응형 축**: 디바이스별 실 뷰포트(360/393/412…)에서의 레이아웃 회귀(별도 축).

---

## 7. 핵심 파일 인덱스

| 파일 | 역할 |
|---|---|
| `src/engine/diff.mjs` | 지각적 diff (YIQ·AA·shift-tolerance·cluster·크기불일치·마스크) |
| `src/engine/png.mjs` | 의존성 0 PNG 코덱 + strokeRect |
| `src/engine/metrics.mjs` | 판정(비율+cluster 승격) + 혼동행렬 |
| `src/engine/perf-budget.mjs` | Web Vitals 예산 판정 |
| `src/capture/perf.mjs` | 성능 측정(스로틀+median, Web Vitals 수집) |
| `src/capture/safe-area-audit.mjs` | DOM occlusion 감사(인셋에 가려지는 요소) |
| `src/capture/profiles.mjs` | 1변수 격리 프로파일 + 비교쌍 |
| `src/capture/determinism.mjs` | flake 제거 하네스 |
| `src/capture/bridge-mock.mjs` | NativeBridge mock |
| `src/run.mjs` | 오케스트레이터 + CI 게이트 |
| `src/selftest.mjs` | 검출기 신뢰성 증명 |
