# 네이티브 로컬 에이전트 (Claude CLI 불필요)

[English](NATIVE_AGENT.md) · 한국어 · [日本語](NATIVE_AGENT.ja.md) · [简体中文](NATIVE_AGENT.zh-CN.md)

채팅 한 턴은 `manvi run`이 실행합니다. 로컬 Ollama, OpenAI 호환 API, Claude
채팅이 이 경로입니다. 한 번의 완성·임베딩·캡션과 Ollama 관리만 DevPrism에
남습니다. 최신 설명은 [English](NATIVE_AGENT.md)가 기준입니다.

## 활성화 방법

1. Ollama를 설치·실행하고 **도구 호출(tool calling)을 지원하는** 모델을 받습니다:
   ```bash
   ollama pull llama3.1      # 또는 qwen2.5, mistral-nemo, …
   ```
   (도구 호출을 지원하지 않는 소형 모델은 대화는 가능하지만 도구를 사용하지 못합니다.)
2. DevPrism에서: **설정 → 공급자(Provider) → "네이티브 로컬 에이전트 (Claude CLI 불필요)"**.
3. (선택) 같은 패널에서 Ollama 엔드포인트/모델을 OpenAI 호환 공급자로 구성합니다.
   구성하지 않으면 런타임은 기본값 `http://localhost:11434`와 설치된 첫 번째 모델을
   사용합니다.

토글이 켜져 있으면 채팅은 네이티브 런타임을 사용하며, 클라우드 공급자는 토글이 꺼져
있을 때만 사용됩니다.

## Claude 모델

모델 선택기에는 Opus, Sonnet, Haiku, Opus Plan이 있습니다. Opus, Sonnet, Haiku는
각각 `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`에 대응합니다. Opus
Plan은 카탈로그 ID가 아닙니다. 세션 모델은 Opus, heavy 티어는 Sonnet이므로 Opus가
턴을 계획하고 Sonnet이 작성합니다. advisor 티어는 Opus에 머물고, 캐시 키는 선택기
문자열 `opusplan` 그대로입니다. 호스트는 해당 티어의 기본 입력 가격이 선택한 모델보다
높을 때만 Manvi 티어를 고정하므로, Sonnet 채팅이 Opus나 Fable 보조 호출을 시작할 수
없습니다. effort는 `low`, `medium`, `high` 중 하나입니다. Anthropic 키는 설정에 저장된
키를 사용하며, 저장된 키가 없으면 앱 자체 환경의 `ANTHROPIC_API_KEY`를 사용합니다.
`bun run dev:desktop`은 형제 체크아웃의 Go 소스가 디스크의 바이너리보다 새로우면 Manvi
사이드카를 다시 빌드합니다.

## 기능

- `manvi run`이 도구 루프를 실행합니다. 채팅 UI, diff, "유지/되돌리기"는 그대로입니다.
  아래 도구 목록은 이전 Rust 루프의 설명이며, 현재 도구는 Manvi 하네스와 DevPrism MCP입니다.
- **도구:** `Read`, `Write`, `Edit`(`replace_all` 지원), `LS`, `Grep`(`glob`/`case_sensitive`
  범위 지정), `Glob`, `Bash`(프로젝트에서 실행되며 `.venv`를 활성화). 모든 파일 접근은
  프로젝트 디렉터리 내부로 제한됩니다. 이 내장 도구들 외에도 플러그인 레지스트리의 엄선된
  하위 집합을 광고합니다 — 지식 베이스 검색, 이력서 신디사이스/갭 분석/컴파일, 보호된
  이력서 문서 편집(`resume_doc_*`, `resume_variant_*`). 각 팩은 도구 단위로 공개 여부를
  선택합니다 ([PLUGINS.md](PLUGINS.md) 참고).
- **프로젝트 컨텍스트:** 마스터/지시 파일, 프로젝트 맵, 설치된 스킬을 자동으로 발견합니다
  ([CONTEXT_FILES.md](CONTEXT_FILES.md) 참고).
- **메모리:** 채팅 탭별로 대화를 기억합니다.
- **비전:** 붙여넣은 이미지는 비전 지원 모델(`llava`, `llama3.2-vision` 등)로 전송됩니다.
- **스트리밍:** 텍스트/추론 델타는 IPC를 넘기 전 Rust에서 병합됩니다(약 40ms 또는 1KiB
  창). 출력이 잘게 쪼개지는 로컬 모델도 채팅 UI를 범람시키지 않습니다.

## 튜닝 (네이티브가 켜졌을 때 설정 → 공급자)

- **컨텍스트 윈도우(`num_ctx`)** — 모델이 한 번에 "볼" 수 있는 양 (기본 8192). 클수록
  메모리/VRAM을 더 사용합니다. 사양이 낮은 기기에서는 낮추고, 긴 문서/대화에는 높입니다.
- **온도(Temperature)** — 기본 0.4 (낮을수록 더 결정론적인 편집).

## 참고 및 제한 사항

- 도구 호출 품질은 모델에 따라 다릅니다. 매우 작은 비-도구 모델보다 `llama3.1` /
  `qwen2.5` / `mistral-nemo`를 권장합니다.
- 대화 메모리는 프로세스 내에 저장됩니다("새 채팅"/탭 닫기 시 초기화되며, 앱 재시작
  시에는 아직 유지되지 않습니다).
- 출력은 응답 단위입니다(토큰 단위 스트리밍이 아니며, 채팅 UI의 메시지 모델에 맞춥니다).
