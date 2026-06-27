---
name: design-overlay
description: Figma 섹션 디자인과 실행 중인 앱(Flutter 네이티브 등) 화면을 오버레이로 비교한다. "피그마랑 앱 화면 비교", "디자인 오버레이", "Figma vs Flutter 스크린샷", "/design-overlay" 요청 시 사용. Figma에서 섹션 PNG를 받고 앱 스크린샷을 찍거나(또는 경로를 받아) onion/difference/nudge로 겹쳐 보는 HTML을 만든다. DOM이 없는 네이티브 Flutter처럼 구조 비교(conformance)를 못 쓸 때 특히 유용. 리뷰용이며 자동 게이트가 아니다.
---

# /webview-diff:design-overlay — 디자인 ↔ 앱 화면 오버레이

Figma 섹션과 실행 앱 화면을 사람이 눈으로 맞춰보게 한다. 결과는 그 시점의 비교(리뷰)이지 CI 게이트가 아니다.

## CLI 찾기

1. 설치돼 있으면: `npx webview-diff` (또는 `pnpm exec webview-diff`)
2. 플러그인 번들: `node "$CLAUDE_PLUGIN_ROOT/src/run.mjs"`

## 입력

- **Figma 섹션 URL** (필수) — `figma.com/design/<fileKey>/...?node-id=<id>`
- **앱 스크린샷 경로** (선택) — 없으면 `flutter screenshot`로 캡처 시도

## 절차

1. **디자인 추출** — URL에서 `fileKey`(`/design/<fileKey>/`)와 `node-id`를 뽑아 `mcp__figma__download_figma_images`로 섹션 PNG를 저장한다(예: `.out/overlay/design.png`). node-id의 `-`는 `:`로 바꿔도 된다.
2. **앱 스크린샷 확보**
   - 사용자가 경로를 줬으면 그대로 사용.
   - 아니면 `flutter screenshot --out .out/overlay/app.png`. 이건 **현재 화면**을 찍으므로, 먼저 시뮬레이터/디바이스에 앱을 띄우고 대상 화면으로 이동해 둔다. 디바이스가 없으면 사용자에게 (a) 시뮬레이터 실행 후 재시도, 또는 (b) 직접 찍은 스크린샷 경로를 요청한다.
3. **오버레이 생성** — `<CLI> overlay --design .out/overlay/design.png --app .out/overlay/app.png` → `.out/overlay.html`.
4. **리뷰** — `open .out/overlay.html`. onion(투명도) / wipe(드래그 분할) / difference(어긋남 글로우) / toggle + 화살표키 nudge로 정렬·비교한다. 사용자에게 무엇을 보면 되는지(어긋난 간격·색·위치) 짚어준다.

## 캡처가 막히면

시뮬레이터·빌드·내비게이션은 환경 의존적이다. 자동 캡처가 안 되면 막지 말고 사용자가 직접 찍은 PNG 경로를 받아 3번부터 진행한다.

## 한계 (명확히 말할 것)

- **리뷰 도구이지 자동 게이트가 아니다.** 결과는 그 시점의 비교다.
- `flutter screenshot`은 현재 화면만 찍는다 — 대상 화면으로 먼저 이동.
- 디자인 export와 앱 화면은 콘텐츠·스케일이 달라 완벽히 겹치지 않는다. difference 모드 + nudge로 *구조*(간격·정렬·색) 일치를 본다.
- 자동 판정이 필요하면 웹은 `conformance`(구조 비교), 네이티브는 결정적 캡처 스크립트(golden) 쪽으로 안내한다.
