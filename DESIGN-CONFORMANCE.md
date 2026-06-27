# 디자인 일치(conformance) 게이트

Figma 디자인과 구현된 웹이 맞는지 검사한다. 크로스엔진 비주얼 diff와는 별개 관심사다(웹 산출물 ↔ 디자인 비교, 웹뷰 무관). 에이전트 루프(수정 → 검사 → 다르면 수정복귀)의 게이트로 쓰도록 만들었다.

방향은 다중 소스 리서치로 정했다(28소스 / 25주장 3표 교차검증). 결론과 인용은 아래.

## 픽셀이 아니라 구조를 비교하는 이유

픽셀/스크린샷 베이스라인(Playwright `toHaveScreenshot`, Chromatic, Percy)은 코드↔코드 회귀만 잡는다. 베이스라인이 디자인과 맞는지는 구조적으로 답할 수 없다(Playwright 공식 문서로 확인). 디자인↔코드 게이트엔 맞지 않는다.

대신 브라우저를 계측기로 쓴다. `getComputedStyle`로 실제 색·타이포·간격·반경을, `getBoundingClientRect`로 실제 크기를 읽어 Figma 노드 토큰과 비교한다. 결과가 결정적이고(같은 DOM → 같은 값) 속성 단위라 행동 가능하다. 에이전트 루프엔 이 둘이 다 필요하다.

선행 사례: vadim.blog "Pixel-Perfect Playwright + Figma MCP"(픽셀 회귀를 써보고 버린 뒤 computed-style 측정으로 전환), kosaki08/uimatch, floto.ai/design-diff.

## 구조

- 하드 게이트 = 구조 diff (`src/conformance/`)
  - `measure.mjs` — 라이브 DOM에서 computed style + bounding rect 추출. Figma REST에서 spec을 당겨오는 `fetchFigmaSpec`도 포함(토큰 필요).
  - `compare.mjs` — spec ↔ 측정값 비교. 색은 CIELAB ΔE76, 치수·간격은 ±px, fontWeight는 정확. 텍스트 내용·이미지·동적 데이터는 제외(오탐 주범). 속성 단위 findings + 총 severity.
  - `index.mjs` — `webview-diff conformance`: 측정 → 비교 → `.out/conformance.json` + 게이트 exit code.
- 매핑 — Figma 노드 ↔ DOM 요소를 명시적으로 잇는다. 가벼운 방법은 `data-fig="cta"` 같은 속성. 컴포넌트 주도 코드베이스면 Figma Code Connect로 이름 기반 매핑(단 Code Connect는 코드를 실행/검증하지 않으니 매핑·컨텍스트로만 쓰고 검사는 이 게이트가 한다).
- 수렴 가드 = 에이전트 루프 (`loop.mjs`). 리서치에서 필수로 나온 셋:
  - 외부 결정적 diff가 유일한 오라클. 에이전트가 자기 성공을 판단하게 두지 않는다(검증 없는 자기비판은 "mirror loop"로 정체 — arXiv 2510.21861, Huang ICLR'24).
  - 수정은 총 severity가 엄격히 줄 때만 채택, 아니면 best-so-far로 롤백(ReLook "Forced Optimization", arXiv 2510.11498).
  - 재시도 횟수 제한, 단계별 검증 강제.
- VLM 비평가(선택, 자문용) — "디자인과 맞나?" 비전 LLM은 토큰 diff가 못 보는 시각 위계·여백을 잡는 보조 신호로는 검증됐다. 단독 게이트로는 불가(관련 강한 단정 5개가 검증에서 폐기). 결정적 게이트로 감쌀 때만 쓴다.

## 에이전트 루프 훅

```
수정 끝
  → webview-diff conformance        (외부 오라클)
  → exit 0?  예 → 통과
            아니오 → .out/conformance.json(속성 단위 findings)을 에이전트에 피드백 → 수정복귀 → 재검사
  (loop.mjs: best-so-far · severity 엄격 감소시만 채택 · 롤백 · 재시도 제한)
```

`loop.mjs`는 `fix`(실제론 코딩 에이전트)와 `check`(재측정+비교)를 받아 위 가드로 구동한다. self-test가 수렴과 thrash 방지를 브라우저 없이 증명한다.

## 사용

```bash
# 로컬 spec
webview-diff conformance --spec my.conformance.json --base http://localhost:3000

# Figma에서 토큰 자동 추출 (spec에 figma.fileKey + mapping, 환경변수 FIGMA_TOKEN)
FIGMA_TOKEN=xxxx webview-diff conformance --spec my.conformance.json --base http://localhost:3000

# 게이트 로직 검증 (브라우저 불필요)
node src/conformance/selftest.mjs
```

spec 형식은 `fixtures/conformance.spec.json` 참고. `figma` 블록 + `FIGMA_TOKEN`을 주면 `expect`를 Figma 노드에서 자동으로 채운다(`measure.mjs`의 `nodeToExpect`).

허용오차: 색 ΔE76 ~2, 치수·간격 ±1.5px. spec의 `tolerances`로 조정.

## 검증된 것 / 안 된 것

self-test가 결정적으로 증명한다: 알려진 델타 검출, 허용오차 내 오탐 0, good fixer 수렴+종료, 악성 overcorrect는 strict-감소 가드가 거부. 라이브 데모(gunban-test 홈)에서 실제 DOM 측정으로 같은 severity를 재현했고, CTA 색 토큰 불일치(#13131A↔#5d5d5d)를 잡았다. 그 과정에서 실데이터가 두 가지를 고치게 했다: oklab/oklch 색 파싱(Tailwind v4), pill 반경 false positive.

아직 미검증/공백:

- 대규모 운영의 유지비·오탐률 longitudinal 데이터 없음(리서치에서 기업 포스트모템 못 찾음).
- 단일 Figma 프레임의 반응형·멀티 브레이크포인트 처리 → 브레이크포인트별 게이트 필요.
- Figma REST가 그림자·그라디언트·인스턴스 오버라이드까지 주는지 — 현재는 색/타이포/간격/반경/치수 부분집합만 본다.
- `fetchFigmaSpec`(REST 자동 추출)는 실제 토큰으로 아직 검증 못 함.

## 주요 위험

- 매핑 드리프트: 레이어 이름·속성이 유지 안 되면 조용히 잘못 비교 → 앵커 컴포넌트를 소수로 고정, 미매핑 노드는 CI 실패.
- 반응형 오탐: 프레임은 한 브레이크포인트 → 브레이크포인트별 게이트 + 콘텐츠 제외.
- 가드 생략 시 루프 thrash: best-so-far + strict 감소 + 재시도 제한은 옵션이 아니다.
- VLM 비평가 과신: 자문으로만.
