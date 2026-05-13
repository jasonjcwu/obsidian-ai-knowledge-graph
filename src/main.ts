import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  TFile,
  Notice,
  ItemView,
  requestUrl,
} from "obsidian";

// ========== Types ==========

interface RelatedNote {
  path: string;
  title: string;
  reason: string;
  similarity?: number;
}

interface PluginSettings {
  // Chat API (LLM for reranking)
  chatEndpoint: string;
  chatApiKey: string;
  chatModel: string;
  // Embedding API
  embeddingEndpoint: string;
  embeddingApiKey: string;
  embeddingModel: string;
  // General
  maxResults: number;
  topCandidates: number;
  autoAnalyze: boolean;
  cacheEnabled: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
  chatEndpoint: "https://api.openai.com/v1",
  chatApiKey: "",
  chatModel: "gpt-4o-mini",
  embeddingEndpoint: "https://api.openai.com/v1",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
  maxResults: 5,
  topCandidates: 20,
  autoAnalyze: true,
  cacheEnabled: true,
};

const VIEW_TYPE = "ai-knowledge-graph-view";

// ========== Embedding Index ==========

interface EmbeddingEntry {
  path: string;
  title: string;
  embedding: number[];
  timestamp: number;
}

interface EmbeddingIndex {
  version: number;
  entries: Record<string, EmbeddingEntry>;
}

// Cosine similarity
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ========== API Helpers ==========

async function getEmbedding(
  endpoint: string,
  apiKey: string,
  model: string,
  text: string
): Promise<number[]> {
  const url = endpoint.replace(/\/+$/, "") + "/embeddings";
  const resp = await requestUrl({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text.slice(0, 8000),
    }),
  });

  const data = resp.json;
  if (!data.data?.[0]?.embedding) {
    throw new Error("No embedding returned from API");
  }
  return data.data[0].embedding as number[];
}

async function callChat(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const url = endpoint.replace(/\/+$/, "") + "/chat/completions";
  const resp = await requestUrl({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const data = resp.json;
  return data.choices?.[0]?.message?.content ?? "";
}

// ========== View ==========

class KnowledgeGraphView extends ItemView {
  plugin: AIKnowledgeGraphPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: AIKnowledgeGraphPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "AI 关联"; }
  getIcon(): string { return "git-branch"; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.classList.add("ai-kg-container");
    this.renderEmpty(container);
  }

  renderEmpty(container: HTMLElement) {
    container.empty();
    container.innerHTML = `
      <div class="ai-kg-empty">
        <div class="ai-kg-empty-icon">🔗</div>
        <div class="ai-kg-empty-text">打开一篇笔记，自动发现关联</div>
        <div class="ai-kg-empty-hint">需要先配置 API Key 并构建索引</div>
      </div>`;
  }

  renderLoading(container: HTMLElement, noteName: string, stage: string) {
    container.empty();
    container.innerHTML = `
      <div class="ai-kg-loading">
        <div class="ai-kg-spinner"></div>
        <div class="ai-kg-loading-text">${stage}「${noteName}」...</div>
      </div>`;
  }

  renderError(container: HTMLElement, errorMsg: string) {
    container.empty();
    container.innerHTML = `
      <div class="ai-kg-error">
        <div class="ai-kg-error-icon">⚠️</div>
        <div class="ai-kg-error-msg">${errorMsg}</div>
        <button class="ai-kg-retry-btn">重试</button>
      </div>`;
    container.querySelector(".ai-kg-retry-btn")?.addEventListener("click", () => {
      this.plugin.analyzeCurrentNote();
    });
  }

  renderResults(container: HTMLElement, noteName: string, results: RelatedNote[], indexStats?: string) {
    container.empty();

    // Header
    const header = container.createDiv("ai-kg-header");
    header.innerHTML = `<span class="ai-kg-header-icon">📎</span> ${noteName} 的关联笔记`;

    // Index stats
    if (indexStats) {
      const stats = container.createDiv("ai-kg-stats");
      stats.textContent = indexStats;
    }

    if (results.length === 0) {
      const empty = container.createDiv("ai-kg-no-results");
      empty.textContent = "没有发现明显的关联笔记";
      return;
    }

    // Results
    const list = container.createDiv("ai-kg-results");
    for (const r of results) {
      const item = list.createDiv("ai-kg-item");

      const titleRow = item.createDiv("ai-kg-item-title");
      const link = titleRow.createEl("a", { cls: "ai-kg-link", text: r.title });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(r.path);
        if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
      });

      if (r.similarity !== undefined) {
        const badge = titleRow.createSpan("ai-kg-sim-badge");
        badge.textContent = `${(r.similarity * 100).toFixed(0)}%`;
      }

      const reason = item.createDiv("ai-kg-item-reason");
      reason.textContent = r.reason;

      const pathEl = item.createDiv("ai-kg-item-path");
      pathEl.textContent = r.path;
    }

    // Footer
    const footer = container.createDiv("ai-kg-footer");
    const btn = footer.createEl("button", { cls: "ai-kg-refresh-btn", text: "🔄 重新分析" });
    btn.addEventListener("click", () => {
      this.plugin.clearResultCache();
      this.plugin.analyzeCurrentNote();
    });
  }
}

// ========== Plugin ==========

export default class AIKnowledgeGraphPlugin extends Plugin {
  settings!: PluginSettings;
  view!: KnowledgeGraphView;
  embeddingIndex: EmbeddingIndex = { version: 1, entries: {} };
  resultCache: Record<string, { results: RelatedNote[]; timestamp: number }> = {};
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private indexingInProgress = false;

  async onload() {
    await this.loadSettings();
    this.embeddingIndex = (await this.loadData()) ?? { version: 1, entries: {} };

    this.registerView(VIEW_TYPE, (leaf) => {
      this.view = new KnowledgeGraphView(leaf, this);
      return this.view;
    });

    // Ribbon
    this.addRibbonIcon("git-branch", "AI 关联", () => this.activateView());

    // Commands
    this.addCommand({
      id: "open-ai-knowledge-graph",
      name: "打开 AI 关联面板",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "analyze-current-note",
      name: "分析当前笔记的关联",
      callback: () => this.analyzeCurrentNote(),
    });
    this.addCommand({
      id: "build-embedding-index",
      name: "构建/更新 Embedding 索引",
      callback: () => this.buildIndex(),
    });

    // Auto-analyze
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && this.settings.autoAnalyze) {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => this.analyzeNote(file), 500);
        }
      })
    );

    this.addSettingTab(new KnowledgeGraphSettingTab(this.app, this));
    console.log("AI Knowledge Graph plugin loaded");
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  // ========== Index ==========

  async buildIndex() {
    if (this.indexingInProgress) {
      new Notice("索引正在构建中...");
      return;
    }
    if (!this.settings.embeddingApiKey) {
      new Notice("请先配置 Embedding API Key");
      return;
    }

    this.indexingInProgress = true;
    const files = this.app.vault.getMarkdownFiles();
    let indexed = 0, skipped = 0, errors = 0;

    new Notice(`开始索引 ${files.length} 篇笔记...`);

    for (const file of files) {
      // Skip if already indexed and file hasn't changed
      const existing = this.embeddingIndex.entries[file.path];
      if (existing && existing.timestamp >= file.stat.mtime) {
        skipped++;
        continue;
      }

      try {
        const content = await this.app.vault.read(file);
        // Use title + first 2000 chars as embedding input
        const text = `${file.basename}\n\n${content.slice(0, 2000)}`;
        const embedding = await getEmbedding(
          this.settings.embeddingEndpoint,
          this.settings.embeddingApiKey,
          this.settings.embeddingModel,
          text
        );
        this.embeddingIndex.entries[file.path] = {
          path: file.path,
          title: file.basename,
          embedding,
          timestamp: Date.now(),
        };
        indexed++;
        // Save periodically
        if (indexed % 20 === 0) {
          await this.saveIndex();
          new Notice(`已索引 ${indexed} 篇...`);
        }
        // Rate limit: small delay between requests
        await new Promise((r) => setTimeout(r, 100));
      } catch (e) {
        console.error(`Failed to index ${file.path}:`, e);
        errors++;
      }
    }

    await this.saveIndex();
    this.indexingInProgress = false;

    // Clean stale entries (deleted files)
    const currentPaths = new Set(files.map((f) => f.path));
    let cleaned = 0;
    for (const path of Object.keys(this.embeddingIndex.entries)) {
      if (!currentPaths.has(path)) {
        delete this.embeddingIndex.entries[path];
        cleaned++;
      }
    }
    if (cleaned > 0) await this.saveIndex();

    const total = Object.keys(this.embeddingIndex.entries).length;
    new Notice(`索引完成: ${indexed} 新增, ${skipped} 未变, ${errors} 失败, 共 ${total} 篇`);
  }

  async saveIndex() {
    await this.saveData(this.embeddingIndex);
  }

  clearResultCache() {
    this.resultCache = {};
  }

  // ========== Analysis ==========

  async analyzeCurrentNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("没有打开的笔记"); return; }
    await this.analyzeNote(file);
  }

  async analyzeNote(file: TFile) {
    const hasEmbeddingKey = !!this.settings.embeddingApiKey;
    const hasChatKey = !!this.settings.chatApiKey;

    if (!hasEmbeddingKey && !hasChatKey) {
      const container = this.view?.containerEl?.children[1] as HTMLElement;
      if (container) this.view.renderError(container, "请先配置 API Key（设置 → AI Knowledge Graph）");
      return;
    }

    // Check result cache
    const cached = this.resultCache[file.path];
    if (cached && this.settings.cacheEnabled && Date.now() - cached.timestamp < 24 * 3600 * 1000) {
      await this.activateView();
      this.view.renderResults(
        this.view.containerEl.children[1] as HTMLElement,
        file.basename, cached.results
      );
      return;
    }

    await this.activateView();
    const container = this.view.containerEl.children[1] as HTMLElement;

    const indexSize = Object.keys(this.embeddingIndex.entries).length;
    if (indexSize === 0) {
      this.view.renderError(container, "索引为空，请先运行「构建 Embedding 索引」命令");
      return;
    }

    try {
      // ===== Stage 1: Embedding similarity =====
      this.view.renderLoading(container, file.basename, "语义检索中");

      const content = await this.app.vault.read(file);
      const queryText = `${file.basename}\n\n${content.slice(0, 2000)}`;

      let queryEmbedding: number[];
      const existing = this.embeddingIndex.entries[file.path];
      if (existing?.embedding) {
        queryEmbedding = existing.embedding;
      } else {
        queryEmbedding = await getEmbedding(
          this.settings.embeddingEndpoint,
          this.settings.embeddingApiKey,
          this.settings.embeddingModel,
          queryText
        );
      }

      // Compute similarity against all indexed notes
      const scores: { path: string; title: string; similarity: number }[] = [];
      for (const [path, entry] of Object.entries(this.embeddingIndex.entries)) {
        if (path === file.path) continue;
        const sim = cosineSim(queryEmbedding, entry.embedding);
        if (sim > 0.3) { // threshold: skip very unrelated
          scores.push({ path, title: entry.title, similarity: sim });
        }
      }

      // Sort by similarity, take top N
      scores.sort((a, b) => b.similarity - a.similarity);
      const topCandidates = scores.slice(0, this.settings.topCandidates);

      if (topCandidates.length === 0) {
        this.view.renderResults(container, file.basename, [],
          `索引 ${indexSize} 篇 | 阈值 0.3 以上无匹配`);
        return;
      }

      // ===== Stage 2: LLM Reranking =====
      if (!hasChatKey) {
        // No chat API — just use similarity scores
        const results: RelatedNote[] = topCandidates.slice(0, this.settings.maxResults).map((c) => ({
          path: c.path,
          title: c.title,
          reason: `语义相似度 ${(c.similarity * 100).toFixed(0)}%`,
          similarity: c.similarity,
        }));
        this.view.renderResults(container, file.basename, results,
          `索引 ${indexSize} 篇 | 候选 ${topCandidates.length} 篇 | 仅 embedding`);
        this.resultCache[file.path] = { results, timestamp: Date.now() };
        return;
      }

      this.view.renderLoading(container, file.basename, "LLM 精排中");

      // Build candidate summary for LLM
      let candidateText = "";
      for (const c of topCandidates) {
        let snippet = "";
        try {
          const f = this.app.vault.getAbstractFileByPath(c.path);
          if (f instanceof TFile) {
            const raw = await this.app.vault.read(f);
            snippet = raw.slice(0, 300).replace(/\n/g, " ").trim();
          }
        } catch { /* skip */ }
        candidateText += `- ${c.title} (${c.path}) [相似度${(c.similarity * 100).toFixed(0)}%]: ${snippet}\n`;
      }

      const systemPrompt = `You are a knowledge graph assistant. Given a note and a list of candidate related notes (already filtered by semantic similarity), re-rank and select the most genuinely related ones.

IMPORTANT: Respond with ONLY valid JSON. No markdown, no code fences.
Return a JSON array, each element:
- "path": exact file path from input (in parentheses)
- "title": note title
- "reason": brief explanation in Chinese (1 sentence) WHY related
Max ${this.settings.maxResults} results.`;

      const userPrompt = `Current note: "${file.basename}"
Path: ${file.path}
Content:
${content.slice(0, 3000)}

---
Candidates (sorted by embedding similarity):
${candidateText}

Select the most genuinely related notes. Respond with JSON array only.`;

      const response = await callChat(
        this.settings.chatEndpoint,
        this.settings.chatApiKey,
        this.settings.chatModel,
        systemPrompt,
        userPrompt
      );

      // Parse
      let results: RelatedNote[] = [];
      try {
        let jsonStr = response.trim();
        const fence = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (fence) jsonStr = fence[1].trim();
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          results = parsed.slice(0, this.settings.maxResults).map((r: any) => ({
            path: r.path || "",
            title: r.title || "",
            reason: r.reason || "",
            // Attach similarity from stage 1 if path matches
            similarity: topCandidates.find((c) => c.path === r.path)?.similarity,
          }));
        }
      } catch (e) {
        console.error("Failed to parse LLM response:", e, response);
        // Fallback: use raw similarity results
        results = topCandidates.slice(0, this.settings.maxResults).map((c) => ({
          path: c.path, title: c.title,
          reason: `语义相似度 ${(c.similarity * 100).toFixed(0)}%`,
          similarity: c.similarity,
        }));
      }

      this.view.renderResults(container, file.basename, results,
        `索引 ${indexSize} 篇 | 候选 ${topCandidates.length} 篇 → 精选 ${results.length} 篇`);
      this.resultCache[file.path] = { results, timestamp: Date.now() };

    } catch (e) {
      console.error("Analysis failed:", e);
      this.view.renderError(container, `分析失败: ${(e as Error).message}`);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
}

// ========== Settings ==========

class KnowledgeGraphSettingTab extends PluginSettingTab {
  plugin: AIKnowledgeGraphPlugin;

  constructor(app: App, plugin: AIKnowledgeGraphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "AI Knowledge Graph 设置" });

    // ===== Embedding Section =====
    containerEl.createEl("h3", { text: "Embedding API（语义检索）" });

    const embPresets: Record<string, { endpoint: string; model: string; label: string }> = {
      openai_emb: { endpoint: "https://api.openai.com/v1", model: "text-embedding-3-small", label: "OpenAI" },
      zhipu_emb: { endpoint: "https://open.bigmodel.cn/api/paas/v4", model: "embedding-3", label: "智谱 GLM" },
    };
    new Setting(containerEl).setName("快速配置").setDesc("一键切换 Embedding 提供商").addButton((btn) => {
      btn.setButtonText("一键选择").setDisabled(true);
    });
    const embPresetDiv = containerEl.createDiv("ai-kg-presets");
    for (const [, preset] of Object.entries(embPresets)) {
      const b = embPresetDiv.createEl("button", { cls: "ai-kg-preset-btn", text: preset.label });
      b.addEventListener("click", () => {
        this.plugin.settings.embeddingEndpoint = preset.endpoint;
        this.plugin.settings.embeddingModel = preset.model;
        this.plugin.saveSettings();
        this.display();
        new Notice(`Embedding 切换到 ${preset.label}`);
      });
    }

    new Setting(containerEl).setName("Embedding Endpoint").addText((t) =>
      t.setPlaceholder("https://api.openai.com/v1").setValue(this.plugin.settings.embeddingEndpoint)
        .onChange(async (v) => { this.plugin.settings.embeddingEndpoint = v; await this.plugin.saveSettings(); })
    );
    new Setting(containerEl).setName("Embedding API Key").addText((t) => {
      t.setPlaceholder("sk-...").setValue(this.plugin.settings.embeddingApiKey)
        .onChange(async (v) => { this.plugin.settings.embeddingApiKey = v; await this.plugin.saveSettings(); });
      t.inputEl.type = "password";
    });
    new Setting(containerEl).setName("Embedding 模型").addText((t) =>
      t.setPlaceholder("text-embedding-3-small").setValue(this.plugin.settings.embeddingModel)
        .onChange(async (v) => { this.plugin.settings.embeddingModel = v; await this.plugin.saveSettings(); })
    );

    // Index info & build
    const indexSize = Object.keys(this.plugin.embeddingIndex.entries).length;
    new Setting(containerEl)
      .setName(`索引状态: ${indexSize} 篇笔记`)
      .setDesc("首次使用需构建索引，后续增量更新")
      .addButton((btn) => btn.setButtonText("构建索引").onClick(() => this.plugin.buildIndex()));

    // ===== Chat API Section =====
    containerEl.createEl("h3", { text: "Chat API（LLM 精排，可选）" });
    containerEl.createEl("p", {
      cls: "ai-kg-section-hint",
      text: "不配置则仅使用 Embedding 相似度排序，配置后由 LLM 从候选中精选并生成关联原因",
    });

    const chatPresets: Record<string, { endpoint: string; model: string; label: string }> = {
      deepseek: { endpoint: "https://api.deepseek.com/v1", model: "deepseek-chat", label: "DeepSeek" },
      openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", label: "OpenAI" },
      zhipu: { endpoint: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", label: "智谱 GLM" },
      ollama: { endpoint: "http://localhost:11434/v1", model: "qwen2.5:7b", label: "Ollama" },
    };
    const chatPresetDiv = containerEl.createDiv("ai-kg-presets");
    for (const [, preset] of Object.entries(chatPresets)) {
      const b = chatPresetDiv.createEl("button", { cls: "ai-kg-preset-btn", text: preset.label });
      b.addEventListener("click", () => {
        this.plugin.settings.chatEndpoint = preset.endpoint;
        this.plugin.settings.chatModel = preset.model;
        this.plugin.saveSettings();
        this.display();
        new Notice(`Chat 切换到 ${preset.label}`);
      });
    }

    new Setting(containerEl).setName("Chat Endpoint").addText((t) =>
      t.setPlaceholder("https://api.openai.com/v1").setValue(this.plugin.settings.chatEndpoint)
        .onChange(async (v) => { this.plugin.settings.chatEndpoint = v; await this.plugin.saveSettings(); })
    );
    new Setting(containerEl).setName("Chat API Key").addText((t) => {
      t.setPlaceholder("留空则仅用 Embedding 排序").setValue(this.plugin.settings.chatApiKey)
        .onChange(async (v) => { this.plugin.settings.chatApiKey = v; await this.plugin.saveSettings(); });
      t.inputEl.type = "password";
    });
    new Setting(containerEl).setName("Chat 模型").addText((t) =>
      t.setPlaceholder("gpt-4o-mini").setValue(this.plugin.settings.chatModel)
        .onChange(async (v) => { this.plugin.settings.chatModel = v; await this.plugin.saveSettings(); })
    );

    // ===== General =====
    containerEl.createEl("h3", { text: "通用设置" });
    new Setting(containerEl).setName("最大关联数").addSlider((s) =>
      s.setLimits(3, 10, 1).setValue(this.plugin.settings.maxResults).setDynamicTooltip()
        .onChange(async (v) => { this.plugin.settings.maxResults = v; await this.plugin.saveSettings(); })
    );
    new Setting(containerEl).setName("候选池大小").setDesc("Embedding 检索的 top N，送入 LLM 精排").addSlider((s) =>
      s.setLimits(5, 50, 5).setValue(this.plugin.settings.topCandidates).setDynamicTooltip()
        .onChange(async (v) => { this.plugin.settings.topCandidates = v; await this.plugin.saveSettings(); })
    );
    new Setting(containerEl).setName("自动分析").addToggle((t) =>
      t.setValue(this.plugin.settings.autoAnalyze).onChange(async (v) => {
        this.plugin.settings.autoAnalyze = v; await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("缓存结果").setDesc("缓存分析结果 24 小时").addToggle((t) =>
      t.setValue(this.plugin.settings.cacheEnabled).onChange(async (v) => {
        this.plugin.settings.cacheEnabled = v; await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("清除所有缓存").setWarning().onClick(async () => {
        this.plugin.resultCache = {};
        this.plugin.embeddingIndex = { version: 1, entries: {} };
        await this.plugin.saveIndex();
        new Notice("缓存和索引已清除");
        this.display();
      })
    );
  }
}
