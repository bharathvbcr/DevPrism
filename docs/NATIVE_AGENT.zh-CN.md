# 原生本地代理（无需 Claude CLI）

[English](NATIVE_AGENT.md) · [한국어](NATIVE_AGENT.ko.md) · [日本語](NATIVE_AGENT.ja.md) · 简体中文

DevPrism 内置了一个**直接与本地 [Ollama](https://ollama.com) 模型通信**的代理运行时，
完全不需要 Claude Code CLI，也不需要任何转换代理。它完全离线、自包含运行。

## 启用方式

1. 安装并启动 Ollama，拉取一个**支持工具调用（tool calling）**的模型：
   ```bash
   ollama pull llama3.1      # 或 qwen2.5、mistral-nemo …
   ```
   （不支持工具调用的小模型可以聊天，但无法使用工具。）
2. 在 DevPrism 中：**设置 → 提供方（Provider）→“原生本地代理（无需 Claude CLI）”**。
3. （可选）在同一面板中将 Ollama 端点/模型配置为 OpenAI 兼容提供方。若不配置，运行时
   将默认使用 `http://localhost:11434` 和已安装的第一个模型。

开关打开时，聊天将使用原生运行时；仅在关闭时才使用云端提供方。

## 功能

- 在 Rust 中运行一个代理循环：用内置工具读取和修改文件，并持续推进直到任务完成 ——
  使用与之前相同的聊天界面、差异对比和“保留/撤销”流程。
- **工具：** `Read`、`Write`、`Edit`（支持 `replace_all`）、`LS`、`Grep`（支持 `glob`/
  `case_sensitive` 范围限定）、`Glob`、`Bash`（在项目中运行并激活 `.venv`）。所有文件
  访问都限制在项目目录内。
- **项目上下文：** 自动发现你的主文件/指令文件、项目地图以及已安装的技能
  （参见 [CONTEXT_FILES.md](CONTEXT_FILES.md)）。
- **记忆：** 按聊天标签页记住对话。
- **视觉：** 粘贴的图片会发送给支持视觉的模型（如 `llava`、`llama3.2-vision`）。

## 调优（原生模式开启时：设置 → 提供方）

- **上下文窗口（`num_ctx`）** —— 模型一次能“看到”的内容量（默认 8192）。越大占用的
  内存/显存越多。低配机器可调小，长文档/长对话可调大。
- **温度（Temperature）** —— 默认 0.4（越低，编辑越确定）。

## 说明与限制

- 工具调用质量取决于模型；相比极小的非工具模型，推荐 `llama3.1` / `qwen2.5` /
  `mistral-nemo`。
- 对话记忆保存在进程内（“新建聊天”/关闭标签页时清除；尚未跨应用重启持久化）。
- 输出以“每次回复”为单位（非逐 token 流式，以匹配聊天界面的消息模型）。
