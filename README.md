# AI Knowledge Graph

Discover semantic connections between your notes using LLM APIs.

打开任何笔记，自动发现语义关联。不用本地模型，只需配置一个 API Key。

## 快速开始

1. 安装插件（手动：将 `main.js`、`manifest.json`、`styles.css` 复制到 `.obsidian/plugins/ai-knowledge-graph/`）
2. 启用插件
3. 设置中选择 API 提供商（DeepSeek / 智谱 GLM / OpenAI / Ollama）并填入 API Key
4. 打开任意笔记，右侧面板自动显示关联笔记

## 功能

- **关联面板**：打开笔记自动展示语义相关的其他笔记
- **自然语言解释**：不只是相似度分数，而是说明为什么相关
- **一键导航**：点击关联笔记直接跳转
- **智能缓存**：结果缓存 24 小时，避免重复 API 调用
- **多提供商**：支持任何 OpenAI 兼容 API（DeepSeek、智谱、OpenAI、Ollama 等）
- **免费开源**

## 命令

- `打开 AI 关联面板`：打开右侧关联面板
- `分析当前笔记的关联`：手动触发关联分析

## 设置

| 设置 | 说明 | 默认值 |
|------|------|--------|
| API Endpoint | OpenAI 兼容接口地址 | OpenAI |
| API Key | 你的 API 密钥 | - |
| 模型 | LLM 模型名称 | gpt-4o-mini |
| 最大关联数 | 每次返回的最大结果数 | 5 |
| 自动分析 | 打开笔记时自动分析 | 开启 |
| 缓存结果 | 缓存 24 小时 | 开启 |

## 推荐 API（性价比）

| 提供商 | 模型 | 大约成本 |
|--------|------|----------|
| DeepSeek | deepseek-chat | ¥0.001/次 |
| 智谱 GLM | glm-4-flash | 免费额度 |
| OpenAI | gpt-4o-mini | $0.0001/次 |
| Ollama | 本地模型 | 免费 |
