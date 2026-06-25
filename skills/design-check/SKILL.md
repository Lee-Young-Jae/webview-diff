---
name: design-check
description: 웹뷰 웹앱의 디자인 차이를 검출·해석한다 — 크로스엔진(Blink↔WebKit) 비주얼 회귀, safe-area occlusion(가려진 버튼), Web Vitals 성능. "디자인 검증", "방금 만든 페이지 검증해줘", "비주얼 회귀 확인", "webview-diff 돌려줘", "/design-check" 요청 시 사용. webview-diff CLI를 돌리고 result.json을 읽어 원인 축별로 정리하고 고치기/baseline 승인/마스크를 제안한다.
---

# /webview-diff:design-check — 웹뷰 디자인 차이 검출 + 해석

검출기(`webview-diff`)를 돌리고, 결과를 **원인 축별로 해석해 행동까지** 제안한다.
판정은 기계가(결정적), 해석·수정 판단은 여기서.

## 0. CLI 찾기

다음 순서로 실행 커맨드를 정한다(셸에서 `CLI`로 칭함):
1. 패키지로 설치돼 있으면: `pnpm exec webview-diff` (또는 `npx webview-diff`)
2. 플러그인 번들 사용: `node "$CLAUDE_PLUGIN_ROOT/src/run.mjs"`

## 1. 전제 확인 (한 번만)

- `webview-diff.config.json` 없으면 → `CLI init --base <앱 URL>` 으로 스캐폴드 후 routes를 사용자와 맞춘다.
- Playwright 브라우저 미설치로 캡처가 실패하면 → 사용자에게 `pnpm exec playwright install chromium webkit` 안내(네트워크 필요).
- 대상 URL 결정: (a) 사용자가 준 URL, (b) 떠 있는 dev 서버(예: localhost:3000), (c) 없으면 번들 데모 — `CLI fixtures &` 로 띄우고 `--base http://localhost:4321`.

## 2. 검출 실행

- 전체(캡처+diff+occlusion, perf는 config.perf.enabled면 포함):
  `CLI --base <URL> --fail-on fail`
- 캡처는 그대로 두고 임계만 다시 볼 때(빠름): `CLI diff`
- 성능만: `CLI perf`

종료코드: 0=게이트 통과, 1=차단(FAIL), 2=캡처 실패. **종료코드로 단정하지 말고** 아래 JSON을 읽어 해석한다.

## 3. 결과 해석 — `.out/result.json`

읽을 것: `summary`(pass/warn/fail), `comparisons[]`(route·axis·level·diffRatio·reasons),
`occlusions[]`(route·level·items), `perf[]`(route·level·metrics).

**원인 축별로 묶어** 사람 말로 옮긴다:
- `axis: engine` FAIL → "WebKit(iOS WKWebView)가 이 화면을 Blink와 다르게 렌더. 보통 네이티브 폼 컨트롤/폰트/flex."
- `axis: platform` FAIL → "platform 분기 CSS/JS가 iOS에서 발산. `data-platform`/bridge.platform 분기 확인."
- `axis: safe-area` FAIL → "OS 인셋으로 레이아웃 이동(대개 의도된 응답일 수 있음 — 시각 확인)."
- `occlusion` FAIL → "인셋에 **가려져 못 누르는** 요소: <태그> '텍스트' (top=상태바/노치, bottom=홈 인디케이터). 진짜 버그."
- `perf` FAIL → "예산 초과 지표 명시(TBT/CLS/LCP…)와 값."

각 건은 `reasons`/`items`를 **그대로 인용**해 어디가 왜 깨졌는지 짚는다. WARN은 검토용, FAIL은 차단.

## 4. 행동 제안 (건마다)

- **고치기**: 코드 원인이 분명하면(occlusion·platform 분기·perf) 수정안을 제시하고, 승인 시 바로 수정.
- **baseline 승인**: 변경이 의도된 것이면 `CLI approve` 제안. ⚠ **사람 확인 없이 승인 금지**(기준선은 거버넌스).
- **마스크**: 동적 콘텐츠(날짜·아바타·광고)로 인한 오탐이면 `webview-diff.config.json`의 `masks`에 셀렉터 추가 제안.
- **무시**: cross-engine 텍스트 래스터 노이즈 같은 양성은 WARN 유지로 충분함을 설명.

## 5. 마무리

- 리포트 안내: `.out/report.html`(드래그 와이프 슬라이더 + 심각도 필터 + occlusion/perf 표). 열어볼지 묻는다.
- 머신 결과: `.out/result.json`. CI에 붙일지 물으면 `CLI init --ci`로 워크플로 스캐폴드.

## 원칙

- 종료코드/중간 출력만으로 단정하지 말고 `result.json`을 읽어 평가한다.
- baseline 승인은 항상 사람 확인.
- 같은 화면을 두 번 검사하면 결과는 결정적이어야 한다(아니면 flake — 동적 콘텐츠를 mask 했는지 확인).
