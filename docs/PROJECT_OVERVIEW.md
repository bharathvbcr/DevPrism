# ClaudePrism 프로젝트 개요

AI 기반 LaTeX 작성 워크스페이스. 라이브 PDF 미리보기와 데스크톱/웹 앱을 지원합니다.

---

## 1. 프로젝트 구조 (모노레포)

```
claude-prism/
├── apps/
│   ├── web/              # Next.js 웹 앱 (assistant-ui, IndexedDB)
│   ├── desktop/          # Tauri 데스크톱 앱 (Vite + React)
│   ├── desktop-sidecar/  # 데스크톱용 사이드카 서버 (Hono, LaTeX 컴파일)
│   └── latex-api/        # LaTeX 컴파일 API (Hono + TeX Live)
├── packages/             # 공유 패키지
├── reference/opcode/     # 참조용 (opcode 프로젝트)
└── turbo.json            # Turborepo 설정
```

- **실행**
  - 웹: `pnpm dev:web` → Next.js + latex-api
  - 데스크톱: `pnpm dev:desktop` → desktop-sidecar + Tauri 앱

---

## 2. 앱별 역할

### 2.1 `apps/web` (Next.js)

- **역할**: 브라우저에서 동작하는 LaTeX 에디터 + AI 어시스턴트
- **기술**: Next.js 16, assistant-ui, CodeMirror, react-pdf, Upstash Redis(레이트 리밋)
- **특징**
  - 문서는 브라우저 **IndexedDB**에 저장
  - **assistant-ui** + AI SDK로 채팅형 LaTeX 도움
  - LaTeX 컴파일은 외부 `LATEX_API_URL` 호출
- **환경 변수**: `OPENAI_API_KEY`, `LATEX_API_URL`, `KV_REST_API_*`

### 2.2 `apps/desktop` (Tauri)

- **역할**: 로컬 폴더 기반 LaTeX 프로젝트 편집 + **Claude CLI** 연동
- **기술**: Tauri 2, Vite, React 19, CodeMirror, react-pdf, Zustand
- **UI 구성**
  - **Project Picker**: 프로젝트 루트 선택
  - **WorkspaceLayout**: 3분할 패널
    - **Sidebar**: 파일 트리, 폴더/파일 생성·삭제·이름변경, 목차(TOC), 테마, Claude 채팅 열기
    - **LatexEditor**: CodeMirror LaTeX 에디터
    - **PdfPreview**: 실시간 PDF 미리보기
  - **Claude Chat Drawer**: Claude와 채팅, 제안된 변경사항 패널
- **파일/프로젝트**
  - Tauri 플러그인(`fs`, `dialog`, `shell`, `process`)으로 로컬 디스크 읽기/쓰기
  - `document-store`: 프로젝트 루트, 파일 목록, 활성 파일, 커서/선택, PDF 데이터, 컴파일/저장 상태
- **Claude 연동**
  - Rust(`claude.rs`)에서 **Claude CLI** 바이너리 탐색 후 프로젝트 `cwd`에서 실행
  - 스트리밍 출력을 Tauri 이벤트(`claude-output`, `claude-output:{sessionId}`, `claude-complete`)로 프론트에 전달
  - `use-claude-events`: 이벤트 수신 → 메시지 추가, 토큰 집계, **제안된 변경(Edit/Write/MultiEdit)** 등록
- **스토어**
  - `document-store`: 문서/프로젝트 상태
  - `claude-chat-store`: 세션, 메시지, 스트리밍, `sendPrompt` / `cancelExecution` / `newSession`
  - `proposed-changes-store`: Claude가 수정한 파일별 diff → **유지(keep)** 또는 **되돌리기(undo)**

### 2.3 `apps/desktop-sidecar`

- **역할**: 데스크톱 앱 전용 **LaTeX 컴파일 서버**
- **기술**: Hono, Node.js, `pdflatex` 등 로컬 TeX 실행
- **API**
  - `/` : 헬스체크
  - `/builds/*` : 컴파일 요청 (리소스/메인 파일 지정, 프로젝트 디렉터리 기반)
- **동작**: 포트(기본 3001) 사용 시 기동, 이미 사용 중이면 종료(중복 방지)

### 2.4 `apps/latex-api`

- **역할**: LaTeX 소스 수신 → TeX Live(pdflatex)로 컴파일 → PDF 반환
- **배포**: Docker 등으로 별도 서비스로 운영 가능 (웹 앱에서 `LATEX_API_URL`로 사용)

---

## 3. 데스크톱 앱의 핵심 플로우

1. **프로젝트 열기**  
   Project Picker로 폴더 선택 → `document-store.openProject` → 디스크 스캔, 파일 목록 로드.

2. **편집**  
   Sidebar에서 파일 선택 → LatexEditor에 내용 표시, CodeMirror로 편집.  
   저장 시 Tauri fs로 디스크에 쓰기, 필요 시 컴파일 트리거.

3. **컴파일**  
   desktop-sidecar의 `/builds/*` 호출 → 로컬 TeX로 PDF 생성 → `document-store.setPdfData`로 미리보기 갱신.

4. **Claude 채팅**  
   Sidebar에서 채팅 열기 → `claude-chat-store.sendPrompt` → Tauri가 Claude CLI 실행 → 스트리밍 이벤트로 응답 수신.  
   Claude가 Edit/Write/MultiEdit 도구로 파일을 수정하면 `use-claude-events`가 `proposed-changes-store.addChange` 호출.

5. **제안된 변경 처리**  
   Proposed Changes 패널에서 파일별로:
   - **Keep**: 현재(새) 내용 유지, 변경 목록에서 제거.
   - **Undo**: 디스크에 `oldContent` 복원 후 해당 파일 리로드.

---

## 4. 주요 기술 스택 요약

| 구분 | 기술 |
|------|------|
| 빌드/실행 | pnpm, Turborepo |
| 웹 | Next.js 16, React 19, assistant-ui, AI SDK |
| 데스크톱 | Tauri 2, Vite, React 19, Zustand |
| 에디터 | CodeMirror, codemirror-lang-latex |
| PDF | react-pdf, pdfjs-dist |
| 수식 | KaTeX, remark-math, rehype-katex |
| 스타일 | Tailwind CSS, Radix UI, next-themes |
| 데스크톱 AI | Claude CLI (Rust에서 spawn), Tauri 이벤트 스트리밍 |

---

## 5. 참고

- **reference/opcode**: Claude CLI 연동·이벤트 패턴 참고용 (별도 프로젝트).
- **README.md**: 웹 앱 중심 Quick Start, 배포(Vercel + LaTeX API Docker) 안내.

이 문서는 현재 워크트리 기준으로 정리한 개요입니다. 세부 API나 라우트는 각 앱의 소스와 `package.json` 스크립트를 참고하면 됩니다.
