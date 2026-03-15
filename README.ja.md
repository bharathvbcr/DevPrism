<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="ClaudePrism" />
</p>

<h1 align="center">ClaudePrism</h1>

<p align="center">
  Claude で動く、プライベート＆オフラインファーストの科学論文執筆ワークスペース。<br/>
  LaTeX + Python + 100 以上の科学スキル ── すべてローカルで完結します。
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="ClaudePrism デモ" width="800" />
</p>

<p align="center">
  <a href="https://claudeprism.delibae.dev?utm_source=github&utm_medium=readme&utm_campaign=launch_v054">
    <img src="https://img.shields.io/badge/Website-claudeprism.dev-blue?style=flat-square&logo=googlechrome&logoColor=white" alt="Website" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_aarch64.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Apple_Silicon)-black?style=for-the-badge&logo=apple&logoColor=white" alt="macOS 版をダウンロード" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_x64-setup.exe">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows 版をダウンロード" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_amd64.deb">
    <img src="https://img.shields.io/badge/Download-Linux_(deb)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux 版をダウンロード" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/delibae/claude-prism/releases">
    <img src="https://img.shields.io/github/v/release/delibae/claude-prism?style=flat-square&label=Latest%20Release&color=green" alt="Latest Release" />
  </a>
</p>

---

## なぜ ClaudePrism なのか？

[OpenAI Prism](https://openai.com/prism/) は研究者向けのクラウドベース LaTeX ワークスペースです。無料で高機能ですが、**未発表の研究データが OpenAI のサーバーに保存されます**。知的財産の流出リスクや、OpenAI が研究データに対して権利を主張する可能性について、専門家から懸念の声が上がっています。デフォルトでは、コンテンツは将来のモデル学習に利用される場合があり、利用を拒否するにはオプトアウトの設定が必要です。

ClaudePrism はまったく異なるアプローチを採っています：**すべてがローカルマシン上で動きます。**

| | OpenAI Prism | ClaudePrism |
|---|:---:|:---:|
| AI モデル | GPT-5.2（クラウド） | **Claude Opus / Sonnet / Haiku（ローカル CLI）** |
| 実行環境 | ブラウザ（クラウド） | **ネイティブデスクトップ（Tauri 2 + Rust）** |
| LaTeX | クラウドコンパイル | **Tectonic（組み込み、オフライン対応）** |
| Python 環境 | — | **uv + venv 内蔵 ── ワンクリックで科学計算 Python 環境を構築** |
| 科学スキル | — | **100 以上の専門スキル（バイオインフォマティクス、ケモインフォマティクス、ML など）** |
| 導入 | アカウント登録が必要 | **インストールしてすぐ使える ── テンプレートギャラリー ＋ プロジェクトウィザード** |
| バージョン管理 | — | **Git ベースの履歴管理（ラベル＆差分表示）** |
| データプライバシー | クラウド保存、[オプトアウト可](https://help.openai.com/en/articles/8983082-how-do-i-turn-off-model-training-to-stop-openai-training-models-on-my-conversations) | **ローカル実行、[オプトアウト可](https://code.claude.com/docs/en/data-usage)** |
| ソースコード | プロプライエタリ | **オープンソース（MIT）** |

### あなたの研究は、あなたのマシンで

ClaudePrism は **Claude Code** をローカルのサブプロセスとして呼び出します。ドキュメントはディスク上に保存され、AI 推論のためのプロンプトだけが Claude API に送信されます。

**データ取り扱いの比較：**

| | OpenAI Prism | ClaudePrism（Claude Code 経由） |
|---|---|---|
| ドキュメントの保存先 | OpenAI クラウドサーバー | **ローカルディスクのみ** |
| モデル学習のオプトアウト | [可能](https://help.openai.com/en/articles/8983082-how-do-i-turn-off-model-training-to-stop-openai-training-models-on-my-conversations)（設定 > データ管理） | [可能](https://claude.ai/settings/data-privacy-controls)（プライバシー設定または API キー） |
| **オプトアウト後のデータ残留** | **ドキュメントは OpenAI サーバーに残る** | **一切のデータがマシン外に出ない** |
| **フィードバックの落とし穴** | **👍/👎 を押すと会話全体が学習データとして送信される** | **そのような仕組みは存在しない** |
| デフォルトの学習ポリシー | ON（個人アカウント） | ON（コンシューマー）、**OFF**（API キー / チーム / エンタープライズ） |
| データ保持期間 | オプトアウト後 約30日 | 30日（オプトアウト）/ 5年（オプトイン） |
| ゼロデータ保持 | 非対応 | エンタープライズで対応 |
| テレメトリ | 無効化不可 | `DISABLE_TELEMETRY=1` で完全無効化 |
| ソースコード | プロプライエタリ | オープンソース ── [ご自身で監査できます](https://github.com/delibae/claude-prism) |

> **どちらのツールもモデル学習のオプトアウトに対応しています。** 決定的な違いは、ドキュメントがどこに保存されるかです。Prism では学習設定に関係なく、未発表の研究が OpenAI のサーバー上に存在します。ClaudePrism ではファイルがマシンの外に出ることは一切なく、AI 推論のためのプロンプトのみが送信されます。

---

## 機能

### Python 環境（uv）
ClaudePrism には高速な Python パッケージマネージャ [uv](https://docs.astral.sh/uv/) が直接組み込まれています。ワンクリックで uv をインストールし、ワンクリックでプロジェクト単位の仮想環境を作成。Claude Code が Python コード実行時に `.venv` を自動的に使用するため、エディタを離れることなくグラフの生成、解析スクリプトの実行、データ処理が行えます。

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python 環境" width="600" />
</p>

### 100 以上の科学スキル
[K-Dense Scientific Skills](https://github.com/K-Dense-AI/claude-scientific-skills) から専門分野ごとのスキルを閲覧・インストールできます。Claude に各分野の深い知識を与える、厳選されたプロンプトとツール設定です：

| 分野 | スキル |
|--------|--------|
| **バイオインフォマティクス＆ゲノミクス** | Scanpy, BioPython, PyDESeq2, PySAM, gget, AnnData, ... |
| **ケモインフォマティクス＆創薬** | RDKit, DeepChem, DiffDock, PubChem, ChEMBL, ... |
| **データ分析＆可視化** | Matplotlib, Seaborn, Plotly, Polars, scikit-learn, ... |
| **機械学習＆AI** | PyTorch Lightning, Transformers, SHAP, UMAP, PyMC, ... |
| **臨床研究** | ClinicalTrials.gov, ClinVar, DrugBank, FDA, ... |
| **学術コミュニケーション** | 文献レビュー、研究費申請書作成、引用管理, ... |
| **マルチオミクス＆システム生物学** | scvi-tools, COBRApy, Reactome, Bioservices, ... |
| **その他** | 材料科学、ラボ自動化、プロテオミクス、物理学, ... |

スキルはグローバル（`~/.claude/skills/`）またはプロジェクト単位でインストールでき、関連する場面で Claude が自動的に読み込みます。

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="科学スキル" width="700" />
</p>

### テンプレート＆プロジェクトウィザードでかんたんスタート
テンプレート（論文、学位論文、プレゼンテーション、ポスター、レターなど）を選び、名前を付けて、必要に応じて内容を入力すれば、ClaudePrism がプロジェクトをセットアップし、AI で初期コンテンツを生成します。参考ファイル（PDF、BIB、画像）をドラッグ＆ドロップして、すぐに執筆を始められます。

<p align="center">
  <img src="./assets/demo/starter.webp" alt="テンプレートギャラリー＆プロジェクトウィザード" width="700" />
</p>

### Claude AI アシスタント
エディタ上で Claude と直接チャットできます。Sonnet・Opus・Haiku のモデルを切り替え、推論の深さも調整可能。セッションは永続化され、ツール呼び出し（ファイル編集、bash、検索）や拡張可能なスラッシュコマンドにも対応しています。

<p align="center">
  <img src="./assets/demo/claudecommand.webp" alt="Claude AI アシスタント＆スラッシュコマンド" width="600" />
</p>

### 履歴＆変更提案レビュー
保存のたびにローカル Git リポジトリ（`.claudeprism/history.git/`）にスナップショットが作成されます。重要なチェックポイントにラベルを付けたり、任意の 2 つのスナップショット間の差分を確認したり、過去のバージョンに復元したりできます。Claude が編集を提案すると、専用パネルにビジュアル差分が表示され、チャンクごとに承認・却下、または一括で適用・取り消し（`⌘Y` / `⌘N`）が可能です。

<p align="center">
  <img src="./assets/demo/history.webp" alt="履歴＆変更提案" width="700" />
</p>

### オフライン LaTeX コンパイル
Tectonic がアプリに直接組み込まれています。パッケージは初回使用時に一度だけダウンロードされ、ローカルにキャッシュされます。それ以降は TeX Live のインストール不要で、完全にオフラインでコンパイルできます。

### キャプチャ＆質問
`⌘X` でキャプチャモードに入り、PDF 上の任意の領域をドラッグで選択すると、キャプチャされた画像がチャット入力欄に固定され、そのまま Claude に質問できます。数式、図表、レビューアーコメントについて質問するのに最適です。

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="キャプチャ＆質問" width="700" />
</p>

### リアルタイム PDF プレビュー
SyncTeX 対応のネイティブ MuPDF レンダリング。PDF 上の位置をクリックすると、対応するソース行にジャンプします。ズーム、テキスト選択、キャプチャにも対応。

### エディタ
CodeMirror 6 をベースに、LaTeX/BibTeX のシンタックスハイライト、リアルタイムエラー検出、検索＆置換（正規表現対応）、自動保存付きマルチファイルプロジェクトをサポートしています。

### その他
- **Zotero 連携** ── OAuth ベースの文献管理と引用挿入。

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero 連携" width="300" />
</p>

- **スラッシュコマンド** ── 組み込み（`/review`、`/init`）＋ `.claude/commands/` のカスタムコマンド。
- **外部エディタ** ── Cursor、VS Code、Zed、Sublime Text でプロジェクトを開く。
- **ダーク / ライトテーマ** ── 自動切り替え。

---

## インストール

[GitHub Releases](https://github.com/delibae/claude-prism/releases) から最新ビルドをダウンロードしてください。

## コントリビュート

コントリビュートを歓迎します！開発環境のセットアップ、テスト、ガイドラインについては [CONTRIBUTING.md](./CONTRIBUTING.md) をご覧ください。

## 謝辞

本プロジェクトは [assistant-ui](https://github.com/assistant-ui) による [Open Prism](https://github.com/assistant-ui/open-prism) をもとに開発されました。

## ライセンス

[MIT](./LICENSE)
