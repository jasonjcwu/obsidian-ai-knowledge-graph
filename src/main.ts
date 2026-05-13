import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  MarkdownView,
  TFile,
  Notice,
  ItemView,
} from "obsidian";

// ========== Types ==========

interface RelatedNote {
  path: string;
  title: string;
  reason: string;
}

interface PluginSettings {
  apiEndpoint: string;
  apiKey: string;
  model: string;
  maxResults: number;
  autoAnalyze: boolean;
  cacheEnabled: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
  apiEndpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  maxResults: 5,
  autoAnalyze: true,
  cacheEnabled: true,
};

const VIEW_TYPE = "ai-knowledge-graph-view";

// ========== Cache ==========

interface CacheEntry {
  notePath: string;
  results: RelatedNote[];
  timestamp: number;
}

function loadCache(app: App): Record<string, CacheEntry> {
  try {
    const raw = app.vault.read(
      app.vault.getAbstractFileByPath(".obsidian/plugins/ai-knowledge-graph/cache.json")!
    );
    // sync read is fine for small cache
  } catch {
    return {};
  }
  return {};
}

// ========== API ==========

async function callLLM(
  settings: PluginSettings,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const url = settings.apiEndpoint.replace(/\/+$/, "") + "/chat/completions";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ========== View ==========

class KnowledgeGraphView extends ItemView {
  plugin: AIKnowledgeGraphPlugin;
  results: RelatedNote[] = [];
  loading = false;
  currentNotePath = "";

  constructor(leaf: WorkspaceLeaf, plugin: AIKnowledgeGraphPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI 关联";
  }

  getIcon(): string {
    return "git-branch";
  }

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
        <div class="ai-kg-empty-hint">需要先在设置中配置 API Key</div>
      </div>
    `;
  }

  renderLoading(container: HTMLElement, noteName: string) {
    container.empty();
    container.innerHTML = `
      <div class="ai-kg-loading">
        <div class="ai-kg-spinner"></div>
        <div class="ai-kg-loading-text">正在分析「${noteName}」的关联笔记...</div>
      </div>
    `;
  }

  renderError(container: HTMLElement, errorMsg: string) {
    container.empty();
    container.innerHTML = `
      <div class="ai-kg-error">
        <div class="ai-kg-error-icon">⚠️</div>
        <div class="ai-kg-error-msg">${errorMsg}</div>
        <button class="ai-kg-retry-btn">重试</button>
      </div>
    `;
    container.querySelector(".ai-kg-retry-btn")?.addEventListener("click", () => {
      if (this.currentNotePath) {
        this.plugin.analyzeCurrentNote();
      }
    });
  }

  renderResults(container: HTMLElement, noteName: string, results: RelatedNote[]) {
    container.empty();

    // Header
    const header = container.createDiv("ai-kg-header");
    header.innerHTML = `<span class="ai-kg-header-icon">📎</span> ${noteName} 的关联笔记`;

    if (results.length === 0) {
      const empty = container.createDiv("ai-kg-no-results");
      empty.textContent = "没有发现明显的关联笔记";
      return;
    }

    // Results list
    const list = container.createDiv("ai-kg-results");
    for (const r of results) {
      const item = list.createDiv("ai-kg-item");

      // Title row (clickable)
      const titleRow = item.createDiv("ai-kg-item-title");
      const titleLink = titleRow.createEl("a", {
        cls: "ai-kg-link",
        text: r.title,
      });
      titleLink.addEventListener("click", (e) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(r.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });

      // Reason
      const reason = item.createDiv("ai-kg-item-reason");
      reason.textContent = r.reason;

      // Path
      const pathEl = item.createDiv("ai-kg-item-path");
      pathEl.textContent = r.path;
    }

    // Footer
    const footer = container.createDiv("ai-kg-footer");
    const refreshBtn = footer.createEl("button", {
      cls: "ai-kg-refresh-btn",
      text: "🔄 重新分析",
    });
    refreshBtn.addEventListener("click", () => {
      // Clear cache for this note
      delete this.plugin.cache[this.currentNotePath];
      this.plugin.saveCache();
      this.plugin.analyzeCurrentNote();
    });
  }

  updateView(noteName: string, results: RelatedNote[], error?: string) {
    const container = this.containerEl.children[1] as HTMLElement;
    if (error) {
      this.renderError(container, error);
    } else if (results.length === 0) {
      this.renderResults(container, noteName, []);
    } else {
      this.renderResults(container, noteName, results);
    }
  }
}

// ========== Plugin ==========

export default class AIKnowledgeGraphPlugin extends Plugin {
  settings!: PluginSettings;
  view!: KnowledgeGraphView;
  cache: Record<string, CacheEntry> = {};
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async onload() {
    await this.loadSettings();
    this.cache = await this.loadData() ?? {};

    // Register view
    this.registerView(VIEW_TYPE, (leaf) => {
      this.view = new KnowledgeGraphView(leaf, this);
      return this.view;
    });

    // Ribbon icon
    this.addRibbonIcon("git-branch", "AI 关联", () => {
      this.activateView();
    });

    // Command: open view
    this.addCommand({
      id: "open-ai-knowledge-graph",
      name: "打开 AI 关联面板",
      callback: () => this.activateView(),
    });

    // Command: analyze current note
    this.addCommand({
      id: "analyze-current-note",
      name: "分析当前笔记的关联",
      callback: () => this.analyzeCurrentNote(),
    });

    // Auto-analyze on file open
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && this.settings.autoAnalyze) {
          // Debounce to avoid rapid firing during navigation
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.analyzeNote(file);
          }, 500);
        }
      })
    );

    // Settings tab
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
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async analyzeCurrentNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("没有打开的笔记");
      return;
    }
    await this.analyzeNote(file);
  }

  async analyzeNote(file: TFile) {
    if (!this.settings.apiKey) {
      const container = this.view?.containerEl?.children[1] as HTMLElement;
      if (container) {
        this.view.renderError(container, "请先在插件设置中配置 API Key");
      }
      return;
    }

    // Check cache
    const cached = this.cache[file.path];
    if (cached && this.settings.cacheEnabled) {
      const age = Date.now() - cached.timestamp;
      // Cache valid for 24 hours
      if (age < 24 * 60 * 60 * 1000) {
        this.view.currentNotePath = file.path;
        this.view.updateView(file.basename, cached.results);
        return;
      }
    }

    // Ensure view is open
    await this.activateView();

    // Show loading
    this.view.currentNotePath = file.path;
    const container = this.view.containerEl.children[1] as HTMLElement;
    this.view.renderLoading(container, file.basename);

    try {
      // Read current note
      const content = await this.app.vault.read(file);

      // Build candidate list (all other markdown files, title + first 150 chars)
      const files = this.app.vault.getMarkdownFiles();
      const candidates: string[] = [];
      for (const f of files) {
        if (f.path === file.path) continue;
        // Read first 150 chars as summary
        let summary = "";
        try {
          const raw = await this.app.vault.read(f);
          summary = raw.slice(0, 150).replace(/\n/g, " ").trim();
        } catch {
          summary = "";
        }
        candidates.push(`- ${f.basename} (${f.path}): ${summary}`);
      }

      // Truncate candidates to fit in prompt (rough estimate: ~4 chars per token)
      const maxCandidateChars = 8000;
      let candidateText = "";
      for (const c of candidates) {
        if ((candidateText + c).length > maxCandidateChars) break;
        candidateText += c + "\n";
      }

      const systemPrompt = `You are a knowledge graph assistant. Given a note and a list of candidate notes, find the most semantically related ones.

IMPORTANT: You MUST respond with ONLY valid JSON, no markdown, no code fences, no explanation outside JSON.

Return a JSON array. Each element has:
- "path": the exact file path from the input (in parentheses)
- "title": the note title
- "reason": a brief explanation in Chinese (1 sentence) of WHY this note is related

Return at most ${this.settings.maxResults} results. Only include notes that are genuinely related by topic, concept, or theme.`;

      const userPrompt = `Current note: "${file.basename}"
Path: ${file.path}
Content:
${content.slice(0, 3000)}

---
Candidate notes:
${candidateText}

Find the most related notes. Respond with JSON array only.`;

      const response = await callLLM(this.settings, systemPrompt, userPrompt);

      // Parse response
      let results: RelatedNote[] = [];
      try {
        // Try to extract JSON from response (handle markdown code fences)
        let jsonStr = response.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (fenceMatch) {
          jsonStr = fenceMatch[1].trim();
        }
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          results = parsed.slice(0, this.settings.maxResults);
        }
      } catch (e) {
        console.error("Failed to parse LLM response:", e, response);
        this.view.updateView(file.basename, [], `解析结果失败: ${(e as Error).message}`);
        return;
      }

      // Cache results
      this.cache[file.path] = {
        notePath: file.path,
        results,
        timestamp: Date.now(),
      };
      await this.saveCache();

      this.view.updateView(file.basename, results);
    } catch (e) {
      console.error("Analysis failed:", e);
      this.view.updateView(file.basename, [], `分析失败: ${(e as Error).message}`);
    }
  }

  async saveCache() {
    await this.saveData(this.cache);
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

    // Preset buttons
    new Setting(containerEl).setName("快速配置").setHeading();
    const presetDiv = containerEl.createDiv("ai-kg-presets");

    const presets: Record<string, { endpoint: string; model: string; label: string }> = {
      deepseek: {
        endpoint: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        label: "DeepSeek",
      },
      zhipu: {
        endpoint: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-4-flash",
        label: "智谱 GLM",
      },
      openai: {
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        label: "OpenAI",
      },
      ollama: {
        endpoint: "http://localhost:11434/v1",
        model: "qwen2.5:7b",
        label: "Ollama (本地)",
      },
    };

    for (const [key, preset] of Object.entries(presets)) {
      const btn = presetDiv.createEl("button", {
        cls: "ai-kg-preset-btn",
        text: preset.label,
      });
      btn.addEventListener("click", () => {
        this.plugin.settings.apiEndpoint = preset.endpoint;
        this.plugin.settings.model = preset.model;
        this.plugin.saveSettings();
        this.display(); // refresh
        new Notice(`已切换到 ${preset.label}`);
      });
    }

    // API Endpoint
    new Setting(containerEl)
      .setName("API Endpoint")
      .setDesc("OpenAI 兼容接口地址")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.apiEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.apiEndpoint = value;
            await this.plugin.saveSettings();
          })
      );

    // API Key
    new Setting(containerEl)
      .setName("API Key")
      .setDesc("你的 API 密钥（本地存储，不会外传）")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    // Model
    new Setting(containerEl)
      .setName("模型")
      .setDesc("使用的 LLM 模型名称")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    // Max results
    new Setting(containerEl)
      .setName("最大关联数")
      .setDesc("每次分析返回的最大关联笔记数")
      .addSlider((slider) =>
        slider
          .setLimits(3, 10, 1)
          .setValue(this.plugin.settings.maxResults)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxResults = value;
            await this.plugin.saveSettings();
          })
      );

    // Auto analyze
    new Setting(containerEl)
      .setName("自动分析")
      .setDesc("打开笔记时自动查找关联（关闭后需手动触发）")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoAnalyze).onChange(async (value) => {
          this.plugin.settings.autoAnalyze = value;
          await this.plugin.saveSettings();
        })
      );

    // Cache
    new Setting(containerEl)
      .setName("缓存结果")
      .setDesc("缓存分析结果 24 小时，避免重复调用 API")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.cacheEnabled).onChange(async (value) => {
          this.plugin.settings.cacheEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    // Clear cache
    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("清除缓存")
        .setWarning()
        .onClick(async () => {
          this.plugin.cache = {};
          await this.plugin.saveCache();
          new Notice("缓存已清除");
        })
    );
  }
}
